/**
 * resolvectl — le client de systemd-resolved.
 *
 * `query` résout par le MÊME chemin que le système : c'est ce qui garantit
 * qu'il ne puisse pas répondre autre chose que `getent hosts` sur la même
 * machine au même instant (`docs/PRD-resolvectl.md` §3).
 */

import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';
import {
  STUB_ADDRESS,
  type ResolvedLinkConfig,
  type ResolvedService,
} from '../../net/ResolvedService';

const CONFIG_VERBS = new Set([
  'dns', 'domain', 'default-route', 'llmnr', 'mdns', 'dnssec', 'dnsovertls', 'nta', 'revert',
]);
const ADMIN_VERBS = new Set([...CONFIG_VERBS, 'flush-caches', 'reset-statistics']);
const KNOWN_VERBS = new Set([
  'status', 'query', 'statistics', 'show-cache', ...ADMIN_VERBS,
]);

interface Parsed {
  verb: string;
  unknownVerb: string | null;
  args: string[];
  help: boolean;
  version: boolean;
  legend: boolean;
}

function parseArgs(argv: readonly string[]): Parsed {
  const out: Parsed = {
    verb: '', unknownVerb: null, args: [], help: false, version: false, legend: true,
  };
  for (const a of argv) {
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (a === '--version') { out.version = true; continue; }
    if (a === '--no-legend') { out.legend = false; continue; }
    if (a === '--no-pager' || a === '-4' || a === '-6') continue;
    // `systemd-resolve --status` / `--flush-caches` : la forme héritée
    // passe le verbe en option longue.
    if (a === '--status') { out.verb = 'status'; continue; }
    if (a === '--flush-caches') { out.verb = 'flush-caches'; continue; }
    if (a === '--statistics') { out.verb = 'statistics'; continue; }
    if (a.startsWith('-')) continue;
    if (!out.verb && out.unknownVerb === null) {
      if (KNOWN_VERBS.has(a)) out.verb = a;
      else out.unknownVerb = a;
      continue;
    }
    out.args.push(a);
  }
  if (!out.verb && out.unknownVerb === null) out.verb = 'status';
  return out;
}

function resolvedOf(ctx: LinuxCommandContext) {
  return ctx.net.getResolvedService();
}

/**
 * `status` montre le réglage *effectif*, pas ce qui est stocké : un lien
 * qui n'a rien de posé hérite du global, et c'est cette valeur-là qui
 * gouverne la résolution.
 */
function protocolLines(svc: ResolvedService, link: string | null): string[] {
  return [
    `       LLMNR setting: ${svc.llmnrFor(link)}`,
    `MulticastDNS setting: ${svc.mdnsFor(link)}`,
    `  DNSOverTLS setting: ${svc.dnsOverTlsModeFor(link)}`,
    `      DNSSEC setting: ${svc.dnssecModeFor(link)}`,
  ];
}

/** Quel mode `/etc/resolv.conf` porte — premier diagnostic d'un admin. */
function resolvConfMode(ctx: LinuxCommandContext): string {
  const text = ctx.executor.vfs.readFile('/etc/resolv.conf') ?? '';
  if (text.includes(STUB_ADDRESS)) return 'stub';
  if (/managed by systemd-networkd/i.test(text)) return 'static';
  if (text.trim() === '') return 'uplink';
  return 'foreign';
}

function renderStatus(ctx: LinuxCommandContext, cible: string | undefined, legend: boolean): string {
  const svc = resolvedOf(ctx);
  const global = svc.getGlobal();
  const lines: string[] = [];

  if (!cible) {
    lines.push('Global');
    lines.push(...protocolLines(svc, null));
    lines.push(`resolv.conf mode: ${resolvConfMode(ctx)}`);
    if (global.dnsServers.length) {
      lines.push(`  Current DNS Server: ${global.dnsServers[0]}`);
      lines.push(`         DNS Servers: ${global.dnsServers.join(' ')}`);
    }
    if (global.fallbackDns.length) lines.push(`Fallback DNS Servers: ${global.fallbackDns.join(' ')}`);
    if (global.domains.length) lines.push(`      DNS Domain: ${global.domains.join(' ')}`);
  }

  const names = cible
    ? [cible]
    : [...ctx.net.getPorts().keys()];
  for (const iface of names) {
    if (!ctx.net.getPorts().has(iface)) {
      return `Failed to resolve interface "${iface}".`;
    }
    const cfg: ResolvedLinkConfig = svc.linkConfig(iface);
    if (!cible && cfg.dnsServers.length === 0 && cfg.domains.length === 0) continue;
    if (lines.length) lines.push('');
    lines.push(`Link ${ctx.net.getIfIndex(iface)} (${iface})`);
    lines.push(...protocolLines(svc, iface));
    if (cfg.dnsServers.length) {
      lines.push(`  Current DNS Server: ${cfg.dnsServers[0]}`);
      lines.push(`         DNS Servers: ${cfg.dnsServers.join(' ')}`);
    }
    if (cfg.domains.length) lines.push(`          DNS Domain: ${cfg.domains.join(' ')}`);
    if (cfg.negativeTrustAnchors.length) {
      lines.push(`          DNSSEC NTA: ${cfg.negativeTrustAnchors.join(' ')}`);
    }
    if (cfg.defaultRoute) lines.push('       Default Route: yes');
  }

  if (!legend) return lines.filter((l) => l.trim()).join('\n');
  return lines.join('\n');
}

