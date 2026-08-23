/**
 * CiscoDhcpCommands - Extracted DHCP command registration for Cisco IOS CLI
 *
 * Handles:
 *   - DHCP pool configuration mode (dhcp-config)#
 *   - DHCP show commands (show ip dhcp pool/binding/statistics/conflict/excluded-address)
 *   - DHCP debug/clear commands (privileged mode)
 */

import type { Router } from '../../Router';
import { CommandTrie } from '../CommandTrie';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';
import type { CiscoShellContext } from './CiscoConfigCommands';
import { getGlobalConfig } from '../../router/config/CiscoGlobalConfig';

const INVALID_INPUT = "% Invalid input detected at '^' marker.";

/**
 * IOS takes up to eight addresses on `default-router` and `dns-server`, and
 * each one has to be a usable host address: a mask, a multicast group, the
 * all-ones broadcast or anything out of 240.0.0.0/4 is refused at the
 * parser, not silently kept or silently dropped.
 */
function parseAddressList(args: string[]): string[] | null {
  if (args.length < 1 || args.length > 8) return null;
  for (const a of args) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
    if (!m) return null;
    const o = m.slice(1).map(Number);
    if (o.some(n => n > 255)) return null;
    if (o[0] === 0 || o[0] >= 224) return null;
  }
  return args;
}

// ─── DHCP Pool Config Mode Commands ──────────────────────────────────

export function buildConfigDhcpCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('network', 'Define DHCP pool network', (args) => {
    if (args.length < 2) return '% Incomplete command.';
    if (!ctx.getSelectedDHCPPool()) return '% No DHCP pool selected';
    ctx.r()._getDHCPServerInternal().configurePoolNetwork(ctx.getSelectedDHCPPool()!, args[0], args[1]);
    return '';
  });

  trie.registerGreedy('default-router', 'Set default router for DHCP clients', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!ctx.getSelectedDHCPPool()) return '% No DHCP pool selected';
    const routers = parseAddressList(args);
    if (!routers) return INVALID_INPUT;
    ctx.r()._getDHCPServerInternal().configurePoolRouter(ctx.getSelectedDHCPPool()!, routers);
    return '';
  });

  trie.registerGreedy('dns-server', 'Set DNS server for DHCP clients', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!ctx.getSelectedDHCPPool()) return '% No DHCP pool selected';
    const servers = parseAddressList(args);
    if (!servers) return INVALID_INPUT;
    ctx.r()._getDHCPServerInternal().configurePoolDNS(ctx.getSelectedDHCPPool()!, servers);
    return '';
  });

  trie.registerGreedy('domain-name', 'Set domain name for DHCP clients', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!ctx.getSelectedDHCPPool()) return '% No DHCP pool selected';
    ctx.r()._getDHCPServerInternal().configurePoolDomain(ctx.getSelectedDHCPPool()!, args[0]);
    return '';
  });

  trie.registerGreedy('lease', 'Set DHCP lease duration', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const pool = ctx.getSelectedDHCPPool();
    if (!pool) return '% No DHCP pool selected';
    if (args[0]?.toLowerCase() === 'infinite') {
      ctx.r()._getDHCPServerInternal().configurePoolLeaseInfinite(pool);
      return '';
    }
    const leaseArgs = args.map(Number);
    let seconds = 0;
    if (leaseArgs.length >= 1) seconds += leaseArgs[0] * 86400; // days
    if (leaseArgs.length >= 2) seconds += leaseArgs[1] * 3600;  // hours
    if (leaseArgs.length >= 3) seconds += leaseArgs[2];          // seconds
    if (seconds === 0) seconds = 86400; // default 1 day
    ctx.r()._getDHCPServerInternal().configurePoolLease(ctx.getSelectedDHCPPool()!, seconds);
    return '';
  });

  trie.registerGreedy('client-identifier deny', 'Deny DHCP by client identifier', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!ctx.getSelectedDHCPPool()) return '% No DHCP pool selected';
    ctx.r()._getDHCPServerInternal().addDenyPattern(ctx.getSelectedDHCPPool()!, args[0]);
    return '';
  });

  // ── Pool sub-options → real DHCPServer pool state ──
  const dhcp = () => ctx.r()._getDHCPServerInternal();
  const pool = () => ctx.getSelectedDHCPPool();

  trie.registerGreedy('next-server', 'Set boot/next server', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!pool()) return '% No DHCP pool selected';
    dhcp().configurePoolNextServer(pool()!, args[0]);
    return '';
  });
  trie.registerGreedy('bootfile', 'Set boot filename', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!pool()) return '% No DHCP pool selected';
    dhcp().configurePoolBootfile(pool()!, args[0]);
    return '';
  });
  trie.registerGreedy('netbios-name-server', 'Set NetBIOS name server(s)', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!pool()) return '% No DHCP pool selected';
    dhcp().configurePoolNetbios(pool()!, args);
    return '';
  });
  trie.registerGreedy('netbios-node-type', 'Set NetBIOS node type', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!pool()) return '% No DHCP pool selected';
    dhcp().configurePoolNetbiosNodeType(pool()!, args[0]);
    return '';
  });
  trie.registerGreedy('option', 'Set a raw DHCP option', (args) => {
    // option <code> {ip|ascii|hex} <value…>
    if (args.length < 3) return '% Incomplete command.';
    if (!pool()) return '% No DHCP pool selected';
    const code = parseInt(args[0], 10);
    const kind = args[1] === 'ascii' ? 'ascii' : args[1] === 'hex' ? 'hex' : 'ip';
    dhcp().configurePoolOption(pool()!, code, kind, args.slice(2).join(' '));
    return '';
  });
  trie.registerGreedy('host', 'Manual binding host address', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!pool()) return '% No DHCP pool selected';
    const result = dhcp().configurePoolManual(pool()!, 'host', args[0], args[1]);
    return result.ok ? '' : `% ${result.error}`;
  });
  trie.registerGreedy('hardware-address', 'Manual binding hardware address', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!pool()) return '% No DHCP pool selected';
    dhcp().configurePoolManual(pool()!, 'hardwareAddress', args[0]);
    return '';
  });
  trie.registerGreedy('client-identifier', 'Manual binding client identifier', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!pool()) return '% No DHCP pool selected';
    dhcp().configurePoolManual(pool()!, 'clientIdentifier', args[0]);
    return '';
  });
  trie.registerGreedy('client-name', 'Manual binding client name', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!pool()) return '% No DHCP pool selected';
    dhcp().configurePoolManual(pool()!, 'clientName', args[0]);
    return '';
  });

  trie.registerGreedy('class', 'Bind a DHCP class to this pool', (args) => {
    if (!args[0]) return '% Incomplete command.';
    const p = pool(); if (!p) return '';
    const r = ctx.r() as any;
    const classes = r._ciscoDhcpPoolClasses ?? (r._ciscoDhcpPoolClasses = new Map<string, any>());
    const list = classes.get(p) ?? [];
    if (!list.find((c: any) => c.className === args[0])) {
      list.push({ className: args[0], ranges: [] });
    }
    classes.set(p, list);
    r._ciscoDhcpPoolCurrentClass = args[0];
    ctx.setMode('config-dhcp-pool-class');
    return '';
  });
}


