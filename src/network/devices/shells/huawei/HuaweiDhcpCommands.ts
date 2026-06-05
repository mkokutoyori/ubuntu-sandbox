/**
 * HuaweiDhcpCommands - Extracted DHCP command implementations for Huawei VRP CLI
 *
 * Handles:
 *   - dhcp enable / dhcp snooping enable (system mode)
 *   - dhcp server ip-pool (system mode)
 *   - DHCP pool configuration mode commands
 *   - DHCP display commands
 *
 * Provides registerDhcpSystemCommands(), buildDhcpPoolCommands(), registerDhcpDisplayCommands()
 */

import type { Router } from '../../Router';
import type { HuaweiShellContext } from './HuaweiConfigCommands';
import type { CommandTrie } from '../CommandTrie';

// ─── Callbacks for shell-owned state ────────────────────────────────

export interface DhcpStateCallbacks {
  setDhcpEnabled(v: boolean): void;
  setDhcpSnoopingEnabled(v: boolean): void;
}

// ─── System-mode DHCP Commands (register on system trie) ────────────

export function registerDhcpSystemCommands(
  trie: CommandTrie,
  ctx: HuaweiShellContext,
  callbacks: DhcpStateCallbacks,
): void {
  const getRouter = () => ctx.r();

  trie.register('dhcp enable', 'Enable DHCP service', () => {
    callbacks.setDhcpEnabled(true);
    getRouter()._getDHCPServerInternal().enable();
    return '';
  });

  trie.register('dhcp snooping enable', 'Enable DHCP snooping', () => {
    callbacks.setDhcpSnoopingEnabled(true);
    return '';
  });

  trie.registerGreedy('dhcp server forbidden-ip', 'Exclude IP range from DHCP allocation', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const start = args[0];
    const end = args[1] || start;
    getRouter()._getDHCPServerInternal().addExcludedRange(start, end);
    return '';
  });

  trie.registerGreedy('dhcp server ip-pool', 'Create DHCP server pool', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const poolName = args[0];
    const dhcp = getRouter()._getDHCPServerInternal();
    if (!dhcp.getPool(poolName)) {
      dhcp.createPool(poolName);
    }
    ctx.setSelectedPool(poolName);
    ctx.setMode('dhcp-pool');
    return '';
  });

  trie.registerGreedy('dhcp snooping enable', 'Enable DHCP snooping (with optional vlan/ipv4 scope)', (_args) => {
    callbacks.setDhcpSnoopingEnabled(true);
    return '';
  });
}

export function registerDhcpInterfaceCommands(trie: CommandTrie, ctx: HuaweiShellContext): void {
  const dhcpExtra = () => {
    const router = ctx.r();
    const ext = (router as any)._dhcpInterfaceExtras ||
      ((router as any)._dhcpInterfaceExtras = new Map<string, any>());
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return null;
    let entry = ext.get(ifName);
    if (!entry) { entry = {}; ext.set(ifName, entry); }
    return entry;
  };

  trie.registerGreedy('dhcp server dns-list', 'DNS servers for interface DHCP', (args) => {
    const e = dhcpExtra(); if (e) e.dnsList = [...args];
    return '';
  });
  trie.registerGreedy('dhcp server lease', 'Set lease (day H hour M minute)', (args) => {
    const e = dhcpExtra(); if (!e) return '';
    let days = 0, hours = 0, mins = 0;
    for (let i = 0; i < args.length; i++) {
      const kw = args[i].toLowerCase();
      if (kw === 'day' && args[i + 1]) { days = parseInt(args[++i], 10) || 0; }
      else if (kw === 'hour' && args[i + 1]) { hours = parseInt(args[++i], 10) || 0; }
      else if (kw === 'minute' && args[i + 1]) { mins = parseInt(args[++i], 10) || 0; }
    }
    e.leaseSec = days * 86400 + hours * 3600 + mins * 60 || 86400;
    return '';
  });
  trie.registerGreedy('dhcp server excluded-ip-address', 'Exclude IP range', (args) => {
    if (args.length < 1) return '';
    ctx.r()._getDHCPServerInternal().addExcludedRange(args[0], args[1] || args[0]);
    return '';
  });
  trie.registerGreedy('dhcp server static-bind', 'Static bind IP↔MAC (ip-address X mac-address Y)', (args) => {
    let ip = ''; let mac = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === 'ip-address' && args[i + 1]) ip = args[++i];
      else if (a === 'mac-address' && args[i + 1]) mac = args[++i];
    }
    const e = dhcpExtra();
    if (e && ip && mac) (e.staticBindings ??= []).push({ ip, mac });
    return '';
  });
  trie.register('dhcp relay information enable', 'Enable DHCP relay option-82', () => {
    const e = dhcpExtra(); if (e) e.relayInfoEnabled = true;
    return '';
  });
  trie.registerGreedy('dhcp relay information strategy', 'Option-82 strategy (drop/keep/replace)', (args) => {
    const e = dhcpExtra(); if (e && args[0]) e.relayInfoStrategy = args[0].toLowerCase();
    return '';
  });
  trie.register('dhcp snooping trusted', 'Mark interface as DHCP snooping trusted', () => {
    const e = dhcpExtra(); if (e) e.snoopingTrusted = true;
    return '';
  });
  trie.register('dhcp snooping check dhcp-rate enable', 'Enable DHCP rate-limit', () => {
    const e = dhcpExtra(); if (e) e.snoopingRateCheck = true;
    return '';
  });
  trie.registerGreedy('dhcp snooping check dhcp-rate', 'Set DHCP rate-limit (pps)', (args) => {
    const e = dhcpExtra(); const n = parseInt(args[0] ?? '', 10);
    if (e && !isNaN(n)) e.snoopingRateLimit = n;
    return '';
  });
  trie.registerGreedy('dhcpv6 server', 'Assign DHCPv6 pool to interface', (args) => {
    const e = dhcpExtra(); if (e && args[0]) e.dhcpv6PoolRef = args[0];
    return '';
  });
}

