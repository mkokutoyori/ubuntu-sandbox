/**
 * HuaweiDhcpCommands - Extracted DHCP command implementations for Huawei VRP CLI
 *
 * Handles:
 *   - dhcp enable / dhcp snooping enable (system mode)
 *   - dhcp server ip-pool (system mode)
 *   - DHCP pool configuration mode commands
 *
 * Provides registerDhcpSystemCommands() and buildDhcpPoolCommands() for CommandTrie.
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
}
