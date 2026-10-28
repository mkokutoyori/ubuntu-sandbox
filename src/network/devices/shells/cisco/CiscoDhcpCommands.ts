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
import type { AdapterKeyword } from '@/cli/commands/trieAdapter';
import type { CiscoShellContext } from './CiscoConfigCommands';
import { boundedInteger } from '@/cli/ArgumentTypes';
import { CliInvalidInput } from '../cli/CliDiagnostic';
import {
  DHCP_OPTION_CODE_MIN, DHCP_OPTION_CODE_MAX, isDhcpOptionKind,
  isDhcpClientIdentifier, type DhcpOptionKind,
} from '../../../dhcp/optionSyntax';

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

const REST = (literal: string, description: string): ArgumentSpec =>
  ({ name: 'valeur', type: 'REST', literal, description });

const NO_POOL = '% No DHCP pool selected';
const USABLE_HOST_FIRST_OCTET = /^(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])\./;
const MAX_ADDRESSES = 8;

function addressList(prefix: string, description: string, usableHost: boolean): ArgumentSpec[] {
  return Array.from({ length: MAX_ADDRESSES }, (_unused, index): ArgumentSpec => ({
    name: `${prefix}${index}`, type: 'IP_ADDR', description,
    ...(index > 0 ? { optional: true } : {}),
    ...(usableHost ? { pattern: USABLE_HOST_FIRST_OCTET } : {}),
  }));
}

function addressesOf(args: Record<string, string>, prefix: string): string[] {
  return Object.keys(args)
    .filter((key) => key.startsWith(prefix) && args[key] !== undefined)
    .sort()
    .map((key) => args[key]);
}

const NETBIOS_NODE_TYPES: ArgumentSpec = {
  name: 'type', type: 'ENUM', description: 'NetBIOS node type',
  values: [
    { keyword: 'b-node', description: 'Broadcast node' },
    { keyword: 'h-node', description: 'Hybrid node' },
    { keyword: 'm-node', description: 'Mixed node' },
    { keyword: 'p-node', description: 'Peer-to-peer node' },
  ],
};

const UTILIZATION_LOG: ArgumentSpec = {
  name: 'log', type: 'ENUM', optional: true, description: 'Enable the system message',
  values: [{ keyword: 'log', description: 'Generate a system message when the mark is crossed' }],
};

