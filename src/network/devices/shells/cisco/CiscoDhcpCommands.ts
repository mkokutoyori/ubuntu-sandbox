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
    if (!ctx.getSelectedDHCPPool()) return '% No DHCP pool selected';
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
}

// ─── DHCP Show Commands (registered on user/privileged show tries) ───

export function registerDhcpShowCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.registerGreedy('show ip dhcp pool', 'Display DHCP pool information', (args) =>
    getRouter()._getDHCPServerInternal().formatPoolShow(args.length > 0 ? args[0] : undefined));
  trie.register('show ip dhcp binding', 'Display DHCP address bindings', () =>
    getRouter()._getDHCPServerInternal().formatBindingsShow());
  trie.register('show ip dhcp server statistics', 'Display DHCP server statistics', () =>
    getRouter()._getDHCPServerInternal().formatStatsShow());
  trie.register('show ip dhcp conflict', 'Display DHCP address conflicts', () =>
    getRouter()._getDHCPServerInternal().formatConflictShow());
  trie.register('show ip dhcp excluded-address', 'Display DHCP excluded addresses', () =>
    getRouter()._getDHCPServerInternal().formatExcludedShow());
  trie.register('show debug', 'Display debugging flags', () =>
    getRouter()._getDHCPServerInternal().formatDebugShow());
}

// ─── DHCP Privileged Commands (debug, clear) ─────────────────────────

export function registerDhcpPrivilegedCommands(trie: CommandTrie, getRouter: () => Router): void {
  // debug commands
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
}
