/**
 * CiscoDhcpCommands - Extracted DHCP command registration for Cisco IOS CLI
 *
 * Handles:
 *   - DHCP pool configuration mode (dhcp-config)#
 *   - DHCP show commands (show ip dhcp pool/binding/statistics/conflict/excluded-address)
 *   - DHCP debug/clear commands (privileged mode)
 */

import type { Router } from '../../Router';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CiscoShellContext } from './CiscoConfigCommands';
import { CliInvalidInput } from '../cli/CliDiagnostic';
import {
  DHCP_OPTION_CODE_MIN, DHCP_OPTION_CODE_MAX,
  isDhcpClientIdentifier, type DhcpOptionKind,
} from '../../../dhcp/optionSyntax';

const INVALID_INPUT = "% Invalid input detected at '^' marker.";

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

interface DhcpPoolClass {
  className: string;
  ranges: Array<{ start: string; end: string }>;
}

interface DhcpNamedClass {
  options: string[];
  description?: string;
}

interface Ipv6DhcpPool {
  prefix?: string;
  prefixLine?: string;
  dnsServers?: string[];
  domainName?: string;
  linkAddress?: string;
  description?: string;
}

interface DhcpProcessState {
  _ciscoDhcpPoolClasses?: Map<string, DhcpPoolClass[]>;
  _ciscoDhcpPoolCurrentClass?: string;
  _ciscoDhcpClasses?: Map<string, DhcpNamedClass>;
  _ciscoDhcpCurrentClass?: string;
  _ciscoIpv6DhcpPools?: Map<string, Ipv6DhcpPool>;
  _ciscoIpv6DhcpCurrent?: string;
  _ciscoDhcpServerEnabled?: boolean;
}

const processState = (ctx: CiscoShellContext): DhcpProcessState =>
  ctx.r() as unknown as DhcpProcessState;

const IPV6_PREFIX_WITH_LENGTH = /^[0-9a-fA-F:]+\/(?:\d|[1-9]\d|1[01]\d|12[0-8])$/;

export function dhcpPoolClassSpecs(ctx: CiscoShellContext): CommandSpec[] {
  return [{
    id: 'dhcp-pool-class-address-range', modes: ['config-dhcp-pool-class'], minPrivilege: 15,
    path: ['address', 'range',
      { name: 'start', type: 'IP_ADDR', description: 'Start of the address range' },
      { name: 'end', type: 'IP_ADDR', description: 'End of the address range' }],
    description: 'DHCP class address range',
    run: (_session, args) => {
      const state = processState(ctx);
      const pool = ctx.getSelectedDHCPPool();
      const className = state._ciscoDhcpPoolCurrentClass;
      if (!pool || !className) return '';
      const entry = state._ciscoDhcpPoolClasses?.get(pool)?.find((c) => c.className === className);
      entry?.ranges.push({ start: args.start, end: args.end });
      return '';
    },
  }];
}

export function dhcpClassSpecs(ctx: CiscoShellContext): CommandSpec[] {
  const base = { modes: ['config-dhcp-class'], minPrivilege: 15 };
  const current = (): DhcpNamedClass | undefined => {
    const state = processState(ctx);
    const name = state._ciscoDhcpCurrentClass;
    return name ? state._ciscoDhcpClasses?.get(name) : undefined;
  };
  return [
    {
      ...base, id: 'dhcp-class-option',
      path: ['option', {
        name: 'matcher', type: 'REST', literal: '<0-254>', description: 'DHCP option to match',
      }],
      description: 'DHCP class option matcher',
      run: (_session, args) => {
        current()?.options.push(`option ${args.matcher.trim()}`);
        return '';
      },
    },
    {
      ...base, id: 'dhcp-class-description',
      path: ['description', {
        name: 'text', type: 'REST', literal: 'LINE', description: 'Class description',
      }],
      description: 'Set DHCP class description',
      run: (_session, args) => {
        const entry = current();
        if (entry) entry.description = args.text.trim();
        return '';
      },
    },
  ];
}

