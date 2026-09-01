/**
 * networkctl — le client de systemd-networkd.
 *
 * C'est un outil de diagnostic avant d'être un outil de configuration :
 * ce qu'il affiche doit être constaté sur le lien, jamais recopié depuis
 * un fichier déclaré ni depuis un gabarit. Tout l'état vient de
 * `LinkState`, dérivé du même `Port` que `ip link`, de sorte que les deux
 * commandes ne puissent pas se contredire (`docs/PRD-networkctl.md`).
 */

import type { LinuxCommand, LinuxCommandOption } from '../LinuxCommand';
import type { LinuxCommandContext } from '../LinuxCommandContext';
import { Satisfy } from '../../iam/policy/CommandPrivilegePolicy';
import {
  lldpCapabilityMask, lldpCapabilityLegend, type LldpCapability,
} from '@/network/lldp/types';
import {
  aggregateOnlineState,
  aggregateOperationalState,
  deriveLinkStates,
  matchesPattern,
  type LinkState,
  type LinkStateDeps,
} from '../../net/LinkState';

const ACTION_VERBS = new Set([
  'up', 'down', 'renew', 'forcerenew', 'reconfigure', 'reload', 'delete',
]);

const KNOWN_VERBS = new Set([
  'list', 'status', 'lldp', 'label', 'cat', 'edit', ...ACTION_VERBS,
]);

interface ParsedArgs {
  verb: string;
  /** Premier argument positionnel quand ce n'est pas un verbe connu. */
  unknownVerb: string | null;
  patterns: string[];
  all: boolean;
  legend: boolean;
  stats: boolean;
  full: boolean;
  help: boolean;
  version: boolean;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const out: ParsedArgs = {
    verb: '', unknownVerb: null, patterns: [], all: false, legend: true,
    stats: false, full: false, help: false, version: false,
  };
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--version') { out.version = true; continue; }
    if (arg === '--no-legend') { out.legend = false; continue; }
    if (arg === '--no-pager') continue;
    if (arg === '-a' || arg === '--all') { out.all = true; continue; }
    if (arg === '-s' || arg === '--stats') { out.stats = true; continue; }
    if (arg === '-l' || arg === '--full') { out.full = true; continue; }
    if (arg.startsWith('-n') || arg.startsWith('--lines')) continue;
    if (arg.startsWith('-')) continue;
    if (!out.verb && out.unknownVerb === null) {
      // Le premier argument positionnel est toujours lu comme un verbe :
      // `networkctl eth0` n'est pas un raccourci de `list eth0`, systemd
      // le refuse aussi.
      if (KNOWN_VERBS.has(arg)) out.verb = arg;
      else out.unknownVerb = arg;
      continue;
    }
    out.patterns.push(arg);
  }
  // « If no command is specified, list is implied » — networkctl(1).
  if (!out.verb) out.verb = 'list';
  return out;
}

function buildDeps(ctx: LinuxCommandContext): LinkStateDeps {
  return {
    net: ctx.net,
    netplan: ctx.netConfig.readNetplan(),
    isManagedByNetworkManager: (iface) => ctx.netConfig.isManagedByNetworkManager(iface),
    resolvConf: ctx.executor.vfs.readFile('/etc/resolv.conf'),
    resolveFiles: (iface) => ctx.netConfig.resolveNetworkdFiles(iface),
    networkdActive: ctx.executor.serviceMgr.isActive('systemd-networkd'),
    governedByNetworkd: (iface) => ctx.netConfig.isGovernedByNetworkd(iface),
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function renderList(links: readonly LinkState[], opts: ParsedArgs): string {
  const rows = links.map((l) => [
    String(l.index), l.name, l.type, l.operational, l.setup,
  ]);
  const headers = ['IDX', 'LINK', 'TYPE', 'OPERATIONAL', 'SETUP'];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)));

  const lines: string[] = [];
  if (opts.legend) {
    lines.push(headers.map((h, i) => pad(h, widths[i])).join(' ').trimEnd());
  }
  for (const row of rows) {
    lines.push(row.map((c, i) => pad(c, widths[i])).join(' ').trimEnd());
  }
  if (opts.legend) {
    lines.push('');
    lines.push(`${links.length} links listed.`);
  }
  return lines.join('\n');
}

function field(label: string, value: string): string {
  return `${label.padStart(16)}: ${value}`;
}