const REST = (literal: string, description: string): ArgumentSpec =>
  ({ name: 'valeur', type: 'REST', literal, description });

const DHCP_POOL_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  network: [
    { name: 'reseau', type: 'IP_ADDR', description: 'Network number' },
    { name: 'masque', type: 'SUBNET_MASK', optional: true, description: 'Network mask' },
  ],
  host: [
    { name: 'adresse', type: 'IP_ADDR', description: 'Client IP address' },
    { name: 'masque', type: 'SUBNET_MASK', optional: true, description: 'Client subnet mask' },
  ],
  'default-router': REST('A.B.C.D', 'Default router IP address'),
  'dns-server': REST('A.B.C.D', 'DNS server IP address'),
  'netbios-name-server': REST('A.B.C.D', 'NetBIOS name server IP address'),
  lease: REST('<0-365>', 'Days'),
  option: REST('<0-254>', 'DHCP option code'),
  'next-server': { name: 'adresse', type: 'IP_ADDR', description: 'Boot server IP address' },
  bootfile: { name: 'fichier', type: 'WORD', description: 'Boot file name' },
  class: { name: 'nom', type: 'WORD', description: 'Name of the DHCP class' },
  'client-name': { name: 'nom', type: 'WORD', description: 'Client name, without the domain' },
  'domain-name': { name: 'domaine', type: 'WORD', description: 'Domain name given to clients' },
  'hardware-address': { name: 'mac', type: 'MAC_ADDR', description: 'Client hardware address' },
  'client-identifier': { name: 'identifiant', type: 'WORD', description: 'Client identifier' },
  'client-identifier deny': { name: 'identifiant', type: 'WORD', description: 'Client identifier to deny' },
  'netbios-node-type': {
    name: 'type', type: 'ENUM', description: 'NetBIOS node type',
    values: [
      { keyword: 'b-node', description: 'Broadcast node' },
      { keyword: 'h-node', description: 'Hybrid node' },
      { keyword: 'm-node', description: 'Mixed node' },
      { keyword: 'p-node', description: 'Peer-to-peer node' },
    ],
  },
};