async function renderQuery(
  ctx: LinuxCommandContext, cibles: string[],
): Promise<{ output: string; exitCode: number }> {
  if (cibles.length === 0) {
    return { output: 'resolvectl: query requires at least one name', exitCode: 1 };
  }
  const out: string[] = [];
  let exitCode = 0;
  for (const nom of cibles) {
    const r = await resolvedOf(ctx).resolve(nom);
    if (r.addresses.length === 0) {
      // Une réponse écartée par DNSSEC ne se confond pas avec un nom
      // inconnu : l'opérateur doit savoir qu'il y avait une réponse et
      // qu'elle a été refusée.
      if (r.refusedBecause === 'bogus') {
        out.push(`${nom}: Failed to resolve: DNSSEC validation failed`);
      } else if (r.refusedBecause === 'unsigned-but-required') {
        out.push(`${nom}: Failed to resolve: no signed data and DNSSEC=yes`);
      } else if (r.refusedBecause === 'no-encrypted-transport') {
        // DNSOverTLS=yes ne retombe jamais sur le clair : sans 853 en
        // face, la requête échoue. C'est le mot de systemd pour ce cas.
        out.push(`${nom}: resolve call failed: All attempts to contact name servers or networks failed`);
      } else {
        out.push(`${nom}: Name or service not known`);
      }
      exitCode = 1;
      continue;
    }
    for (const addr of r.addresses) {
      out.push(r.link ? `${nom}: ${addr} -- link: ${r.link}` : `${nom}: ${addr}`);
    }
    out.push('');
    out.push(`-- Information acquired via protocol DNS in 0us.`);
    out.push(
      `-- Data is authenticated: ${r.dnssec === 'secure' ? 'yes' : 'no'}; `
      + `Data was acquired via local or encrypted transport: ${r.encrypted ? 'yes' : 'no'}`,
    );
    out.push(`-- Data from: ${r.origin === 'cache' ? 'cache' : 'network'}`);
  }
  return { output: out.join('\n'), exitCode };
}

function renderStatistics(ctx: LinuxCommandContext): string {
  const s = resolvedOf(ctx).statistics();
  return [
    `DNSSEC supported by current servers: ${s.secureTransactions > 0 ? 'yes' : 'no'}`,
    '',
    'Transactions',
    `Current Transactions: 0`,
    `  Total Transactions: ${s.transactions}`,
    '',
    'Cache',
    `  Current Cache Size: ${s.currentCacheSize}`,
    `          Cache Hits: ${s.cacheHits}`,
    `        Cache Misses: ${s.cacheMisses}`,
    '',
    'Failure Transactions',
    `  Total Transactions: ${s.failedTransactions}`,
    '',
    'DNSSEC Verdicts',
    `              Secure: ${s.secureTransactions}`,
  ].join('\n');
}