function renderLinkStatus(link: LinkState, ctx: LinuxCommandContext): string {
  const lines = [`● ${link.index}: ${link.name}`];
  lines.push(field('Link File', link.linkFile ?? 'n/a'));
  lines.push(field('Network File', link.networkFile ?? 'n/a'));
  lines.push(field('Type', link.type));
  lines.push(field('State', `${link.operational} (${link.setup})`));
  lines.push(field('Online state', link.online));
  if (link.hardwareAddress) lines.push(field('Hardware Address', link.hardwareAddress));
  lines.push(field('MTU', String(link.mtu)));
  if (link.addressSource) lines.push(field('Address Source', link.addressSource));
  for (const [i, addr] of link.addresses.entries()) {
    lines.push(field(i === 0 ? 'Address' : '', addr));
  }
  if (link.gateway) lines.push(field('Gateway', link.gateway));
  if (link.dns.length) lines.push(field('DNS', link.dns.join(' ')));

  // Conservé mot pour mot : la détection de conflit networkd/NetworkManager
  // est déjà juste et couverte par linux-network-config-drift.
  const netplan = ctx.netConfig.readNetplan();
  if (netplan?.renderer === 'networkd' && link.managedByNetworkManager) {
    lines.push(field('Warning', 'also managed by NetworkManager (conflicting configuration)'));
  }
  return lines.join('\n');
}

function renderGlobalStatus(links: readonly LinkState[], ctx: LinuxCommandContext): string {
  const managed = links.filter((l) => l.setup !== 'unmanaged');
  const addresses = [...new Set(managed.flatMap((l) => l.addresses))];
  const gateways = [...new Set(managed.map((l) => l.gateway).filter((g): g is string => !!g))];
  const dns = [...new Set(managed.flatMap((l) => l.dns))];

  const lines = ['●   State: ' + aggregateOperationalState(links)];
  lines.push(field('Online state', aggregateOnlineState(links)));
  const hostname = ctx.executor.vfs.readFile('/etc/hostname')?.trim();
  if (hostname) lines.push(field('Hostname', hostname));
  for (const [i, addr] of addresses.entries()) {
    lines.push(field(i === 0 ? 'Address' : '', addr));
  }
  for (const [i, gw] of gateways.entries()) {
    lines.push(field(i === 0 ? 'Gateway' : '', gw));
  }
  if (dns.length) lines.push(field('DNS', dns.join(' ')));
  return lines.join('\n');
}

function selectLinks(ctx: LinuxCommandContext, patterns: string[]): {
  links: LinkState[]; missing: string[];
} {
  const all = deriveLinkStates(buildDeps(ctx));
  if (patterns.length === 0) return { links: all, missing: [] };
  const links = all.filter((l) => matchesPattern(l.name, patterns));
  const literal = patterns.filter((p) => !/[*?]/.test(p));
  const missing = literal.filter((p) => !all.some((l) => l.name === p));
  return { links, missing };
}

function renderLldp(links: readonly LinkState[], ctx: LinuxCommandContext, opts: ParsedArgs): string {
  const rows: string[][] = [];
  const seen: LldpCapability[] = [];
  for (const link of links) {
    if (link.type === 'loopback') continue;
    for (const n of ctx.net.getLldpNeighbors(link.name)) {
      const caps = n.remoteCapabilities ?? [];
      seen.push(...caps);
      rows.push([
        link.name,
        n.chassisId,
        n.systemName || '-',
        lldpCapabilityMask(caps),
        n.portId,
        n.portDescription || '-',
      ]);
    }
  }
  const headers = ['LINK', 'CHASSIS ID', 'SYSTEM NAME', 'CAPS', 'PORT ID', 'PORT DESCRIPTION'];
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length), 0));
  const lines: string[] = [];
  if (opts.legend) lines.push(headers.map((h, i) => pad(h, widths[i])).join(' ').trimEnd());
  for (const row of rows) lines.push(row.map((c, i) => pad(c, widths[i])).join(' ').trimEnd());
  if (opts.legend) {
    const legend = lldpCapabilityLegend(seen);
    if (legend.length > 0) {
      lines.push('', 'Capability Flags:', legend.join('; '));
    }
    lines.push('');
    lines.push(`${rows.length} neighbors listed.`);
  }
  return lines.join('\n');
}

function runActionVerb(
  ctx: LinuxCommandContext, verb: string, patterns: string[],
): { output: string; exitCode: number } {
  if (verb === 'reload') {
    // Relit les fichiers natifs comme le vrai `networkctl reload`, pas
    // seulement le netplan (`docs/PRD-networkd.md` écart #5).
    const native = ctx.netConfig.applyNetworkd(ctx.net);
    const { warnings } = ctx.netConfig.applyNetplan(ctx.net, native.governed);
    return { output: warnings.join('\n'), exitCode: 0 };
  }
  if (patterns.length === 0) {
    return { output: `networkctl: ${verb} requires at least one device`, exitCode: 1 };
  }

  const out: string[] = [];
  let exitCode = 0;
  for (const name of patterns) {
    if (!ctx.net.getPorts().has(name)) {
      out.push(`Cannot find device '${name}'.`);
      exitCode = 1;
      continue;
    }
    switch (verb) {
      case 'up':
        ctx.net.setInterfaceAdmin(name, true);
        break;
      case 'down':
        ctx.net.setInterfaceAdmin(name, false);
        break;
      case 'renew':
      case 'forcerenew': {
        if (verb === 'forcerenew') ctx.net.getDhcpClient().releaseLease(name);
        const reply = ctx.net.getDhcpClient().requestLease(name, {});
        if (typeof reply === 'string' && reply.trim()) out.push(reply.trim());
        break;
      }
      case 'reconfigure':
        ctx.netConfig.reconfigureInterface(ctx.net, name);
        break;
      case 'delete':
        // Un lien physique ne se supprime pas — le vrai networkd refuse
        // aussi, et l'ignorer laisserait croire à une suppression.
        if (!ctx.linkOps?.deleteLink) {
          out.push(`Cannot remove '${name}': Operation not supported`);
          exitCode = 1;
          break;
        }
        out.push(ctx.linkOps.deleteLink(name));
        break;
    }
  }
  return { output: out.join('\n'), exitCode };
}