export function registerDhcpv6SystemCommands(trie: CommandTrie, ctx: HuaweiShellContext): void {
  const v6 = () => {
    const router = ctx.r();
    return (router as any)._dhcpv6Pools ?? ((router as any)._dhcpv6Pools = new Map<string, any>());
  };
  trie.registerGreedy('dhcpv6 pool', 'Create DHCPv6 pool', (args) => {
    if (!args[0]) return '';
    const pools = v6();
    if (!pools.has(args[0])) pools.set(args[0], { name: args[0] });
    (ctx as any)._dhcpv6Selected = args[0];
    return '';
  });
  trie.registerGreedy('address prefix', 'DHCPv6 pool address prefix', (args) => {
    const p = (v6().get((ctx as any)._dhcpv6Selected));
    if (p && args[0]) p.prefix = args[0];
    return '';
  });
  trie.registerGreedy('dns-server', 'DHCPv6 DNS server', (args) => {
    const p = (v6().get((ctx as any)._dhcpv6Selected));
    if (p && args[0]) (p.dnsServers ??= []).push(args[0]);
    return '';
  });
  trie.registerGreedy('dns-domain-name', 'DHCPv6 domain-name', (args) => {
    const p = (v6().get((ctx as any)._dhcpv6Selected));
    if (p && args[0]) p.domainName = args[0];
    return '';
  });
}

// ─── DHCP Pool Mode Commands (register on pool trie) ────────────────

