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

import { IPAddress, SubnetMask, MACAddress, IPv6Address } from '../../../core/types';
import type { Router } from '../../Router';
import type { CommandTrie } from '../CommandTrie';
import { resolveHuaweiInterfaceName } from './HuaweiDisplayCommands';

// ─── Shell Context Interface ─────────────────────────────────────────

export type HuaweiShellMode =
  | 'user' | 'system' | 'interface' | 'dhcp-pool' | 'ospf' | 'ospf-area'
  | 'bgp' | 'isis'
  | 'ospfv3' | 'rip' | 'ui' | 'ike-proposal' | 'ike-peer'
  | 'ipsec-proposal' | 'ipsec-policy'
  | 'acl-basic' | 'acl-advanced'
  | 'ikev2-proposal' | 'ikev2-policy' | 'ikev2-profile'
  | 'ikev2-keyring' | 'ikev2-keyring-peer'
  | 'route-policy' | 'traffic-classifier' | 'traffic-behavior' | 'traffic-policy'
  | 'nqa-test';

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

const HUAWEI_NULL_IFACE = /^(null0|null)$/i;
const HUAWEI_IFACE_PREFIX = /^(gigabitethernet|ge|ethernet|eth|serial|s|loopback|lo|tunnel|tu|vlanif|vlan)\d/i;

function looksLikeInterfaceName(token: string): boolean {
  return HUAWEI_NULL_IFACE.test(token) || HUAWEI_IFACE_PREFIX.test(token);
}