const OPTIONS: readonly LinuxCommandOption[] = [
  { flag: '-a', description: 'Show status for all links', aliases: ['--all'] },
  { flag: '-l', description: 'Do not ellipsize output', aliases: ['--full'] },
  { flag: '-s', description: 'Show link statistics', aliases: ['--stats'] },
  { flag: '--no-legend', description: 'Do not show the headers and footers' },
  { flag: '--no-pager', description: 'Do not pipe output into a pager' },
  { flag: '--version', description: 'Show package version' },
  { flag: '-h', description: 'Show this help', aliases: ['--help'] },
];

const HELP = `networkctl [OPTIONS...] COMMAND

Query and control the networking subsystem.

Commands:
  list [PATTERN...]           List links
  status [PATTERN...]         Show link status
  lldp [PATTERN...]           Show LLDP neighbors
  label                       Show current address label entries
  up DEVICES...               Bring devices up
  down DEVICES...             Bring devices down
  renew DEVICES...            Renew dynamic configuration
  forcerenew DEVICES...       Trigger DHCP reconfiguration of all connected clients
  reconfigure DEVICES...      Reconfigure interfaces
  reload                      Reload .network and .netdev files
  cat [PATTERN...]            Show network configuration files
  edit FILES|DEVICES...       Edit network configuration files
  delete DEVICES...           Delete virtual netdevs`;

export const networkctlCommand: LinuxCommand = {
  name: 'networkctl',
  needsNetworkContext: true,
  usage: 'networkctl [OPTIONS...] { list | status | lldp | label | up | down | renew | reconfigure | reload | cat | edit | delete }',
  help: HELP,
  options: OPTIONS,
  privilege: {
    appliesWhen: (args) => args.some((a) => ACTION_VERBS.has(a)),
    satisfiedBy: Satisfy.root,
  },
  run(ctx: LinuxCommandContext, args: string[]): string {
    return execute(ctx, args).output;
  },
  async runWithStatus(ctx: LinuxCommandContext, args: string[]) {
    return execute(ctx, args);
  },
};

function execute(ctx: LinuxCommandContext, args: string[]): { output: string; exitCode: number } {
  {
    const opts = parseArgs(args);

    if (opts.help) return { output: HELP, exitCode: 0 };
    if (opts.version) return { output: 'systemd 249 (249.11-0ubuntu3)', exitCode: 0 };
    if (opts.unknownVerb !== null) {
      return { output: `Unknown command verb '${opts.unknownVerb}'.`, exitCode: 1 };
    }

    if (ACTION_VERBS.has(opts.verb)) {
      return runActionVerb(ctx, opts.verb, opts.patterns);
    }

    if (opts.verb === 'label') {
      return { output: ctx.netConfig.addressLabelTable(), exitCode: 0 };
    }

    if (opts.verb === 'cat' || opts.verb === 'edit') {
      return ctx.netConfig.networkdFileAction(ctx.net, opts.verb, opts.patterns);
    }

    const { links, missing } = selectLinks(ctx, opts.patterns);
    if (missing.length) {
      return {
        output: missing.map((m) => `Cannot find device '${m}'.`).join('\n'),
        exitCode: 1,
      };
    }

    if (opts.verb === 'lldp') {
      return { output: renderLldp(links, ctx, opts), exitCode: 0 };
    }

    if (opts.verb === 'status') {
      // Sans cible, `status` décrit le gestionnaire, pas chaque lien :
      // c'est `-a` qui demande le détail de tous les liens.
      if (opts.patterns.length === 0 && !opts.all) {
        return { output: renderGlobalStatus(links, ctx), exitCode: 0 };
      }
      return {
        output: links.map((l) => renderLinkStatus(l, ctx)).join('\n\n'),
        exitCode: 0,
      };
    }

    return { output: renderList(links, opts), exitCode: 0 };
  }
}