export function buildDhcpPoolCommands(trie: CommandTrie, ctx: HuaweiShellContext): void {
  const getRouter = () => ctx.r();

  trie.registerGreedy('gateway-list', 'Set default gateway', (args) => {
    if (args.length < 1 || !ctx.getSelectedPool()) return 'Error: Incomplete command.';
    getRouter()._getDHCPServerInternal().configurePoolRouter(ctx.getSelectedPool()!, args[0]);
    return '';
  });

  trie.registerGreedy('network', 'Set pool network range', (args) => {
    if (args.length < 1 || !ctx.getSelectedPool()) return 'Error: Incomplete command.';
    const network = args[0];
    let mask = '255.255.255.0';
    if (args.length >= 3 && args[1].toLowerCase() === 'mask') {
      mask = args[2];
    } else if (args.length >= 2) {
      mask = args[1];
    }
    getRouter()._getDHCPServerInternal().configurePoolNetwork(ctx.getSelectedPool()!, network, mask);
    return '';
  });

  trie.registerGreedy('dns-list', 'Set DNS server list', (args) => {
    if (args.length < 1 || !ctx.getSelectedPool()) return 'Error: Incomplete command.';
    getRouter()._getDHCPServerInternal().configurePoolDNS(ctx.getSelectedPool()!, args);
    return '';
  });

  trie.registerGreedy('excluded-ip-address', 'Exclude IP range from pool', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const start = args[0];
    const end = args[1] || start;
    getRouter()._getDHCPServerInternal().addExcludedRange(start, end);
    return '';
  });

  trie.registerGreedy('lease', 'Set lease duration (lease day D [hour H] [minute M])', (args) => {
    if (!ctx.getSelectedPool()) return 'Error: No DHCP pool selected.';
    let days = 0, hours = 0, minutes = 0;
    for (let i = 0; i < args.length; i++) {
      const kw = args[i].toLowerCase();
      if (kw === 'day' && args[i + 1]) { days = parseInt(args[++i], 10) || 0; }
      else if (kw === 'hour' && args[i + 1]) { hours = parseInt(args[++i], 10) || 0; }
      else if (kw === 'minute' && args[i + 1]) { minutes = parseInt(args[++i], 10) || 0; }
    }
    const seconds = days * 86400 + hours * 3600 + minutes * 60;
    getRouter()._getDHCPServerInternal().configurePoolLease(ctx.getSelectedPool()!, seconds || 86400);
    return '';
  });

  trie.registerGreedy('domain-name', 'Set domain name for DHCP clients', (args) => {
    if (args.length < 1 || !ctx.getSelectedPool()) return 'Error: Incomplete command.';
    getRouter()._getDHCPServerInternal().configurePoolDomain(ctx.getSelectedPool()!, args[0]);
    return '';
  });

  trie.registerGreedy('denied-mac', 'Deny DHCP by MAC address', (args) => {
    if (args.length < 1 || !ctx.getSelectedPool()) return 'Error: Incomplete command.';
    const pool = getRouter()._getDHCPServerInternal().getPool(ctx.getSelectedPool()!);
    if (pool) pool.denyPatterns.push(args[0]);
    return '';
  });

  trie.registerGreedy('netbios-type', 'Set NetBIOS node type (b/p/m/h)', (args) => {
    if (args.length < 1 || !ctx.getSelectedPool()) return '';
    const code = args[0].toLowerCase();
    const map: Record<string, string> = { 'b-node': 'b-node', 'p-node': 'p-node', 'm-node': 'm-node', 'h-node': 'h-node' };
    const node = map[code] || code;
    getRouter()._getDHCPServerInternal().configurePoolNetbiosNodeType(ctx.getSelectedPool()!, node);
    return '';
  });

  trie.registerGreedy('nbns-list', 'Set NetBIOS name servers', (args) => {
    if (args.length < 1 || !ctx.getSelectedPool()) return '';
    getRouter()._getDHCPServerInternal().configurePoolNetbios(ctx.getSelectedPool()!, args);
    return '';
  });

  trie.registerGreedy('option', 'Set DHCP option (option N sub-option K [ascii|ip-address|hex] V)', (args) => {
    if (!ctx.getSelectedPool() || args.length < 1) return '';
    const code = parseInt(args[0], 10);
    if (isNaN(code)) return '';
    let kind: 'ip' | 'ascii' | 'hex' = 'hex';
    let value = '';
    for (let i = 1; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === 'sub-option' || a === 'sub') { i++; continue; }
      if (a === 'ascii') { kind = 'ascii'; value = args.slice(i + 1).join(' '); break; }
      if (a === 'ip-address' || a === 'ip') { kind = 'ip'; value = args.slice(i + 1).join(' '); break; }
      if (a === 'hex') { kind = 'hex'; value = args.slice(i + 1).join(' '); break; }
    }
    if (!value) value = args.slice(1).join(' ');
    getRouter()._getDHCPServerInternal().configurePoolOption(ctx.getSelectedPool()!, code, kind, value);
    return '';
  });

  trie.registerGreedy('static-bind', 'Statically bind MAC ↔ IP (static-bind ip-address X mac-address Y)', (args) => {
    if (!ctx.getSelectedPool()) return '';
    let ip = ''; let mac = '';
    for (let i = 0; i < args.length; i++) {
      const a = args[i].toLowerCase();
      if (a === 'ip-address' && args[i + 1]) { ip = args[++i]; }
      else if (a === 'mac-address' && args[i + 1]) { mac = args[++i]; }
    }
    if (ip && mac) getRouter()._getDHCPServerInternal().addStaticBinding(ctx.getSelectedPool()!, mac, ip);
    return '';
  });
}

// ─── DHCP Display Commands ───────────────────────────────────────────

