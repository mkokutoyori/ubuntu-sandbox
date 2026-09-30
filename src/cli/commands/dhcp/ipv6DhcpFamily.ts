import type { CommandSpec } from '../../CommandTable';
import type { DHCPv6Server } from '@/network/dhcpv6/DHCPv6Server';
import { parseIpv6Prefix } from '@/network/core/Ipv6Arithmetic';
import { pad2 } from '@/lib/format';
import { IOS_MONTHS } from '@/network/devices/shells/cisco/CiscoCommonShow';

export type LocalClockReading = (epochMs: number) => Date;

export interface Ipv6DhcpHost {
  server(): DHCPv6Server | undefined;
  currentPool(): string | null;
  now(): number;
}

const EXEC = Object.freeze(['user', 'privileged']);
const PRIVILEGED = Object.freeze(['privileged']);
const CONFIG = Object.freeze(['config']);
const POOL_MODE = Object.freeze(['config-ipv6-dhcp']);
const UTC_READING: LocalClockReading = (epochMs) => new Date(epochMs);

export function normalizeDuid(text: string): string | null {
  const hex = text.replace(/[:.\-]/g, '').toLowerCase();
  if (hex.length < 4 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  return (hex.match(/../g) ?? []).join(':');
}

function duidText(duid: string): string {
  return duid.replace(/:/g, '').toUpperCase();
}

function upper(address: string): string {
  return address.toUpperCase();
}

function iaidText(iaid: number): string {
  return `0x${iaid.toString(16).toUpperCase().padStart(8, '0')}`;
}

function expiryText(at: number, now: number, localTime: LocalClockReading): string {
  const local = localTime(at);
  const hour = local.getUTCHours();
  const remaining = Math.max(0, Math.floor((at - now) / 1000));
  return `${IOS_MONTHS[local.getUTCMonth()]} ${pad2(local.getUTCDate())} ${local.getUTCFullYear()} `
    + `${pad2(hour % 12 || 12)}:${pad2(local.getUTCMinutes())} ${hour < 12 ? 'AM' : 'PM'} (${remaining} seconds)`;
}

interface ClientView {
  duid: string;
  naEntries: Array<{ iaid: number; address: string; expires: number; pool: string }>;
  pdEntries: Array<{ iaid: number; prefix: string; length: number; expires: number; pool: string }>;
}

function clientsOf(server: DHCPv6Server): ClientView[] {
  const byDuid = new Map<string, ClientView>();
  const view = (duid: string): ClientView => {
    let entry = byDuid.get(duid);
    if (!entry) { entry = { duid, naEntries: [], pdEntries: [] }; byDuid.set(duid, entry); }
    return entry;
  };
  for (const b of server.getBindings()) {
    view(b.clientDuid).naEntries.push({ iaid: b.iaid, address: b.address, expires: b.leaseExpiration, pool: b.poolName });
  }
  for (const b of server.getPrefixBindings()) {
    view(b.clientDuid).pdEntries.push({ iaid: b.iaid, prefix: b.prefix, length: b.prefixLength, expires: b.leaseExpiration, pool: b.poolName });
  }
  return [...byDuid.values()];
}

export function formatIpv6DhcpBindings(
  server: DHCPv6Server, now: number, localTime: LocalClockReading, filter?: string,
): string {
  const lines: string[] = [];
  for (const client of clientsOf(server)) {
    const address = server.clientAddressOf(client.duid) ?? '::';
    if (filter && upper(address) !== upper(filter)) continue;
    lines.push(`Client: ${upper(address)}`);
    lines.push(`  DUID: ${duidText(client.duid)}`);
    lines.push('  Username : unassigned');
    for (const na of client.naEntries) {
      const pool = server.getPool(na.pool);
      const preferred = pool?.preferredLifetime ?? 0;
      lines.push(`  IA NA: IA ID ${iaidText(na.iaid)}, T1 ${Math.floor(preferred * 0.5)}, T2 ${Math.floor(preferred * 0.8)}`);
      lines.push(`    Address: ${upper(na.address)}`);
      lines.push(`            preferred lifetime ${preferred}, valid lifetime ${pool?.validLifetime ?? 0}`);
      lines.push(`            expires at ${expiryText(na.expires, now, localTime)}`);
    }
    for (const pd of client.pdEntries) {
      const pool = server.getPool(pd.pool);
      const preferred = pool?.preferredLifetime ?? 0;
      lines.push(`  IA PD: IA ID ${iaidText(pd.iaid)}, T1 ${Math.floor(preferred * 0.5)}, T2 ${Math.floor(preferred * 0.8)}`);
      lines.push(`    Prefix: ${upper(pd.prefix)}/${pd.length}`);
      lines.push(`            preferred lifetime ${preferred}, valid lifetime ${pool?.validLifetime ?? 0}`);
      lines.push(`            expires at ${expiryText(pd.expires, now, localTime)}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : 'No IPv6 DHCP bindings.';
}

export function formatIpv6DhcpPools(server: DHCPv6Server, only?: string): string {
  const lines: string[] = [];
  for (const [name, pool] of server.getAllPools()) {
    if (only && name !== only) continue;
    lines.push(`DHCPv6 pool: ${name}`);
    if (pool.prefix && pool.prefixLength) {
      const inUse = server.getBindings().filter(b => b.poolName === name).length;
      lines.push(`  Address allocation prefix: ${upper(pool.prefix)}/${pool.prefixLength} valid ${pool.validLifetime} preferred ${pool.preferredLifetime} (${inUse} in use, 0 conflicts)`);
    }
    if (pool.staticDelegations.length > 0) {
      lines.push('  Static bindings:');
      for (const fixed of pool.staticDelegations) {
        lines.push(`    Binding for client ${duidText(fixed.clientDuid)}`);
        lines.push(`      IA PD: IA ID ${fixed.iaid === null ? 'any' : iaidText(fixed.iaid).slice(2)},`);
        lines.push(`        Prefix: ${upper(fixed.prefix)}/${fixed.prefixLength}`);
        lines.push(`                preferred lifetime ${pool.preferredLifetime}, valid lifetime ${pool.validLifetime}`);
      }
    }
    if (pool.delegationFromLocalPool) {
      lines.push(`  Prefix from pool: ${pool.delegationFromLocalPool}, Valid lifetime ${pool.validLifetime}, Preferred lifetime ${pool.preferredLifetime}`);
    }
    for (const dns of pool.dnsServers) lines.push(`  DNS server: ${upper(dns)}`);
    if (pool.domainName) lines.push(`  Domain name: ${pool.domainName}`);
    const clients = new Set([
      ...server.getBindings().filter(b => b.poolName === name).map(b => b.clientDuid),
      ...server.getPrefixBindings().filter(b => b.poolName === name).map(b => b.clientDuid),
    ]);
    lines.push(`  Active clients: ${clients.size}`);
  }
  return lines.length > 0 ? lines.join('\n') : 'No IPv6 DHCP pools configured.';
}

function bindingsFamily(host: () => Ipv6DhcpHost | undefined, localTime: LocalClockReading): CommandSpec[] {
  const withServer = (render: (server: DHCPv6Server, now: number) => string) => (): string => {
    const target = host();
    const server = target?.server();
    return target && server ? render(server, target.now()) : '';
  };
  return [
    {
      id: 'show-ipv6-dhcp-binding',
      path: ['show', 'ipv6', 'dhcp', 'binding',
        { name: 'client', type: 'IPV6_ADDR' as const, optional: true, description: 'Client link-local address' }],
      description: 'DHCPv6 address and prefix bindings',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => withServer((server, now) =>
        formatIpv6DhcpBindings(server, now, localTime, args.client ? String(args.client) : undefined))(),
    },
    {
      id: 'show-ipv6-dhcp-pool',
      path: ['show', 'ipv6', 'dhcp', 'pool',
        { name: 'name', type: 'WORD' as const, optional: true, description: 'DHCPv6 pool name' }],
      description: 'DHCPv6 pool information',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => withServer(server =>
        formatIpv6DhcpPools(server, args.name ? String(args.name) : undefined))(),
    },
    {
      id: 'clear-ipv6-dhcp-binding',
      path: ['clear', 'ipv6', 'dhcp', 'binding',
        { name: 'target', type: 'WORD' as const, optional: true, description: 'Client address, or nothing for every binding' }],
      description: 'Clear DHCPv6 bindings',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => withServer(server => {
        if (!args.target) { server.clearAllBindings(); return ''; }
        const wanted = upper(String(args.target));
        for (const client of clientsOf(server)) {
          if (upper(server.clientAddressOf(client.duid) ?? '') !== wanted) continue;
          for (const na of client.naEntries) server.clearBinding(na.address);
          for (const pd of client.pdEntries) server.clearPrefixBinding(pd.prefix, pd.length);
        }
        return '';
      })(),
    },
  ];
}

function configurationFamily(host: () => Ipv6DhcpHost | undefined): CommandSpec[] {
  return [
    {
      id: 'ipv6-local-pool',
      path: ['ipv6', 'local', 'pool',
        { name: 'name', type: 'WORD' as const, description: 'Pool name' },
        { name: 'prefix', type: 'IPV6_PREFIX' as const, description: 'IPv6 prefix to delegate from' },
        { name: 'assigned', type: 'INT' as const, range: [1, 128] as [number, number], description: 'Length of each delegated prefix' }],
      description: 'Configure IPv6 prefix pool',
      modes: CONFIG, minPrivilege: 15,
      run: (_session, args) => {
        const server = host()?.server();
        const parsed = parseIpv6Prefix(String(args.prefix));
        if (!server || !parsed) return '';
        const assigned = Number(args.assigned);
        if (assigned < parsed.prefixLength) return '% Prefix length is longer than the assigned length';
        server.configureLocalPool(String(args.name), parsed.address, parsed.prefixLength, assigned);
        return '';
      },
      undoDescription: 'Remove the IPv6 prefix pool',
      undoOmitsArguments: true,
      undo: (_session, args) => {
        host()?.server()?.deleteLocalPool(String(args.name));
        return '';
      },
    },
    {
      id: 'dhcpv6-prefix-delegation-pool',
      path: ['prefix-delegation', 'pool',
        { name: 'pool', type: 'WORD' as const, description: 'IPv6 local pool to delegate from' }],
      description: 'Delegate prefixes from a local pool',
      modes: POOL_MODE, minPrivilege: 15,
      run: (_session, args) => {
        const target = host();
        const name = target?.currentPool();
        const server = target?.server();
        if (!name || !server) return '';
        server.configurePoolDelegationFromLocalPool(name, String(args.pool));
        return '';
      },
    },
    {
      id: 'dhcpv6-prefix-delegation-static',
      path: ['prefix-delegation',
        { name: 'prefix', type: 'IPV6_PREFIX' as const, description: 'Prefix to delegate' },
        { name: 'duid', type: 'WORD' as const, description: 'Client DUID (hexadecimal)' }],
      options: [{
        keyword: 'iaid', description: 'Identity association identifier of the client',
        argument: { name: 'iaid', type: 'INT' as const, range: [0, 4294967295] as [number, number], description: 'IAID' },
      }],
      description: 'Delegate a prefix to one client',
      modes: POOL_MODE, minPrivilege: 15,
      run: (_session, args) => {
        const target = host();
        const name = target?.currentPool();
        const server = target?.server();
        const parsed = parseIpv6Prefix(String(args.prefix));
        const duid = normalizeDuid(String(args.duid));
        if (!name || !server || !parsed) return '';
        if (!duid) return "% Invalid input detected at '^' marker.";
        server.configurePoolStaticDelegation(name, {
          prefix: parsed.address, prefixLength: parsed.prefixLength, clientDuid: duid,
          iaid: args.iaid === undefined ? null : Number(args.iaid),
        });
        return '';
      },
    },
  ];
}

export function ipv6DhcpFamily(
  host: () => Ipv6DhcpHost | undefined, localTime: LocalClockReading = UTC_READING,
): CommandSpec[] {
  return [...bindingsFamily(host, localTime), ...configurationFamily(host)];
}