export function ipv6DhcpPoolSpecs(ctx: CiscoShellContext): CommandSpec[] {
  const base = { modes: ['config-ipv6-dhcp'], minPrivilege: 15 };
  const server = () => ctx.r()._getDHCPv6ServerInternal();
  const poolName = (): string | undefined => processState(ctx)._ciscoIpv6DhcpCurrent;
  const pool = (): Ipv6DhcpPool | undefined => {
    const name = poolName();
    return name ? processState(ctx)._ciscoIpv6DhcpPools?.get(name) : undefined;
  };
  const lifetime = (name: string): ArgumentSpec => ({
    name, type: 'INT', range: [0, 4294967295], description: 'Lifetime in seconds',
  });
  const prefixPlace: ArgumentSpec = {
    name: 'prefix', type: 'WORD', pattern: IPV6_PREFIX_WITH_LENGTH,
    description: 'IPv6 prefix given to clients',
    alternatives: [{ keyword: 'X:X:X:X::X/<0-128>', description: 'IPv6 prefix given to clients' }],
  };
  const applyPrefix = (args: Record<string, string>, line: string): string => {
    const entry = pool();
    if (entry) { entry.prefix = args.prefix; entry.prefixLine = line; }
    const name = poolName();
    if (!name) return '';
    const [prefix, length] = args.prefix.split('/');
    server().configurePoolPrefix(name, prefix, parseInt(length, 10));
    if (args.valid !== undefined) {
      server().configurePoolLifetime(name, Number(args.preferred), Number(args.valid));
    }
    return '';
  };
  return [
    {
      ...base, id: 'ipv6-dhcp-address-prefix', path: ['address', 'prefix', prefixPlace],
      description: 'IPv6 DHCP pool prefix',
      run: (_session, args) => applyPrefix(args, `address prefix ${args.prefix}`),
    },
    {
      ...base, id: 'ipv6-dhcp-address-prefix-lifetime',
      path: ['address', 'prefix', prefixPlace, 'lifetime', lifetime('valid'), lifetime('preferred')],
      description: 'IPv6 DHCP pool prefix with lifetimes',
      run: (_session, args) => applyPrefix(
        args, `address prefix ${args.prefix} lifetime ${args.valid} ${args.preferred}`),
    },
    {
      ...base, id: 'ipv6-dhcp-dns-server',
      path: ['dns-server', { name: 'server', type: 'IPV6_ADDR', description: 'DNS server IPv6 address' }],
      description: 'IPv6 DNS server',
      run: (_session, args) => {
        const entry = pool();
        if (entry) (entry.dnsServers ??= []).push(args.server);
        const name = poolName();
        if (name) {
          server().configurePoolDns(name, [...(server().getPool(name)?.dnsServers ?? []), args.server]);
        }
        return '';
      },
    },
    {
      ...base, id: 'ipv6-dhcp-domain-name',
      path: ['domain-name', { name: 'domain', type: 'WORD', description: 'Domain name given to clients' }],
      description: 'IPv6 domain name',
      run: (_session, args) => {
        const entry = pool();
        if (entry) entry.domainName = args.domain;
        const name = poolName();
        if (name) server().configurePoolDomain(name, args.domain);
        return '';
      },
    },
    {
      ...base, id: 'ipv6-dhcp-link-address',
      path: ['link-address', { name: 'prefix', type: 'WORD', description: 'Link address prefix' }],
      description: 'IPv6 DHCP link-address',
      run: (_session, args) => {
        const entry = pool();
        if (entry) entry.linkAddress = args.prefix;
        return '';
      },
    },
    {
      ...base, id: 'ipv6-dhcp-description',
      path: ['description', { name: 'text', type: 'REST', literal: 'LINE', description: 'Pool description' }],
      description: 'Pool description',
      run: (_session, args) => {
        const entry = pool();
        if (entry) entry.description = args.text.trim();
        return '';
      },
    },
  ];
}

export function dhcpShowSpecs(getRouter: () => Router): CommandSpec[] {
  const base = { modes: ['user', 'privileged'], minPrivilege: 1 };
  return [
    {
      ...base, id: 'show-dhcp-server', path: ['show', 'dhcp', 'server'],
      description: 'Display DHCP server status',
      run: () => (getRouter() as unknown as DhcpProcessState)._ciscoDhcpServerEnabled === false
        ? 'DHCP server disabled.' : 'DHCP server enabled.',
    },
    {
      ...base, id: 'show-ipv6-dhcp-interface', path: ['show', 'ipv6', 'dhcp', 'interface'],
      description: 'Display IPv6 DHCP interface state',
      run: () => {
        const lines: string[] = [];
        for (const [name, port] of getRouter()._getPortsInternal()) {
          const state = port as unknown as {
            ipv6DhcpPool?: string; ipv6DhcpRelayDestinations?: string[];
          };
          if (state.ipv6DhcpPool) {
            lines.push(`${name} is in DHCPv6 server mode, pool ${state.ipv6DhcpPool}`);
          }
          if (state.ipv6DhcpRelayDestinations?.length) {
            lines.push(`${name} is in DHCPv6 relay mode, destinations: ${state.ipv6DhcpRelayDestinations.join(', ')}`);
          }
        }
        return lines.length === 0 ? 'No IPv6 DHCP interface configuration.' : lines.join('\n');
      },
    },
  ];
}
