/**
 * HuaweiDisplayCommands - Extracted display command implementations for Huawei VRP CLI
 *
 * Pure functions: Router → string (no side effects, no state mutation)
 * Used by HuaweiVRPShell for "display" commands.
 *
 * Also provides registerDisplayCommands() to wire them onto a CommandTrie.
 */

import type { Router } from '../../Router';
import type { CommandTrie } from '../CommandTrie';

// ─── Display State Accessor (passed from shell) ─────────────────────
export interface HuaweiDisplayState {
  isDhcpEnabled(): boolean;
  isDhcpSnoopingEnabled(): boolean;
  getDhcpSelectGlobal(): Set<string>;
}

// ─── Pure Display Functions ──────────────────────────────────────────

export function displayVersion(router: Router): string {
  return [
    'Huawei Versatile Routing Platform Software',
    'VRP (R) software, Version 5.170 (AR2220 V200R009C00SPC500)',
    'Copyright (C) 2000-2025 HUAWEI TECH CO., LTD',
    '',
    `BOARD TYPE:          AR2220`,
    `BootROM Version:     1.0`,
    `${router._getHostnameInternal()} uptime is 0 days, 0 hours, 0 minutes`,
  ].join('\n');
}

export function displayInterface(router: Router, ifName: string): string {
  const portName = resolveHuaweiInterfaceName(router, ifName) || ifName;
  const port = router.getPort(portName);
  if (!port) return `Error: Wrong parameter found at '^' position.`;

  const ip = port.getIPAddress();
  const mask = port.getSubnetMask();
  const isUp = port.getIsUp();
  const isConn = port.isConnected();

  return [
    `${portName} current state : ${isUp ? (isConn ? 'UP' : 'DOWN') : 'Administratively DOWN'}`,
    `Line protocol current state : ${isConn ? 'UP' : 'DOWN'}`,
    `Internet Address is ${ip && mask ? `${ip}/${mask}` : 'not configured'}`,
    `The Maximum Transmit Unit is 1500`,
    `Input:  0 packets, 0 bytes`,
    `Output: 0 packets, 0 bytes`,
  ].join('\n');
}

export function displayIpPool(router: Router, poolName: string): string {
  const dhcp = router._getDHCPServerInternal();
  const pool = dhcp.getPool(poolName);
  if (!pool) return `Error: Pool "${poolName}" does not exist.`;

  const lines = [
    `Pool-name      : ${pool.name}`,
    `Pool-No        : 0`,
    `Position       : Local`,
    `Status         : Unlocked`,
    `Gateway-list   : ${pool.defaultRouter || 'not configured'}`,
    `Network        : ${pool.network || 'not configured'}`,
    `Mask           : ${pool.mask || 'not configured'}`,
    `DNS-list       : ${pool.dnsServers.join(' ') || 'not configured'}`,
  ];
  return lines.join('\n');
}

export function displayIpRoutingTable(router: Router): string {
  const table = router.getRoutingTable();
  const destSet = new Set(table.map(r => `${r.network}/${r.mask}`));
  const lines = [
    'Route Flags: R - relay, D - download to fib',
    '------------------------------------------------------------------------------',
    'Routing Tables: Public',
    `         Destinations : ${destSet.size}        Routes : ${table.length}`,
    '',
    'Destination/Mask    Proto   Pre  Cost  Flags NextHop         Interface',
  ];

  for (const r of table) {
    const dest = `${r.network}/${r.mask}`.padEnd(20);
    const proto = (r.type === 'connected' ? 'Direct' : r.type === 'rip' ? 'RIP' : 'Static').padEnd(8);
    const pre = String(r.type === 'connected' ? 0 : r.type === 'rip' ? 100 : 60).padEnd(5);
    const cost = String(r.metric).padEnd(6);
    const flags = (r.type === 'connected' ? 'D' : 'RD').padEnd(6);
    const nh = r.nextHop ? r.nextHop.toString().padEnd(16) : r.type === 'connected' ? `${r.network}`.padEnd(16) : '0.0.0.0'.padEnd(16);
    lines.push(`${dest}${proto}${pre}${cost}${flags}${nh}${r.iface}`);
  }
  return lines.join('\n');
}

export function displayIpIntBrief(router: Router): string {
  const ports = router._getPortsInternal();
  const lines = ['Interface                         IP Address/Mask      Physical   Protocol'];
  for (const [name, port] of ports) {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const ipStr = ip && mask ? `${ip}/${mask}` : 'unassigned';
    const phys = port.isConnected() ? 'up' : 'down';
    const proto = port.isConnected() ? 'up' : 'down';
    lines.push(`${name.padEnd(34)}${ipStr.padEnd(21)}${phys.padEnd(11)}${proto}`);
  }
  return lines.join('\n');
}

export function displayArp(router: Router): string {
  const arpTable = router._getArpTableInternal();
  const lines = ['IP ADDRESS      MAC ADDRESS     EXPIRE(M)  TYPE      INTERFACE'];
  if (arpTable.size === 0) {
    lines.push('No ARP entries found.');
  }
  for (const [ip, entry] of arpTable) {
    const age = Math.floor((Date.now() - entry.timestamp) / 60000);
    const type = (entry as any).type === 'static' ? 'static' : 'D';
    lines.push(`${ip.padEnd(16)}${entry.mac.toString().padEnd(16)}${String(age).padEnd(11)}${type.padEnd(10)}${entry.iface}`);
  }
  return lines.join('\n');
}

