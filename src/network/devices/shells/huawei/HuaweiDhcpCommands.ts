/**
 * HuaweiDhcpCommands - Extracted DHCP command implementations for Huawei VRP CLI
 *
 * Handles:
 *   - dhcp enable / dhcp snooping enable (system mode)
 *   - dhcp server ip-pool (system mode)
 *   - DHCP pool configuration mode commands
 */

import type { Router } from '../../Router';
import type { HuaweiShellContext } from './HuaweiConfigCommands';

// ─── DHCP Command (system mode) ──────────────────────────────────────

export function cmdDhcp(
  router: Router,
  ctx: HuaweiShellContext,
  args: string[],
  setDhcpEnabled: (v: boolean) => void,
  setDhcpSnoopingEnabled: (v: boolean) => void,
): string {
  if (args.length === 0) return 'Error: Incomplete command.';
  const sub = args[0].toLowerCase();

  // dhcp enable
  if (sub === 'enable') {
    setDhcpEnabled(true);
    router._getDHCPServerInternal().enable();
    return '';
  }

  // dhcp snooping enable
  if (sub === 'snooping' && args.length >= 2 && args[1].toLowerCase() === 'enable') {
    setDhcpSnoopingEnabled(true);
    return '';
  }

  // dhcp server ip-pool <name> — alias for 'ip pool <name>'
  if (sub === 'server' && args.length >= 3 && args[1].toLowerCase() === 'ip-pool') {
    const poolName = args[2];
    const dhcp = router._getDHCPServerInternal();
    if (!dhcp.getPool(poolName)) {
      dhcp.createPool(poolName);
    }
    ctx.setSelectedPool(poolName);
    ctx.setMode('dhcp-pool');
    return '';
  }

  return 'Error: Incomplete command.';
}

// ─── DHCP Pool Mode Commands ─────────────────────────────────────────

export function executeDhcpPoolMode(router: Router, ctx: HuaweiShellContext, input: string): string {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const dhcp = router._getDHCPServerInternal();

  if (cmd === 'gateway-list') {
    if (parts.length < 2 || !ctx.getSelectedPool()) return 'Error: Incomplete command.';
    dhcp.configurePoolRouter(ctx.getSelectedPool()!, parts[1]);
    return '';
  }

  if (cmd === 'network') {
    if (parts.length < 2 || !ctx.getSelectedPool()) return 'Error: Incomplete command.';
    const network = parts[1];
    // mask can be keyword "mask" followed by mask, or just the mask
    let mask = '255.255.255.0';
    if (parts.length >= 4 && parts[2].toLowerCase() === 'mask') {
      mask = parts[3];
    } else if (parts.length >= 3) {
      mask = parts[2];
    }
    dhcp.configurePoolNetwork(ctx.getSelectedPool()!, network, mask);
    return '';
  }

  if (cmd === 'dns-list') {
    if (parts.length < 2 || !ctx.getSelectedPool()) return 'Error: Incomplete command.';
    dhcp.configurePoolDNS(ctx.getSelectedPool()!, parts.slice(1));
    return '';
  }

  return `Error: Unrecognized command "${input}"`;
}
