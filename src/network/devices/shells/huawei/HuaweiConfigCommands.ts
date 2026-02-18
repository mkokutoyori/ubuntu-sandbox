/**
 * HuaweiConfigCommands - Extracted config command implementations for Huawei VRP CLI
 *
 * Handles:
 *   - ip route-static / ip pool commands
 *   - arp static commands
 *   - rip commands
 *   - undo commands
 *   - Interface mode commands
 */

import { IPAddress, SubnetMask, MACAddress } from '../../../core/types';
import type { Router } from '../../Router';

// ─── Shell Context Interface ─────────────────────────────────────────

export type HuaweiShellMode = 'user' | 'system' | 'interface' | 'dhcp-pool';

export interface HuaweiShellContext {
  r(): Router;
  setMode(mode: HuaweiShellMode): void;
  getSelectedInterface(): string | null;
  setSelectedInterface(iface: string | null): void;
  getSelectedPool(): string | null;
  setSelectedPool(pool: string | null): void;
  getDhcpSelectGlobal(): Set<string>;
}

// ─── IP Command ──────────────────────────────────────────────────────

export function cmdIp(router: Router, ctx: HuaweiShellContext, args: string[]): string {
  if (args.length === 0) return 'Error: Incomplete command.';

  // ip route-static <network> <mask> <next-hop> [preference <priority>] [tag <tag>]
  if (args.length >= 4 && args[0] === 'route-static') {
    try {
      const network = new IPAddress(args[1]);
      const mask = new SubnetMask(args[2]);
      const nextHop = new IPAddress(args[3]);

      // Parse optional preference (priority) and tag
      let priority = 60; // Huawei default preference for static routes
      for (let i = 4; i < args.length; i++) {
        if (args[i] === 'preference' && args[i + 1]) {
          priority = parseInt(args[i + 1], 10);
          i++;
        } else if (args[i] === 'tag' && args[i + 1]) {
          i++;
        }
      }

      if (args[1] === '0.0.0.0' && args[2] === '0.0.0.0') {
        return router.setDefaultRoute(nextHop, priority) ? '' : 'Error: Next-hop is not reachable';
      }
      return router.addStaticRoute(network, mask, nextHop, priority) ? '' : 'Error: Next-hop is not reachable';
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  // ip pool <name> → enter DHCP pool configuration
  if (args.length >= 2 && args[0] === 'pool') {
    const poolName = args[1];
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

// ─── ARP Static Command ─────────────────────────────────────────────

export function cmdArpStatic(router: Router, ip: string, mac: string): string {
  const normalizedMAC = normalizeMAC(mac);
  const arpTable = router._getArpTableInternal();
  arpTable.set(ip, {
    mac: new MACAddress(normalizedMAC),
    iface: '',
    timestamp: Date.now(),
    type: 'static',
  } as any);
  return '';
}

// ─── RIP Command ─────────────────────────────────────────────────────

export function cmdRip(router: Router, args: string[]): string {
  if (!router.isRIPEnabled()) {
    router.enableRIP();
  }

  if (args.length >= 2 && args[0] === 'network') {
    try {
      const network = new IPAddress(args[1]);
      const mask = args.length >= 3 ? new SubnetMask(args[2]) : classfulMask(network);
      router.ripAdvertiseNetwork(network, mask);
      return '';
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  return '';
}

// ─── Undo Command ────────────────────────────────────────────────────

export function cmdUndo(router: Router, ctx: HuaweiShellContext, args: string[]): string {
  if (args.length < 1) return 'Error: Incomplete command.';

  if (args[0] === 'rip') {
    router.disableRIP();
    return '';
  }

  // undo ip route-static <network> <mask> <next-hop>
  if (args[0] === 'ip' && args.length >= 5 && args[1] === 'route-static') {
    try {
      const network = new IPAddress(args[2]);
      const mask = new SubnetMask(args[3]);
      const nextHop = new IPAddress(args[4]);

      const table = router._getRoutingTableInternal();
      const idx = table.findIndex(r =>
        (r.type === 'static' || r.type === 'default') &&
        r.network.equals(network) &&
        r.mask.toCIDR() === mask.toCIDR() &&
        r.nextHop?.equals(nextHop)
      );
      if (idx >= 0) {
        table.splice(idx, 1);
        return '';
      }
      return 'Error: Route not found.';
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  // undo arp static <ip>
  if (args[0] === 'arp' && args.length >= 3 && args[1] === 'static') {
    const arpTable = router._getArpTableInternal();
    if (arpTable.has(args[2])) {
      arpTable.delete(args[2]);
      return '';
    }
    return 'Error: ARP entry not found.';
  }

  // undo shutdown (in interface mode)
  if (args[0] === 'shutdown' && ctx.getSelectedInterface()) {
    const port = router.getPort(ctx.getSelectedInterface()!);
    if (port) port.setUp(true);
    return '';
  }

  return `Error: Unrecognized command "undo ${args.join(' ')}"`;
}

// ─── Interface Mode Commands ─────────────────────────────────────────

export function executeInterfaceMode(router: Router, ctx: HuaweiShellContext, input: string): string {
  const parts = input.split(/\s+/);
  const lower = input.toLowerCase();

  if (lower === 'shutdown') {
    const port = router.getPort(ctx.getSelectedInterface()!);
    if (port) port.setUp(false);
    return '';
  }

  if (lower === 'undo shutdown') {
    const port = router.getPort(ctx.getSelectedInterface()!);
    if (port) port.setUp(true);
    return '';
  }

  // ip address <ip> <mask>
  if (parts[0].toLowerCase() === 'ip' && parts.length >= 4 && parts[1].toLowerCase() === 'address') {
    try {
      const ip = new IPAddress(parts[2]);
      const mask = new SubnetMask(parts[3]);
      router.configureInterface(ctx.getSelectedInterface()!, ip, mask);
      return '';
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  // dhcp select global
  if (lower === 'dhcp select global') {
    ctx.getDhcpSelectGlobal().add(ctx.getSelectedInterface()!);
    return '';
  }

  // dhcp snooping enable (interface level)
  if (lower === 'dhcp snooping enable') {
    return '';
  }

  return null as any; // signal: not handled
}

// ─── Utility Functions ───────────────────────────────────────────────

export function normalizeMAC(mac: string): string {
  // Convert Huawei format aaaa-bbbb-cccc to aa:aa:bb:bb:cc:cc
  const cleaned = mac.replace(/-/g, '').replace(/:/g, '').replace(/\./g, '');
  if (cleaned.length === 12) {
    return cleaned.match(/.{2}/g)!.join(':');
  }
  return mac;
}

export function classfulMask(ip: IPAddress): SubnetMask {
  const firstOctet = ip.getOctets()[0];
  if (firstOctet < 128) return new SubnetMask('255.0.0.0');
  if (firstOctet < 192) return new SubnetMask('255.255.0.0');
  return new SubnetMask('255.255.255.0');
}