export function registerDhcpDisplayCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('display dhcp-server binding all', 'Display all DHCP bindings', () =>
    getRouter()._getDHCPServerInternal().formatBindingsShow());

  trie.register('display dhcp statistics', 'Display DHCP server statistics', () =>
    getRouter()._getDHCPServerInternal().formatStatsShow());

  trie.register('display dhcp-snooping user-bind all', 'Display DHCP snooping bindings', () =>
    'DHCP Snooping dynamic binding: 0 entries');

  trie.register('display dhcp server forbidden-ip', 'Display DHCP excluded addresses', () =>
    getRouter()._getDHCPServerInternal().formatExcludedShow());

  trie.register('display dhcp server conflict all', 'Display DHCP server address conflicts', () =>
    getRouter()._getDHCPServerInternal().formatConflictShow());

  trie.registerGreedy('display dhcp server interface', 'Display interface DHCP server config', (args) => {
    if (!args[0]) return '';
    const ext = (getRouter() as any)._dhcpInterfaceExtras as Map<string, any> | undefined;
    const e = ext?.get(args[0]);
    if (!e) return `No DHCP server config on interface ${args[0]}.`;
    const lines = [`DHCP server on ${args[0]}:`];
    if (e.dnsList) lines.push(`  DNS: ${e.dnsList.join(', ')}`);
    if (e.leaseSec !== undefined) lines.push(`  Lease: ${e.leaseSec}s`);
    if (e.staticBindings) for (const b of e.staticBindings) lines.push(`  Static: ${b.ip} ↔ ${b.mac}`);
    if (e.relayInfoEnabled) lines.push(`  Relay info option-82: enabled${e.relayInfoStrategy ? ' strategy ' + e.relayInfoStrategy : ''}`);
    return lines.join('\n');
  });

  trie.registerGreedy('display dhcp snooping interface', 'Display interface DHCP snooping config', (args) => {
    if (!args[0]) return '';
    const ext = (getRouter() as any)._dhcpInterfaceExtras as Map<string, any> | undefined;
    const e = ext?.get(args[0]);
    if (!e) return `DHCP snooping not configured on ${args[0]}.`;
    const lines = [`DHCP snooping on ${args[0]}:`];
    if (e.snoopingTrusted) lines.push(`  Trusted: yes`);
    if (e.snoopingRateCheck) lines.push(`  Rate check: enabled`);
    if (e.snoopingRateLimit) lines.push(`  Rate limit: ${e.snoopingRateLimit} pps`);
    return lines.join('\n');
  });

  trie.register('display dhcpv6 pool', 'Display DHCPv6 pools', () => {
    const pools = (getRouter() as any)._dhcpv6Pools as Map<string, any> | undefined;
    if (!pools || pools.size === 0) return 'No DHCPv6 pools configured.';
    const lines: string[] = [];
    for (const [, p] of pools) {
      lines.push(`Pool name: ${p.name}`);
      if (p.prefix) lines.push(`  Prefix: ${p.prefix}`);
      if (p.dnsServers) lines.push(`  DNS: ${p.dnsServers.join(', ')}`);
      if (p.domainName) lines.push(`  Domain: ${p.domainName}`);
    }
    return lines.join('\n');
  });

  trie.register('display dhcpv6 server', 'Display DHCPv6 server status', () => {
    const pools = (getRouter() as any)._dhcpv6Pools as Map<string, any> | undefined;
    const ext = (getRouter() as any)._dhcpInterfaceExtras as Map<string, any> | undefined;
    const lines = [`DHCPv6 server: ${pools && pools.size > 0 ? 'enabled' : 'disabled'}`];
    if (ext) {
      for (const [name, e] of ext) {
        if (e.dhcpv6PoolRef) lines.push(`  ${name}: pool ${e.dhcpv6PoolRef}`);
      }
    }
    return lines.join('\n');
  });
}

// ─── DHCP Debug Commands ─────────────────────────────────────────────

export function registerDhcpDebugCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.register('debugging dhcp server packet', 'Enable DHCP server packet debugging', () => {
    getRouter()._getDHCPServerInternal().setDebugServerPacket(true);
    return '';
  });

  trie.register('debugging dhcp server events', 'Enable DHCP server event debugging', () => {
    getRouter()._getDHCPServerInternal().setDebugServerEvents(true);
    return '';
  });

  trie.register('undo debugging dhcp server packet', 'Disable DHCP server packet debugging', () => {
    getRouter()._getDHCPServerInternal().setDebugServerPacket(false);
    return '';
  });

  trie.register('undo debugging dhcp server events', 'Disable DHCP server event debugging', () => {
    getRouter()._getDHCPServerInternal().setDebugServerEvents(false);
    return '';
  });

  trie.register('reset ip dhcp binding all', 'Clear all DHCP bindings', () => {
    getRouter()._getDHCPServerInternal().clearBindings();
    return '';
  });

  trie.register('reset ip dhcp statistics', 'Clear DHCP statistics', () => {
    getRouter()._getDHCPServerInternal().clearStats();
    return '';
  });
}