export function cmdIpRouteStatic(router: Router, args: string[]): string {
  if (args.length < 3) return 'Error: Incomplete command.';
  try {
    let cursor = 0;
    let vpnInstance: string | undefined;
    if (args[cursor] === 'vpn-instance' && args[cursor + 1]) {
      vpnInstance = args[cursor + 1];
      cursor += 2;
    }
    if (args.length - cursor < 3) return 'Error: Incomplete command.';

    const network = new IPAddress(args[cursor]);
    const isDefault = args[cursor] === '0.0.0.0' && args[cursor + 1] === '0.0.0.0';

    const maskToken = args[cursor + 1];
    const mask = /^\d+$/.test(maskToken)
      ? SubnetMask.fromCIDR(parseInt(maskToken, 10))
      : new SubnetMask(maskToken);
    cursor += 2;

    const nhToken = args[cursor];
    cursor += 1;
    let nextHop: IPAddress | null = null;
    let ifaceName = '';
    if (HUAWEI_NULL_IFACE.test(nhToken)) {
      ifaceName = 'NULL0';
      nextHop = new IPAddress('0.0.0.0');
    } else if (looksLikeInterfaceName(nhToken)) {
      const resolved = resolveHuaweiInterfaceName(router, nhToken) || nhToken;
      ifaceName = resolved;
      nextHop = new IPAddress('0.0.0.0');
      if (cursor < args.length && /^\d+\.\d+\.\d+\.\d+$/.test(args[cursor])) {
        nextHop = new IPAddress(args[cursor]);
        cursor += 1;
      }
    } else {
      nextHop = new IPAddress(nhToken);
    }

    let preference: number | undefined;
    let tag: number | undefined;
    let description: string | undefined;
    let track: string | undefined;
    let permanent = false;
    for (let i = cursor; i < args.length; i++) {
      const tok = args[i];
      if (tok === 'preference' && args[i + 1]) { preference = parseInt(args[++i], 10); }
      else if (tok === 'tag' && args[i + 1]) { tag = parseInt(args[++i], 10); }
      else if (tok === 'description' && args[i + 1]) {
        description = args.slice(i + 1).join(' '); i = args.length;
      } else if (tok === 'track' && args[i + 1]) {
        const parts: string[] = [];
        while (i + 1 < args.length && !['preference', 'tag', 'description', 'permanent'].includes(args[i + 1])) {
          parts.push(args[++i]);
        }
        track = parts.join(' ');
      } else if (tok === 'permanent') {
        permanent = true;
      }
    }

    const opts = { preference, tag, description, track, vpnInstance, permanent, iface: ifaceName || undefined };
    if (isDefault) {
      return router.setDefaultRoute(nextHop!, 0, { preference, tag, description, iface: ifaceName || undefined })
        ? '' : 'Error: Next-hop is not reachable';
    }
    return router.addStaticRoute(network, mask, nextHop!, 0, opts)
      ? '' : 'Error: Next-hop is not reachable';
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

  // `undo stelnet server enable` — disables the SSH server admin flag
  // so a subsequent ssh attempt is refused by the SshExecTarget gate.
  if (args[0] === 'stelnet' && args[1] === 'server' && (args[2] === 'enable' || args[2] === undefined)) {
    router._setSshServerEnabled(false);
    return '';
  }

  if (args[0] === 'local-user' && args[1]) {
    router._removeLocalUser(args[1]);
    return '';
  }

  if (args[0] === 'dhcp' && args[1] === 'enable') {
    router._getDHCPServerInternal().disable();
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

  if (args[0] === 'ipv6' && args[1] === 'route-static' && args.length >= 5) {
    try {
      const prefix = new IPv6Address(args[2]);
      const prefixLen = parseInt(args[3], 10);
      const nhToken = args[4];
      const table = (router as any)._getIPv6RoutingTableInternal?.() as any[] | undefined;
      if (!table) return '';
      const idx = table.findIndex((r: any) =>
        (r.type === 'static' || r.type === 'default') &&
        r.prefixLength === prefixLen &&
        r.prefix.toString() === prefix.getNetworkPrefix(prefixLen).toString() &&
        (
          HUAWEI_NULL_IFACE.test(nhToken) ? r.iface === 'NULL0'
          : looksLikeInterfaceName(nhToken) ? r.iface.toLowerCase().startsWith(nhToken.toLowerCase())
          : r.nextHop?.toString() === nhToken
        )
      );
      if (idx >= 0) { table.splice(idx, 1); return ''; }
      return 'Error: Route not found.';
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }

  if (args[0] === 'arp') {
    let ip: string;
    if (args[1] === 'static' && args.length >= 3) {
      ip = args[2];
    } else if (args.length >= 2) {
      ip = args[1];
    } else {
      return 'Error: Incomplete command.';
    }
    router._deleteARP(ip);
    return '';
  }

  if (args[0] === 'shutdown' && ctx.getSelectedInterface()) {
    const port = router.getPort(ctx.getSelectedInterface()!);
    if (port) port.setUp(true);
    return '';
  }

  const head = args[0];
  const GLOBAL_TOGGLES = new Set([
    'snmp-agent', 'ftp', 'telnet', 'http', 'info-center',
    'ntp-service', 'lldp', 'sftp', 'dhcp', 'ssh',
    'cdp', 'lldp-mdn', 'arp-proxy', 'icmp',
  ]);
  if (GLOBAL_TOGGLES.has(head)) {
    router._undoGlobalToggle?.(args.join(' '));
    return '';
  }
  if (head === 'sysname') {
    router._setHostnameInternal('Huawei');
    return '';
  }
  if (head === 'ip' && args[1] === 'routing-table' && args[2] === 'limit') {
    return '';
  }
  if (head === 'terminal' && args[1] === 'monitor') {
    return '';
  }
  if (head === 'header') {
    (router as any)._setSshBanner?.('');
    return '';
  }
  if (head === 'ip' && args[1] === 'pool' && args[2]) {
    router._getDHCPServerInternal().deletePool?.(args[2]);
    return '';
  }
  if (head === 'description') {
    if (ctx.getSelectedInterface()) router.setInterfaceDescription(ctx.getSelectedInterface()!, '');
    return '';
  }
  if (head === 'ipv6' && args.length === 1) {
    router.disableIPv6Routing();
    return '';
  }

  return '';
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
    const raw = args.join('');
    let portName = resolveHuaweiInterfaceName(getRouter(), raw);
    if (!portName) {
      const vMatch = raw.match(/^(loopback|tunnel)([\d]+)$/i);
      if (vMatch) {
        const typeMap: Record<string, string> = { 'loopback': 'LoopBack', 'tunnel': 'Tunnel' };
        const fullName = `${typeMap[vMatch[1].toLowerCase()]}${vMatch[2]}`;
        getRouter()._createVirtualInterface(fullName);
        portName = fullName;
      }
      if (!portName) return `Error: Wrong parameter found at '^' position.`;
    }
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

  trie.registerGreedy('undo ip route-static', 'Remove a static route', (args) => {
    return cmdUndo(getRouter(), ctx, ['ip', 'route-static', ...args]);
  });

  trie.registerGreedy('undo ipv6 route-static', 'Remove an IPv6 static route', (args) => {
    return cmdUndo(getRouter(), ctx, ['ipv6', 'route-static', ...args]);
  });

  trie.registerGreedy('rip', 'Enter RIP view or configure RIP', (args) => {
    if (!getRouter().isRIPEnabled()) {
      getRouter().enableRIP();
    }
    if (args.length >= 1 && !isNaN(parseInt(args[0], 10))) {
      ctx.setMode('rip' as any);
      return '';
    }
    return cmdRip(getRouter(), args);
  });

  trie.registerGreedy('arp static', 'Configure static ARP entry', (args) => {
    if (args.length < 2) return 'Error: Incomplete command.';
    return cmdArpStatic(getRouter(), args[0], args[1]);
  });

  // ip routing — Huawei equivalent of Cisco's "ip routing" (routing is enabled by default)
  trie.register('ip routing', 'Enable IP routing', () => {
    return '';
  });

  // IPv6 global enable
  trie.register('ipv6', 'Enable IPv6', () => {
    getRouter().enableIPv6Routing();
    return '';
  });

  trie.register('undo ipv6', 'Disable IPv6', () => {
    getRouter().disableIPv6Routing();
    return '';
  });

  trie.registerGreedy('ipv6 route-static', 'Configure IPv6 static route', (args) => {
    if (args.length < 3) return 'Error: Incomplete command.';
    try {
      const prefix = new IPv6Address(args[0]);
      const prefixLen = parseInt(args[1], 10);
      if (isNaN(prefixLen)) return 'Error: Invalid prefix length';
      const nhToken = args[2];
      let nextHop: IPv6Address;
      let ifaceName: string | undefined;
      let cursor = 3;
      if (HUAWEI_NULL_IFACE.test(nhToken)) {
        ifaceName = 'NULL0';
        nextHop = new IPv6Address('::');
      } else if (looksLikeInterfaceName(nhToken)) {
        ifaceName = resolveHuaweiInterfaceName(getRouter(), nhToken) || nhToken;
        nextHop = new IPv6Address('::');
        if (cursor < args.length && args[cursor].includes(':')) {
          nextHop = new IPv6Address(args[cursor]);
          cursor += 1;
        }
      } else {
        nextHop = new IPv6Address(nhToken);
      }
      let preference: number | undefined;
      for (let i = cursor; i < args.length; i++) {
        if (args[i] === 'preference' && args[i + 1]) { preference = parseInt(args[++i], 10); }
      }
      const isDefault = args[0] === '::' && prefixLen === 0;
      if (isDefault) {
        getRouter().setIPv6DefaultRoute(nextHop, 0, { iface: ifaceName, preference });
      } else {
        getRouter().addIPv6StaticRoute(prefix, prefixLen, nextHop, 0, { iface: ifaceName, preference });
      }
      return '';
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  });
}

/**
 * Register interface-view commands on a CommandTrie.
 */
export function buildInterfaceCommands(trie: CommandTrie, ctx: HuaweiShellContext): void {
  const getRouter = () => ctx.r();

  trie.registerGreedy('interface', 'Switch to another interface view', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    const raw = args.join('');
    let portName = resolveHuaweiInterfaceName(getRouter(), raw);
    if (!portName) {
      const vMatch = raw.match(/^(loopback|tunnel)([\d]+)$/i);
      if (vMatch) {
        const typeMap: Record<string, string> = { 'loopback': 'LoopBack', 'tunnel': 'Tunnel' };
        const fullName = `${typeMap[vMatch[1].toLowerCase()]}${vMatch[2]}`;
        getRouter()._createVirtualInterface(fullName);
        portName = fullName;
      }
      if (!portName) return `Error: Wrong parameter found at '^' position.`;
    }
    ctx.setSelectedInterface(portName);
    return '';
  });

  trie.registerGreedy('ip address', 'Configure IP address', (args) => {
    return cmdIpAddress(getRouter(), ctx, args);
  });

  trie.register('shutdown', 'Shutdown interface', () => {
    return cmdShutdown(getRouter(), ctx);
  });

  trie.register('undo shutdown', 'Enable interface', () => {
    return cmdUndoShutdown(getRouter(), ctx);
  });

  trie.registerGreedy('description', 'Set interface description', (args) => {
    if (!ctx.getSelectedInterface()) return 'Error: No interface selected';
    if (args.length < 1) return 'Error: Incomplete command.';
    getRouter().setInterfaceDescription(ctx.getSelectedInterface()!, args.join(' '));
    return '';
  });

  trie.register('undo description', 'Remove interface description', () => {
    if (!ctx.getSelectedInterface()) return 'Error: No interface selected';
    getRouter().setInterfaceDescription(ctx.getSelectedInterface()!, '');
    return '';
  });

  trie.registerGreedy('undo', 'Undo configuration', (args) => {
    return cmdUndo(getRouter(), ctx, args);
  });

  trie.register('dhcp select global', 'Enable DHCP on interface', () => {
    return cmdDhcpSelectGlobal(ctx);
  });

  trie.register('dhcp select relay', 'Set DHCP relay mode on interface', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected';
    const dhcp = getRouter()._getDHCPServerInternal() as unknown as { setInterfaceMode?: (i: string, m: string) => void };
    dhcp.setInterfaceMode?.(ifName, 'relay');
    return '';
  });

  trie.registerGreedy('dhcp relay server-ip', 'Set DHCP relay server address', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    if (!ctx.getSelectedInterface()) return 'Error: No interface selected';
    getRouter()._getDHCPServerInternal().addHelperAddress(ctx.getSelectedInterface()!, args[0]);
    return '';
  });

  trie.registerGreedy('ip helper-address', 'Set DHCP relay helper address', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    if (!ctx.getSelectedInterface()) return 'Error: No interface selected';
    getRouter()._getDHCPServerInternal().addHelperAddress(ctx.getSelectedInterface()!, args[0]);
    return '';
  });

  trie.registerGreedy('ip forward-protocol udp', 'Forward UDP port on interface', (args) => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return '';
    const port = parseInt(args[0] ?? '', 10);
    if (!isNaN(port)) {
      const dhcp = getRouter()._getDHCPServerInternal() as unknown as { addForwardProtocolPort?: (iface: string, port: number) => void };
      dhcp.addForwardProtocolPort?.(ifName, port);
    }
    return '';
  });

  trie.register('dhcp snooping enable', 'Enable DHCP snooping on interface', () => {
    const ifName = ctx.getSelectedInterface();
    if (!ifName) return 'Error: No interface selected';
    const dhcp = getRouter()._getDHCPServerInternal() as unknown as { setSnoopingEnabled?: (i: string, e: boolean) => void };
    dhcp.setSnoopingEnabled?.(ifName, true);
    return '';
  });

  // Tunnel interface commands
  trie.registerGreedy('source', 'Set tunnel source address', (args) => {
    if (args.length < 1 || !ctx.getSelectedInterface()) return 'Error: Incomplete command.';
    const ifName = ctx.getSelectedInterface()!;
    const extra = ctx.r()._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig.get(ifName) || {};
    (pending as any).tunnelSource = args[0];
    extra.pendingIfConfig.set(ifName, pending);
    return '';
  });

  trie.registerGreedy('destination', 'Set tunnel destination address', (args) => {
    if (args.length < 1 || !ctx.getSelectedInterface()) return 'Error: Incomplete command.';
    const ifName = ctx.getSelectedInterface()!;
    const extra = ctx.r()._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig.get(ifName) || {};
    (pending as any).tunnelDest = args[0];
    extra.pendingIfConfig.set(ifName, pending);
    return '';
  });

  trie.registerGreedy('tunnel-protocol', 'Set tunnel protocol', (_args) => {
    return '';
  });

  // IPv6 interface commands
  trie.register('ipv6 enable', 'Enable IPv6 on interface', () => {
    return '';
  });

  trie.registerGreedy('ipv6 address', 'Configure IPv6 address', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    if (!ctx.getSelectedInterface()) return 'Error: No interface selected';
    const addrStr = args[0];
    const slashIdx = addrStr.indexOf('/');
    if (slashIdx === -1) return 'Error: Invalid IPv6 address format (expected addr/prefix)';
    const addr = addrStr.substring(0, slashIdx);
    const prefixLen = parseInt(addrStr.substring(slashIdx + 1), 10);
    if (isNaN(prefixLen)) return 'Error: Invalid prefix length';
    try {
      const ipv6Addr = new IPv6Address(addr);
      getRouter().configureIPv6Interface(ctx.getSelectedInterface()!, ipv6Addr, prefixLen);
      return '';
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  });
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
