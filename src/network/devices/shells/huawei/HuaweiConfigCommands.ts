/**
 * HuaweiConfigCommands - Extracted config command implementations for Huawei VRP CLI
 *
 * Handles:
 *   - ip route-static / ip pool commands
 *   - arp static commands
 *   - rip commands
 *   - undo commands
 *   - Interface mode commands
 *
 * Also provides buildSystemCommands() / buildInterfaceCommands() for CommandTrie wiring.
 */

import { IPAddress, SubnetMask, MACAddress } from '../../../core/types';
import type { Router } from '../../Router';
import type { CommandTrie } from '../CommandTrie';
import { resolveHuaweiInterfaceName } from './HuaweiDisplayCommands';

// ─── Shell Context Interface ─────────────────────────────────────────

export type HuaweiShellMode = 'user' | 'system' | 'interface' | 'dhcp-pool' | 'ospf' | 'ospf-area';

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

export function cmdIpRouteStatic(router: Router, args: string[]): string {
  if (args.length < 3) return 'Error: Incomplete command.';
  try {
    const network = new IPAddress(args[0]);
    const mask = new SubnetMask(args[1]);
    const nextHop = new IPAddress(args[2]);

    // Parse optional preference (priority) and tag
    let priority = 60; // Huawei default preference for static routes
    for (let i = 3; i < args.length; i++) {
      if (args[i] === 'preference' && args[i + 1]) {
        priority = parseInt(args[i + 1], 10);
        i++;
      } else if (args[i] === 'tag' && args[i + 1]) {
        i++;
      }
    }

    if (args[0] === '0.0.0.0' && args[1] === '0.0.0.0') {
      return router.setDefaultRoute(nextHop, priority) ? '' : 'Error: Next-hop is not reachable';
    }
    return router.addStaticRoute(network, mask, nextHop, priority) ? '' : 'Error: Next-hop is not reachable';
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

export function cmdIpPool(router: Router, ctx: HuaweiShellContext, poolName: string): string {
  const dhcp = router._getDHCPServerInternal();
  if (!dhcp.getPool(poolName)) {
    dhcp.createPool(poolName);
  }
  ctx.setSelectedPool(poolName);
  ctx.setMode('dhcp-pool');
  return '';
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

// ─── Interface Mode Commands (individual handlers) ──────────────────

function cmdShutdown(router: Router, ctx: HuaweiShellContext): string {
  const port = router.getPort(ctx.getSelectedInterface()!);
  if (port) port.setUp(false);
  return '';
}

function cmdUndoShutdown(router: Router, ctx: HuaweiShellContext): string {
  const port = router.getPort(ctx.getSelectedInterface()!);
  if (port) port.setUp(true);
  return '';
}

function cmdIpAddress(router: Router, ctx: HuaweiShellContext, args: string[]): string {
  if (args.length < 2) return 'Error: Incomplete command.';
  try {
    const ip = new IPAddress(args[0]);
    const mask = new SubnetMask(args[1]);
    router.configureInterface(ctx.getSelectedInterface()!, ip, mask);
    return '';
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function cmdDhcpSelectGlobal(ctx: HuaweiShellContext): string {
  ctx.getDhcpSelectGlobal().add(ctx.getSelectedInterface()!);
  return '';
}

// ─── Trie Builders ──────────────────────────────────────────────────

/**
 * Register system-view commands on a CommandTrie.
 */
export function buildSystemCommands(trie: CommandTrie, ctx: HuaweiShellContext): void {
  const getRouter = () => ctx.r();

  trie.registerGreedy('sysname', 'Set device name', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    getRouter()._setHostnameInternal(args[0]);
    return '';
  });

  trie.registerGreedy('interface', 'Enter interface view', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const portName = resolveHuaweiInterfaceName(getRouter(), args.join(''));
    if (!portName) return `Error: Wrong parameter found at '^' position.`;
    ctx.setSelectedInterface(portName);
    ctx.setMode('interface');
    return '';
  });

  trie.registerGreedy('ip route-static', 'Configure static route', (args) => {
    return cmdIpRouteStatic(getRouter(), args);
  });

  trie.registerGreedy('ip pool', 'Enter DHCP pool view', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    return cmdIpPool(getRouter(), ctx, args[0]);
  });

  trie.registerGreedy('undo', 'Undo configuration', (args) => {
    return cmdUndo(getRouter(), ctx, args);
  });

  trie.registerGreedy('rip', 'Configure RIP routing', (args) => {
    return cmdRip(getRouter(), args);
  });

  trie.registerGreedy('arp static', 'Configure static ARP entry', (args) => {
    if (args.length < 2) return 'Error: Incomplete command.';
    return cmdArpStatic(getRouter(), args[0], args[1]);
  });
}

/**
 * Register interface-view commands on a CommandTrie.
 */
export function buildInterfaceCommands(trie: CommandTrie, ctx: HuaweiShellContext): void {
  const getRouter = () => ctx.r();

  trie.registerGreedy('ip address', 'Configure IP address', (args) => {
    return cmdIpAddress(getRouter(), ctx, args);
  });

  trie.register('shutdown', 'Shutdown interface', () => {
    return cmdShutdown(getRouter(), ctx);
  });

  trie.register('undo shutdown', 'Enable interface', () => {
    return cmdUndoShutdown(getRouter(), ctx);
  });

  trie.registerGreedy('undo', 'Undo configuration', (args) => {
    return cmdUndo(getRouter(), ctx, args);
  });

  trie.register('dhcp select global', 'Enable DHCP on interface', () => {
    return cmdDhcpSelectGlobal(ctx);
  });

  trie.register('dhcp snooping enable', 'Enable DHCP snooping on interface', () => '');
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