export function displayCurrentConfig(
  router: Router,
  dhcpEnabled: boolean,
  dhcpSnoopingEnabled: boolean,
  dhcpSelectGlobal: Set<string>,
): string {
  const ports = router._getPortsInternal();
  const table = router._getRoutingTableInternal();
  const lines = [
    '#',
    `sysname ${router._getHostnameInternal()}`,
    '#',
  ];

  if (dhcpEnabled) {
    lines.push('dhcp enable');
    lines.push('#');
  }
  if (dhcpSnoopingEnabled) {
    lines.push('dhcp snooping enable');
    lines.push('#');
  }

  for (const [name, port] of ports) {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    lines.push(`interface ${name}`);
    if (ip && mask) {
      lines.push(` ip address ${ip} ${mask}`);
    } else {
      lines.push(` shutdown`);
    }
    if (dhcpSelectGlobal.has(name)) {
      lines.push(` dhcp select global`);
    }
    lines.push('#');
  }
  for (const r of table) {
    if (r.type === 'static' && r.nextHop) {
      lines.push(`ip route-static ${r.network} ${r.mask} ${r.nextHop}`);
    }
    if (r.type === 'default' && r.nextHop) {
      lines.push(`ip route-static 0.0.0.0 0.0.0.0 ${r.nextHop}`);
    }
  }
  // RIP config
  if (router.isRIPEnabled()) {
    lines.push('#');
    lines.push('rip 1');
    lines.push(' version 2');
    const cfg = router.getRIPConfig();
    for (const net of cfg.networks) {
      lines.push(` network ${net.network}`);
    }
  }
  lines.push('#');
  return lines.join('\n');
}

export function displayCounters(router: Router): string {
  const c = router.getCounters();
  return [
    'IP statistics:',
    `  Input:  ${c.ifInOctets} bytes`,
    `  Output: ${c.ifOutOctets} bytes`,
    `  Forward: ${c.ipForwDatagrams} packets`,
    `  Discard: ${c.ipInHdrErrors} header errors, ${c.ipInAddrErrors} no-route`,
    '',
    'ICMP statistics:',
    `  Output: ${c.icmpOutMsgs} packets`,
    `    Destination unreachable: ${c.icmpOutDestUnreachs}`,
    `    Time exceeded: ${c.icmpOutTimeExcds}`,
    `    Echo reply: ${c.icmpOutEchoReps}`,
  ].join('\n');
}

export function displayRip(router: Router): string {
  if (!router.isRIPEnabled()) return 'Info: RIP is not enabled.';
  const cfg = router.getRIPConfig();
  const ripRoutes = router.getRIPRoutes();
  const lines = [
    'RIP process 1',
    '  Version: 2',
    `  Update timer: ${cfg.updateInterval / 1000}s`,
    `  Timeout timer: ${cfg.routeTimeout / 1000}s`,
    `  Garbage-collect timer: ${cfg.gcTimeout / 1000}s`,
    '',
    '  Networks:',
  ];
  for (const net of cfg.networks) {
    lines.push(`    ${net.network}/${net.mask}`);
  }
  lines.push('');
  lines.push(`  Routes: ${ripRoutes.size}`);
  for (const [key, info] of ripRoutes) {
    lines.push(`    ${key} cost ${info.metric} via ${info.learnedFrom} age ${info.age}s${info.garbageCollect ? ' [garbage-collect]' : ''}`);
  }
  return lines.join('\n');
}

// ─── Trie Registration ──────────────────────────────────────────────

/**
 * Register all "display" commands on a CommandTrie.
 * Used by HuaweiVRPShell to wire display commands onto per-mode tries.
 */
export function registerDisplayCommands(
  trie: CommandTrie,
  getRouter: () => Router,
  getState: () => HuaweiDisplayState,
): void {
  trie.register('display version', 'Display version information', () => displayVersion(getRouter()));
  trie.register('display ip routing-table', 'Display IP routing table', () => displayIpRoutingTable(getRouter()));
  trie.register('display ip interface brief', 'Display interface summary', () => displayIpIntBrief(getRouter()));
  trie.register('display ip traffic', 'Display IP traffic statistics', () => displayCounters(getRouter()));
  trie.register('display arp', 'Display ARP table', () => displayArp(getRouter()));
  trie.register('display current-configuration', 'Display running configuration', () => {
    const s = getState();
    return displayCurrentConfig(getRouter(), s.isDhcpEnabled(), s.isDhcpSnoopingEnabled(), s.getDhcpSelectGlobal());
  });
  trie.register('display counters', 'Display traffic counters', () => displayCounters(getRouter()));
  trie.register('display rip', 'Display RIP information', () => displayRip(getRouter()));

  trie.registerGreedy('display interface', 'Display interface information', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    return displayInterface(getRouter(), args.join(' '));
  });

  trie.registerGreedy('display ip pool name', 'Display DHCP pool information', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    return displayIpPool(getRouter(), args.join(' '));
  });
}

// ─── Interface Name Resolution (Huawei format) ──────────────────────

export function resolveHuaweiInterfaceName(router: Router, input: string): string | null {
  // Direct match
  for (const name of router.getPortNames()) {
    if (name.toLowerCase() === input.toLowerCase()) return name;
  }

  // Abbreviation: GE0/0/0 → full port name
  const lower = input.toLowerCase();
  const match = lower.match(/^(ge|gigabitethernet|gi)([\d/]+)$/);
  if (match) {
    const numbers = match[2];
    // Try GE format first (router naming)
    const geResolved = `GE${numbers}`;
    for (const name of router.getPortNames()) {
      if (name === geResolved) return name;
    }
    // Try GigabitEthernet format
    const giResolved = `GigabitEthernet${numbers}`;
    for (const name of router.getPortNames()) {
      if (name === giResolved) return name;
    }
  }

  return null;
}