const DHCP_POOL_KEYWORDS:
Readonly<Record<string, ReadonlyArray<{ keyword: string; description: string; argument?: null }>>> = {
  lease: [{ keyword: 'infinite', description: 'Infinite lease', argument: null }],
  option: [
    { keyword: 'ascii', description: 'ASCII text' },
    { keyword: 'hex', description: 'Hexadecimal' },
  ],
};

export function dhcpPoolSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildConfigDhcpCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-dhcp'], minPrivilege: 15,
      argumentFor: (path) => DHCP_POOL_ARGUMENTS[path],
      keywordsFor: (path) => DHCP_POOL_KEYWORDS[path],
    },
  );
}

export function buildConfigDhcpPoolClassCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('address range', 'DHCP class address range', (args) => {
    const r = ctx.r() as any;
    const p = ctx.getSelectedDHCPPool();
    const className = r._ciscoDhcpPoolCurrentClass;
    if (!p || !className) return '';
    const classes = r._ciscoDhcpPoolClasses as Map<string, any[]> | undefined;
    const list = classes?.get(p) ?? [];
    const entry = list.find((c) => c.className === className);
    if (entry && args.length >= 2) entry.ranges.push({ start: args[0], end: args[1] });
    return '';
  });
}

export function buildConfigDhcpClassCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  trie.registerGreedy('option', 'DHCP class option matcher', (args, raw) => {
    const r = ctx.r() as any;
    const cur = r._ciscoDhcpCurrentClass;
    const classes = r._ciscoDhcpClasses as Map<string, any> | undefined;
    const c = cur ? classes?.get(cur) : null;
    if (c) c.options.push(raw ?? `option ${args.join(' ')}`);
    return '';
  });
  trie.registerGreedy('description', 'Set DHCP class description', (args) => {
    const r = ctx.r() as any;
    const cur = r._ciscoDhcpCurrentClass;
    const c = cur ? (r._ciscoDhcpClasses as Map<string, any> | undefined)?.get(cur) : null;
    if (c) c.description = args.join(' ');
    return '';
  });
}

export function buildConfigIpv6DhcpCommands(trie: CommandTrie, ctx: CiscoShellContext): void {
  const cur = () => {
    const r = ctx.r() as any;
    const name = r._ciscoIpv6DhcpCurrent;
    if (!name) return null;
    return (r._ciscoIpv6DhcpPools as Map<string, any> | undefined)?.get(name) ?? null;
  };
  const curName = (): string | null => (ctx.r() as any)._ciscoIpv6DhcpCurrent ?? null;
  trie.registerGreedy('address prefix', 'IPv6 DHCP pool prefix', (args, raw) => {
    const p = cur(); if (p) { p.prefix = args[0]; p.prefixLine = raw; }
    const name = curName();
    if (name && args[0]) {
      const [prefix, lenStr] = args[0].split('/');
      const len = parseInt(lenStr ?? '', 10);
      if (prefix && !isNaN(len)) {
        ctx.r()._getDHCPv6ServerInternal().configurePoolPrefix(name, prefix, len);
        if (args[1]?.toLowerCase() === 'lifetime' && args[2] && args[3]) {
          const valid = parseInt(args[2], 10);
          const preferred = parseInt(args[3], 10);
          if (!isNaN(valid) && !isNaN(preferred)) {
            ctx.r()._getDHCPv6ServerInternal().configurePoolLifetime(name, preferred, valid);
          }
        }
      }
    }
    return '';
  });
  trie.registerGreedy('dns-server', 'IPv6 DNS server', (args) => {
    const p = cur(); if (p && args[0]) (p.dnsServers ??= []).push(args[0]);
    const name = curName();
    if (name && args[0]) {
      const server = ctx.r()._getDHCPv6ServerInternal();
      const pool = server.getPool(name);
      server.configurePoolDns(name, [...(pool?.dnsServers ?? []), args[0]]);
    }
    return '';
  });
  trie.registerGreedy('domain-name', 'IPv6 domain name', (args) => {
    const p = cur(); if (p && args[0]) p.domainName = args[0];
    const name = curName();
    if (name && args[0]) ctx.r()._getDHCPv6ServerInternal().configurePoolDomain(name, args[0]);
    return '';
  });
  trie.registerGreedy('link-address', 'IPv6 DHCP link-address', (args) => {
    const p = cur(); if (p && args[0]) p.linkAddress = args[0];
    return '';
  });
  trie.registerGreedy('description', 'Pool description', (args) => {
    const p = cur(); if (p) p.description = args.join(' ');
    return '';
  });
}