function runConfigVerb(ctx: LinuxCommandContext, verb: string, args: string[]): { output: string; exitCode: number } {
  const iface = args[0];
  if (!iface) return { output: `resolvectl: ${verb} requires a link`, exitCode: 1 };
  if (!ctx.net.getPorts().has(iface)) {
    return { output: `Failed to resolve interface "${iface}".`, exitCode: 1 };
  }
  const svc = resolvedOf(ctx);
  const cfg = svc.linkConfig(iface);
  const rest = args.slice(1);

  switch (verb) {
    case 'dns': cfg.dnsServers = [...rest]; break;
    case 'domain': cfg.domains = [...rest]; break;
    case 'default-route': cfg.defaultRoute = /^(yes|true|1)$/i.test(rest[0] ?? 'yes'); break;
    // Une valeur absente remet le réglage à « non posé » : le lien suit
    // alors le global, comme `resolvectl dnssec <lien> ""` chez systemd.
    case 'llmnr': cfg.llmnr = (rest[0] as ResolvedLinkConfig['llmnr']) || null; break;
    case 'mdns': cfg.mdns = (rest[0] as ResolvedLinkConfig['mdns']) || null; break;
    case 'dnssec': cfg.dnssec = (rest[0] as ResolvedLinkConfig['dnssec']) || null; break;
    case 'dnsovertls': cfg.dnsOverTls = (rest[0] as ResolvedLinkConfig['dnsOverTls']) || null; break;
    case 'revert': svc.revertLink(iface); break;
    case 'nta': cfg.negativeTrustAnchors = [...rest]; break;
  }
  ctx.net.publishResolvedState();
  return { output: '', exitCode: 0 };
}

const OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-4', description: 'Resolve IPv4 addresses' },
  { flag: '-6', description: 'Resolve IPv6 addresses' },
  { flag: '--no-legend', description: 'Do not show the headers and footers' },
  { flag: '--no-pager', description: 'Do not pipe output into a pager' },
  { flag: '--version', description: 'Show package version' },
  { flag: '-h', description: 'Show this help', aliases: ['--help'] },
];

const HELP = `resolvectl [OPTIONS...] COMMAND [NAME...]

Send control commands to the network name resolution manager, or
resolve domain names, IPv4 and IPv6 addresses.

Commands:
  query HOSTNAME|ADDRESS...    Resolve domain names or addresses
  status [LINK...]             Show link and global DNS settings
  statistics                   Show resolver statistics
  reset-statistics             Reset resolver statistics
  flush-caches                 Flush all local DNS caches
  show-cache                   Show cache contents
  dns [LINK [SERVER...]]       Get/set per-interface DNS servers
  domain [LINK [DOMAIN...]]    Get/set per-interface search domains
  default-route [LINK [BOOL]]  Get/set per-interface default route flag
  llmnr [LINK [MODE]]          Get/set per-interface LLMNR mode
  mdns [LINK [MODE]]           Get/set per-interface MulticastDNS mode
  dnssec [LINK [MODE]]         Get/set per-interface DNSSEC mode
  dnsovertls [LINK [MODE]]     Get/set per-interface DNS-over-TLS mode
  nta [LINK [DOMAIN...]]       Get/set per-interface DNSSEC NTA
  revert LINK                  Revert per-interface configuration`;

async function execute(
  ctx: LinuxCommandContext, argv: string[],
): Promise<{ output: string; exitCode: number }> {
  const opts = parseArgs(argv);
  if (opts.help) return { output: HELP, exitCode: 0 };
  if (opts.version) return { output: 'systemd 249 (249.11-0ubuntu3)', exitCode: 0 };
  if (opts.unknownVerb !== null) {
    return { output: `Unknown command verb '${opts.unknownVerb}'.`, exitCode: 1 };
  }

  const svc = resolvedOf(ctx);
  switch (opts.verb) {
    case 'query':
      return await renderQuery(ctx, opts.args);
    case 'statistics':
      return { output: renderStatistics(ctx), exitCode: 0 };
    case 'reset-statistics':
      svc.resetStatistics();
      return { output: '', exitCode: 0 };
    case 'flush-caches':
      svc.flushCaches();
      return { output: '', exitCode: 0 };
    case 'show-cache':
      return { output: `Cache holds ${svc.statistics().currentCacheSize} entries.`, exitCode: 0 };
    case 'status':
      return { output: renderStatus(ctx, opts.args[0], opts.legend), exitCode: 0 };
    default:
      if (CONFIG_VERBS.has(opts.verb)) return runConfigVerb(ctx, opts.verb, opts.args);
      return { output: `Unknown command verb '${opts.verb}'.`, exitCode: 1 };
  }
}

export const resolvectlCommand: LinuxCommand = {
  name: 'resolvectl',
  aliases: ['systemd-resolve'],
  needsNetworkContext: true,
  usage: 'resolvectl [OPTIONS...] { status | query | statistics | flush-caches | dns | domain | revert }',
  help: HELP,
  options: OPTIONS,
  privilege: {
    appliesWhen: (args) => args.some((a) => ADMIN_VERBS.has(a)),
    satisfiedBy: Satisfy.root,
  },
  async run(ctx, args) { return (await execute(ctx, args)).output; },
  async runWithStatus(ctx, args) { return execute(ctx, args); },
};
