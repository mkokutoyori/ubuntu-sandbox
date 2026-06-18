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
import type { CiscoShellContext } from './CiscoConfigCommands';

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
    ctx.r()._getDHCPServerInternal().configurePoolRouter(ctx.getSelectedDHCPPool()!, args[0]);
    return '';
  });

  trie.registerGreedy('dns-server', 'Set DNS server for DHCP clients', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    if (!ctx.getSelectedDHCPPool()) return '% No DHCP pool selected';
    ctx.r()._getDHCPServerInternal().configurePoolDNS(ctx.getSelectedDHCPPool()!, args);
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
    dhcp().configurePoolManual(pool()!, 'host', args[0], args[1]);
    return '';
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
  trie.registerGreedy('address prefix', 'IPv6 DHCP pool prefix', (args, raw) => {
    const p = cur(); if (p) { p.prefix = args[0]; p.prefixLine = raw; }
    return '';
  });
  trie.registerGreedy('dns-server', 'IPv6 DNS server', (args) => {
    const p = cur(); if (p && args[0]) (p.dnsServers ??= []).push(args[0]);
    return '';
  });
  trie.registerGreedy('domain-name', 'IPv6 domain name', (args) => {
    const p = cur(); if (p && args[0]) p.domainName = args[0];
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

export function registerDhcpShowCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.registerGreedy('show ip dhcp pool', 'Display DHCP pool information', (args) =>
    getRouter()._getDHCPServerInternal().formatPoolShow(args.length > 0 ? args[0] : undefined));
  trie.registerGreedy('show ip dhcp binding', 'Display DHCP address bindings', (args) => {
    const full = getRouter()._getDHCPServerInternal().formatBindingsShow();
    if (!args.length) return full;
    const lines = full.split('\n');
    const matched = lines.filter(l => l.includes(args[0]));
    return matched.length ? [lines[0], ...matched].join('\n') : lines[0];
  });
  trie.register('show ip dhcp server statistics', 'Display DHCP server statistics', () =>
    getRouter()._getDHCPServerInternal().formatStatsShow());
  trie.register('show ip dhcp conflict', 'Display DHCP address conflicts', () =>
    getRouter()._getDHCPServerInternal().formatConflictShow());
  trie.register('show ip dhcp excluded-address', 'Display DHCP excluded addresses', () =>
    getRouter()._getDHCPServerInternal().formatExcludedShow());
  trie.register('show debug', 'Display debugging flags', () =>
    getRouter()._getDHCPServerInternal().formatDebugShow());

  trie.register('show ip dhcp snooping', 'Display DHCP snooping global state', () => {
    const r = getRouter() as any;
    if (!r._ciscoDhcpSnooping) return 'DHCP snooping is not enabled.';
    const vlans = r._ciscoDhcpSnoopingVlans ?? '(none)';
    return [
      'Switch DHCP snooping is enabled',
      `DHCP snooping VLAN configuration: ${vlans}`,
      `Insertion of option-82 information: ${r._ciscoDhcpSnoopingInfoOption ? 'yes' : 'no'}`,
    ].join('\n');
  });

  trie.register('show ipv6 dhcp binding', 'Display IPv6 DHCP bindings', () => {
    const r = getRouter() as any;
    const bindings = r._ciscoIpv6DhcpBindings as Map<string, any> | undefined;
    if (!bindings || bindings.size === 0) return 'No IPv6 DHCP bindings.';
    return [...bindings.values()].map(b => `${b.client} → ${b.address}`).join('\n');
  });
  trie.register('show dhcp lease', 'Display DHCP client leases', () => 'No DHCP leases.');
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

  trie.register('show ip dhcp relay statistics', 'Display DHCP relay statistics', () =>
    getRouter()._getDHCPServerInternal().formatStatsShow());
}

// ─── DHCP Privileged Commands (debug, clear) ─────────────────────────

export function registerDhcpPrivilegedCommands(trie: CommandTrie, getRouter: () => Router): void {
  // debug commands
  trie.register('debug ip dhcp server', 'Debug DHCP server', () => {
    const s = getRouter()._getDHCPServerInternal();
    s.setDebugServerPacket(true);
    s.setDebugServerEvents(true);
    return 'DHCP server debugging is on';
  });
  trie.register('no debug ip dhcp server', 'Disable DHCP server debugging', () => {
    const s = getRouter()._getDHCPServerInternal();
    s.setDebugServerPacket(false);
    s.setDebugServerEvents(false);
    return 'DHCP server debugging is off';
  });
  trie.register('debug ip dhcp server packet', 'Debug DHCP server packets', () => {
    getRouter()._getDHCPServerInternal().setDebugServerPacket(true);
    return 'DHCP server packet debugging is on';
  });
  trie.register('debug ip dhcp server events', 'Debug DHCP server events', () => {
    getRouter()._getDHCPServerInternal().setDebugServerEvents(true);
    return 'DHCP server event debugging is on';
  });

  // no debug commands
  trie.register('no debug ip dhcp server packet', 'Disable DHCP packet debugging', () => {
    getRouter()._getDHCPServerInternal().setDebugServerPacket(false);
    return '';
  });
  trie.register('no debug ip dhcp server events', 'Disable DHCP event debugging', () => {
    getRouter()._getDHCPServerInternal().setDebugServerEvents(false);
    return '';
  });

  // clear commands
  trie.registerGreedy('clear ip dhcp binding', 'Clear DHCP bindings', (args) => {
    const dhcp = getRouter()._getDHCPServerInternal();
    if (args.length > 0 && args[0] === '*') {
      dhcp.clearBindings();
    } else if (args.length > 0) {
      dhcp.clearBinding(args[0]);
    } else {
      return '% Incomplete command.';
    }
    return '';
  });
  trie.register('clear ip dhcp server statistics', 'Clear DHCP server statistics', () => {
    getRouter()._getDHCPServerInternal().clearStats();
    return '';
  });
  trie.registerGreedy('clear ip dhcp conflict', 'Clear DHCP address conflicts', () => {
    getRouter()._getDHCPServerInternal().clearConflicts();
    return '';
  });
}