// ─── DHCP Show Commands (registered on user/privileged show tries) ───


const DHCP_CLASS_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'address range': [
    { name: 'debut', type: 'IP_ADDR', description: 'Start of the address range' },
    { name: 'fin', type: 'IP_ADDR', description: 'End of the address range' },
  ],
  option: REST('<0-254>', 'DHCP option to match'),
  description: REST('LINE', 'Class description'),
};

const IPV6_DHCP_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'address prefix': REST('X:X:X:X::X/<0-128>', 'IPv6 prefix given to clients'),
  'dns-server': { name: 'serveur', type: 'IPV6_ADDR', description: 'DNS server IPv6 address' },
  'domain-name': { name: 'domaine', type: 'WORD', description: 'Domain name given to clients' },
  'link-address': { name: 'prefixe', type: 'WORD', description: 'Link address prefix' },
};

export function dhcpPoolClassSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) =>
      buildConfigDhcpPoolClassCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-dhcp-pool-class'], minPrivilege: 15,
      argumentFor: (path) => DHCP_CLASS_ARGUMENTS[path],
    },
  );
}

export function dhcpClassSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildConfigDhcpClassCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-dhcp-class'], minPrivilege: 15,
      argumentFor: (path) => DHCP_CLASS_ARGUMENTS[path],
    },
  );
}

export function ipv6DhcpPoolSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildConfigIpv6DhcpCommands(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-ipv6-dhcp'], minPrivilege: 15,
      argumentFor: (path) => IPV6_DHCP_ARGUMENTS[path],
    },
  );
}

export function registerDhcpShowCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('show debug', 'Display debugging flags', () =>
    getRouter().getDebugService().format());

  trie.register('show ip dhcp snooping', 'Display DHCP snooping global state', () => {
    const r = getRouter() as any;
    const g = getGlobalConfig(r);
    if (!g.dhcpSnooping) return 'DHCP snooping is not enabled.';
    const vlans = g.dhcpSnoopingVlans ?? '(none)';
    return [
      'Switch DHCP snooping is enabled',
      `DHCP snooping VLAN configuration: ${vlans}`,
      `Insertion of option-82 information: ${g.dhcpSnoopingInfoOption ? 'yes' : 'no'}`,
    ].join('\n');
  });

  trie.register('show ipv6 dhcp binding', 'Display IPv6 DHCP bindings', () => {
    const r = getRouter() as any;
    const bindings = r._ciscoIpv6DhcpBindings as Map<string, any> | undefined;
    if (!bindings || bindings.size === 0) return 'No IPv6 DHCP bindings.';
    return [...bindings.values()].map(b => `${b.client} → ${b.address}`).join('\n');
  });
  trie.register('show dhcp server', 'Display DHCP server status', () => {
    const r = getRouter() as any;
    return r._ciscoDhcpServerEnabled === false ? 'DHCP server disabled.' : 'DHCP server enabled.';
  });

  trie.register('show ipv6 dhcp pool', 'Display IPv6 DHCP pools', () => {
    const r = getRouter() as any;
    const pools = r._ciscoIpv6DhcpPools as Map<string, any> | undefined;
    if (!pools || pools.size === 0) return 'No IPv6 DHCP pools configured.';
    const out: string[] = [];
    for (const [, p] of pools) {
      out.push(`DHCPv6 pool: ${p.name}`);
      if (p.prefix) out.push(`  Prefix: ${p.prefix}`);
      if (p.dnsServers) out.push(`  DNS servers: ${p.dnsServers.join(', ')}`);
      if (p.domainName) out.push(`  Domain: ${p.domainName}`);
    }
    return out.join('\n');
  });

  trie.register('show ipv6 dhcp interface', 'Display IPv6 DHCP interface state', () => {
    const router = getRouter();
    const lines: string[] = [];
    for (const [name, port] of router._getPortsInternal()) {
      const poolRef = (port as any).ipv6DhcpPool as string | undefined;
      const relays = (port as any).ipv6DhcpRelayDestinations as string[] | undefined;
      if (poolRef) lines.push(`${name} is in DHCPv6 server mode, pool ${poolRef}`);
      if (relays?.length) lines.push(`${name} is in DHCPv6 relay mode, destinations: ${relays.join(', ')}`);
    }
    if (lines.length === 0) return 'No IPv6 DHCP interface configuration.';
    return lines.join('\n');
  });

  trie.register('show ip dhcp snooping binding', 'Display DHCP snooping bindings', () =>
    getRouter()._getDHCPServerInternal().formatBindingsShow());

}