export function dhcpPoolSpecs(ctx: CiscoShellContext): CommandSpec[] {
  const base = { modes: ['config-dhcp'], minPrivilege: 15 };
  const dhcp = () => ctx.r()._getDHCPServerInternal();
  const onPool = (apply: (pool: string) => string): string => {
    const pool = ctx.getSelectedDHCPPool();
    return pool ? apply(pool) : NO_POOL;
  };
  const word = (name: string, description: string): ArgumentSpec => ({
    name, type: 'WORD', description,
  });
  const utilizationMark = (
    keyword: 'high' | 'low', floor: number, description: string,
  ): CommandSpec => ({
    ...base, id: `dhcp-pool-utilization-mark-${keyword}`,
    path: ['utilization', 'mark', keyword, {
      name: 'percentage', type: 'INT', range: [floor, 100],
      description: 'Percentage of the pool size',
    }, UTILIZATION_LOG],
    description, undoDescription: 'Restore the default utilization threshold',
    undoOmitsArguments: true,
    run: (_session, args) => onPool((pool) =>
      dhcp().configurePoolUtilizationMark(
        pool, keyword, parseInt(args.percentage, 10), args.log !== undefined)
        ? '' : INVALID_INPUT),
    undo: () => onPool((pool) => { dhcp().resetPoolUtilizationMark(pool, keyword); return ''; }),
  });
  const rawOption = (kind: DhcpOptionKind, place: ArgumentSpec): CommandSpec => ({
    ...base, id: `dhcp-pool-option-${kind}`,
    path: ['option', {
      name: 'code', type: 'INT', range: [DHCP_OPTION_CODE_MIN, DHCP_OPTION_CODE_MAX],
      description: 'DHCP option code',
    }, kind, place],
    description: 'Set a raw DHCP option',
    run: (_session, args) => onPool((pool) => {
      if (!dhcp().configurePoolOption(pool, Number(args.code), kind, args.value.trim())) {
        throw new CliInvalidInput({ token: args.value.split(/\s+/)[0] });
      }
      return '';
    }),
  });
  const manual = (
    id: string, keyword: string, field: 'hardwareAddress' | 'clientName', place: ArgumentSpec,
    description: string,
  ): CommandSpec => ({
    ...base, id, path: [keyword, place], description,
    run: (_session, args) => onPool((pool) => {
      dhcp().configurePoolManual(pool, field, args[place.name]);
      return '';
    }),
  });
  const leaseTime = (name: string, max: number, description: string, optional: boolean): ArgumentSpec => ({
    name, type: 'INT', range: [0, max], description, ...(optional ? { optional: true } : {}),
  });
  return [
    {
      ...base, id: 'dhcp-pool-network',
      path: ['network',
        { name: 'network', type: 'IP_ADDR', description: 'Network number' },
        { name: 'mask', type: 'SUBNET_MASK', description: 'Network mask' }],
      description: 'Define DHCP pool network',
      run: (_session, args) => onPool((pool) => {
        dhcp().configurePoolNetwork(pool, args.network, args.mask);
        return '';
      }),
    },
    {
      ...base, id: 'dhcp-pool-default-router',
      path: ['default-router', ...addressList('router', 'Default router IP address', true)],
      description: 'Set default router for DHCP clients',
      run: (_session, args) => onPool((pool) => {
        dhcp().configurePoolRouter(pool, addressesOf(args, 'router'));
        return '';
      }),
    },
    {
      ...base, id: 'dhcp-pool-dns-server',
      path: ['dns-server', ...addressList('server', 'DNS server IP address', true)],
      description: 'Set DNS server for DHCP clients',
      run: (_session, args) => onPool((pool) => {
        dhcp().configurePoolDNS(pool, addressesOf(args, 'server'));
        return '';
      }),
    },
    {
      ...base, id: 'dhcp-pool-domain-name',
      path: ['domain-name', word('domain', 'Domain name given to clients')],
      description: 'Set domain name for DHCP clients',
      run: (_session, args) => onPool((pool) => {
        dhcp().configurePoolDomain(pool, args.domain);
        return '';
      }),
    },
    {
      ...base, id: 'dhcp-pool-lease-infinite', path: ['lease', 'infinite'],
      description: 'Infinite lease',
      run: () => onPool((pool) => { dhcp().configurePoolLeaseInfinite(pool); return ''; }),
    },
    {
      ...base, id: 'dhcp-pool-lease',
      path: ['lease', leaseTime('days', 365, 'Days', false),
        leaseTime('hours', 23, 'Hours', true), leaseTime('minutes', 59, 'Minutes', true)],
      description: 'Set DHCP lease duration',
      run: (_session, args) => onPool((pool) => {
        const seconds = Number(args.days) * 86400
          + Number(args.hours ?? 0) * 3600 + Number(args.minutes ?? 0) * 60;
        if (seconds === 0) return INVALID_INPUT;
        dhcp().configurePoolLease(pool, seconds);
        return '';
      }),
    },
    {
      ...base, id: 'dhcp-pool-client-identifier-deny',
      path: ['client-identifier', 'deny', word('identifier', 'Client identifier to deny')],
      description: 'Deny DHCP by client identifier',
      run: (_session, args) => onPool((pool) => {
        dhcp().addDenyPattern(pool, args.identifier);
        return '';
      }),
    },
    {
      ...base, id: 'dhcp-pool-next-server',
      path: ['next-server', { name: 'address', type: 'IP_ADDR', description: 'Boot server IP address' }],
      description: 'Set boot/next server',
      run: (_session, args) => onPool((pool) => {
        dhcp().configurePoolNextServer(pool, args.address);
        return '';
      }),
    },
    {
      ...base, id: 'dhcp-pool-bootfile',
      path: ['bootfile', word('file', 'Boot file name')],
      description: 'Set boot filename',
      run: (_session, args) => onPool((pool) => {
        dhcp().configurePoolBootfile(pool, args.file);
        return '';
      }),
    },
    {
      ...base, id: 'dhcp-pool-netbios-name-server',
      path: ['netbios-name-server', ...addressList('server', 'NetBIOS name server IP address', false)],
      description: 'Set NetBIOS name server(s)',
      run: (_session, args) => onPool((pool) => {
        dhcp().configurePoolNetbios(pool, addressesOf(args, 'server'));
        return '';
      }),
    },
    {
      ...base, id: 'dhcp-pool-netbios-node-type',
      path: ['netbios-node-type', NETBIOS_NODE_TYPES],
      description: 'Set NetBIOS node type',
      run: (_session, args) => onPool((pool) => {
        dhcp().configurePoolNetbiosNodeType(pool, args.type);
        return '';
      }),
    },
    rawOption('ascii', {
      name: 'value', type: 'REST', literal: 'LINE',
      description: 'ASCII string sent as the option value',
    }),
    rawOption('ip', {
      name: 'value', type: 'REST', literal: 'A.B.C.D',
      description: 'IP addresses sent as the option value',
    }),
    rawOption('hex', {
      name: 'value', type: 'REST', literal: 'WORD',
      description: 'Hexadecimal string sent as the option value',
    }),
    {
      ...base, id: 'dhcp-pool-host',
      path: ['host',
        { name: 'address', type: 'IP_ADDR', description: 'Client IP address' },
        { name: 'mask', type: 'SUBNET_MASK', optional: true, description: 'Client subnet mask' }],
      description: 'Manual binding host address',
      run: (_session, args) => onPool((pool) => {
        const result = dhcp().configurePoolManual(pool, 'host', args.address, args.mask);
        return result.ok ? '' : `% ${result.error}`;
      }),
    },
    manual('dhcp-pool-hardware-address', 'hardware-address', 'hardwareAddress',
      { name: 'mac', type: 'MAC_ADDR', description: 'Client hardware address' },
      'Manual binding hardware address'),
    {
      ...base, id: 'dhcp-pool-client-identifier',
      path: ['client-identifier', word('identifier', 'Client identifier')],
      description: 'Manual binding client identifier',
      run: (_session, args) => onPool((pool) => {
        if (!isDhcpClientIdentifier(args.identifier)) {
          throw new CliInvalidInput({ token: args.identifier });
        }
        dhcp().configurePoolManual(pool, 'clientIdentifier', args.identifier);
        return '';
      }),
    },
    manual('dhcp-pool-client-name', 'client-name', 'clientName',
      word('name', 'Client name, without the domain'), 'Manual binding client name'),
    utilizationMark('high', 1, 'Configure the high utilization mark'),
    utilizationMark('low', 0, 'Configure the low utilization mark'),
    {
      ...base, id: 'dhcp-pool-class', path: ['class', word('name', 'Name of the DHCP class')],
      description: 'Bind a DHCP class to this pool',
      run: (_session, args) => {
        const pool = ctx.getSelectedDHCPPool();
        if (!pool) return '';
        const router = ctx.r() as unknown as {
          _ciscoDhcpPoolClasses?: Map<string, Array<{ className: string; ranges: unknown[] }>>;
          _ciscoDhcpPoolCurrentClass?: string;
        };
        const classes = router._ciscoDhcpPoolClasses
          ?? (router._ciscoDhcpPoolClasses = new Map());
        const list = classes.get(pool) ?? [];
        if (!list.find((entry) => entry.className === args.name)) {
          list.push({ className: args.name, ranges: [] });
        }
        classes.set(pool, list);
        router._ciscoDhcpPoolCurrentClass = args.name;
        ctx.setMode('config-dhcp-pool-class');
        return '';
      },
    },
  ];
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
  trie.register('show dhcp server', 'Display DHCP server status', () => {
    const r = getRouter() as any;
    return r._ciscoDhcpServerEnabled === false ? 'DHCP server disabled.' : 'DHCP server enabled.';
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
