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