export function dhcpIpv6ShowSpecs(getRouter: () => Router): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => registerDhcpShowCommands(collector as unknown as CommandTrie, getRouter),
    {
      modes: ['user', 'privileged'], minPrivilege: 1,
      skip: (path) => !path.startsWith('show ipv6 dhcp'),
    },
  );
}

// ─── DHCP Privileged Commands (debug, clear) ─────────────────────────

export function registerDhcpPrivilegedCommands(trie: CommandTrie, getRouter: () => Router): void {
  // debug commands
  const debugSvc = () => getRouter().getDebugService();
  trie.register('debug ip dhcp server', 'Debug DHCP server', () => {
    const s = getRouter()._getDHCPServerInternal();
    s.setDebugServerPacket(true);
    s.setDebugServerEvents(true);
    debugSvc().enable('ip.dhcp.server');
    return 'DHCP server debugging is on';
  });
  trie.register('no debug ip dhcp server', 'Disable DHCP server debugging', () => {
    const s = getRouter()._getDHCPServerInternal();
    s.setDebugServerPacket(false);
    s.setDebugServerEvents(false);
    debugSvc().disable('ip.dhcp.server');
    return 'DHCP server debugging is off';
  });
  // Le mot-clé d'IOS est `packets`, au PLURIEL — vérifié sur la
  // référence de commandes Cisco, qui donne
  // `debug ip dhcp server {events | packets | linkage}`. Il était
  // enregistré au singulier, ce qui inversait la règle d'abréviation
  // d'IOS : la forme complète était refusée et seule l'abrégée passait.
  // Enregistrer la forme complète fait fonctionner les deux, `packet`
  // devenant une abréviation non ambiguë comme n'importe quelle autre.
  trie.register('debug ip dhcp server packets', 'Debug DHCP server packets', () => {
    getRouter()._getDHCPServerInternal().setDebugServerPacket(true);
    debugSvc().enable('ip.dhcp.server', 'packet');
    return 'DHCP server packet debugging is on';
  });
  // Le troisième mot-clé de la même famille. Il n'existait pas, et
  // `debug ip dhcp server ?` promettait donc deux choix là où IOS en a
  // trois. Ce simulateur n'a pas de notion de liaison parent-enfant
  // entre pools, donc la commande s'active et n'écrit rien de plus —
  // et le dit, plutôt que de laisser croire à une sortie qui viendrait.
  trie.register('debug ip dhcp server linkage', 'Debug DHCP database linkage', () => {
    debugSvc().enable('ip.dhcp.server', 'linkage');
    return 'DHCP server linkage debugging is on';
  });
  trie.register('no debug ip dhcp server linkage', 'Disable DHCP linkage debugging', () => {
    debugSvc().disable('ip.dhcp.server');
    return 'DHCP server linkage debugging is off';
  });
  trie.register('debug ip dhcp server events', 'Debug DHCP server events', () => {
    getRouter()._getDHCPServerInternal().setDebugServerEvents(true);
    debugSvc().enable('ip.dhcp.server', 'events');
    return 'DHCP server event debugging is on';
  });

  // no debug commands
  trie.register('no debug ip dhcp server packets', 'Disable DHCP packet debugging', () => {
    const s = getRouter()._getDHCPServerInternal();
    s.setDebugServerPacket(false);
    if (!s.getDebugFlags().serverEvents) debugSvc().disable('ip.dhcp.server');
    return 'DHCP server packet debugging is off';
  });
  trie.register('no debug ip dhcp server events', 'Disable DHCP event debugging', () => {
    const s = getRouter()._getDHCPServerInternal();
    s.setDebugServerEvents(false);
    if (!s.getDebugFlags().serverPacket) debugSvc().disable('ip.dhcp.server');
    return 'DHCP server event debugging is off';
  });

  // clear commands
}
