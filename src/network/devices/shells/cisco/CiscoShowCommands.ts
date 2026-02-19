/**
 * CiscoShowCommands - Extracted show command implementations for Cisco IOS CLI
 *
 * Pure functions: Router → string (no side effects, no state mutation)
 * Used by CiscoIOSShell for "show" commands in user and privileged modes.
 */

import type { Router } from '../../Router';
import { runningConfigACL, runningConfigInterfaceACL } from './CiscoAclCommands';

export function showVersion(router: Router): string {
  const ports = router._getPortsInternal();
  const giPorts = [...ports.keys()].filter(n => n.startsWith('Gig'));
  return [
    `Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.7(3)M5`,
    `Copyright (c) 1986-2025 by Cisco Systems, Inc.`,
    '',
    `ROM: System Bootstrap, Version 15.0(1r)M15`,
    '',
    `${router._getHostnameInternal()} uptime is 0 minutes`,
    `System image file is "flash:c2900-universalk9-mz.SPA.157-3.M5.bin"`,
    '',
    `Cisco C2911 (revision 1.0) with 524288K/65536K bytes of memory.`,
    `Processor board ID FTX1234567A`,
    `${giPorts.length} Gigabit Ethernet interfaces`,
    `DRAM configuration is 64 bits wide with parity enabled.`,
    `256K bytes of non-volatile configuration memory.`,
    '',
    `Configuration register is 0x2102`,
  ].join('\n');
}

export function showIpRoute(router: Router): string {
  const table = router.getRoutingTable();
  const lines = ['Codes: C - connected, S - static, R - RIP, O - OSPF, * - candidate default', ''];
  const sorted = [...table].sort((a, b) => {
    const order: Record<string, number> = { connected: 0, ospf: 1, rip: 2, static: 3, default: 4 };
    return (order[a.type] ?? 5) - (order[b.type] ?? 5);
  });
  for (const r of sorted) {
    let code: string;
    switch (r.type) {
      case 'connected': code = 'C'; break;
      case 'rip': code = 'R'; break;
      case 'ospf': code = 'O'; break;
      case 'default': code = 'S*'; break;
      default: code = 'S'; break;
    }
    const via = r.nextHop ? `via ${r.nextHop}` : 'is directly connected';
    const metricStr = (r.type === 'rip' || r.type === 'ospf') ? ` [${r.ad}/${r.metric}]` : '';
    lines.push(`${code}    ${r.network}/${r.mask.toCIDR()}${metricStr} ${via}, ${r.iface}`);
  }
  return lines.length > 2 ? lines.join('\n') : 'No routes configured.';
}

export function showIpIntBrief(router: Router): string {
  const ports = router._getPortsInternal();
  const lines = ['Interface                  IP-Address      OK? Method Status                Protocol'];
  for (const [name, port] of ports) {
    const ip = port.getIPAddress()?.toString() || 'unassigned';
    const status = port.isConnected() ? 'up' : 'administratively down';
    const proto = port.isConnected() ? 'up' : 'down';
    lines.push(`${name.padEnd(27)}${ip.padEnd(16)}YES manual ${status.padEnd(22)}${proto}`);
  }
  return lines.join('\n');
}

export function showArp(router: Router): string {
  const arpTable = router._getArpTableInternal();
  if (arpTable.size === 0) return 'No ARP entries.';
  const lines = ['Protocol  Address          Age (min)   Hardware Addr   Type   Interface'];
  for (const [ip, entry] of arpTable) {
    const age = Math.floor((Date.now() - entry.timestamp) / 60000);
    lines.push(`Internet  ${ip.padEnd(17)}${String(age).padEnd(12)}${entry.mac.toString().padEnd(16)}ARPA   ${entry.iface}`);
  }
  return lines.join('\n');
}

export function showRunningConfig(router: Router): string {
  const ports = router._getPortsInternal();
  const table = router._getRoutingTableInternal();
  const dhcp = router._getDHCPServerInternal();
  const lines = [
    'Building configuration...',
    '',
    'Current configuration:',
    '!',
    `hostname ${router._getHostnameInternal()}`,
    '!',
  ];

  // DHCP config
  if (dhcp.isEnabled()) {
    lines.push('service dhcp');
  }
  const pools = dhcp.getAllPools();
  for (const [, pool] of pools) {
    lines.push('!');
    lines.push(`ip dhcp pool ${pool.name}`);
    if (pool.network && pool.mask) lines.push(` network ${pool.network} ${pool.mask}`);
    if (pool.defaultRouter) lines.push(` default-router ${pool.defaultRouter}`);
    if (pool.dnsServers.length > 0) lines.push(` dns-server ${pool.dnsServers.join(' ')}`);
    if (pool.domainName) lines.push(` domain-name ${pool.domainName}`);
    const days = Math.floor(pool.leaseDuration / 86400);
    if (days !== 1) lines.push(` lease ${days}`);
  }
  const excluded = dhcp.getExcludedRanges();
  for (const range of excluded) {
    if (range.start === range.end) {
      lines.push(`ip dhcp excluded-address ${range.start}`);
    } else {
      lines.push(`ip dhcp excluded-address ${range.start} ${range.end}`);
    }
  }

  lines.push('!');
  for (const [name, port] of ports) {
    lines.push(`interface ${name}`);
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    if (ip && mask) {
      lines.push(` ip address ${ip} ${mask}`);
      lines.push(` no shutdown`);
    } else {
      lines.push(` shutdown`);
    }
    const helpers = dhcp.getHelperAddresses(name);
    for (const h of helpers) {
      lines.push(` ip helper-address ${h}`);
    }
    // ACL bindings on interface
    lines.push(...runningConfigInterfaceACL(router, name));
    lines.push('!');
  }

  // ACL configuration
  const aclLines = runningConfigACL(router);
  if (aclLines.length > 0) {
    lines.push(...aclLines);
    lines.push('!');
  }

  for (const r of table) {
    if (r.type === 'static' && r.nextHop) lines.push(`ip route ${r.network} ${r.mask} ${r.nextHop}`);
    if (r.type === 'default' && r.nextHop) lines.push(`ip route 0.0.0.0 0.0.0.0 ${r.nextHop}`);
  }

  // RIP config
  if (router.isRIPEnabled()) {
    lines.push('!');
    lines.push('router rip');
    lines.push(' version 2');
    const cfg = router.getRIPConfig();
    for (const net of cfg.networks) {
      lines.push(` network ${net.network}`);
    }
  }

  lines.push('!');
  lines.push('end');
  return lines.join('\n');
}

export function showRunningConfigInterface(router: Router, ifName: string): string {
  const port = router.getPort(ifName);
  if (!port) return `% Invalid interface "${ifName}"`;

  const ip = port.getIPAddress();
  const mask = port.getSubnetMask();
  const dhcp = router._getDHCPServerInternal();
  const lines = [
    'Building configuration...',
    '',
    `Current configuration : interface ${ifName}`,
    '!',
    `interface ${ifName}`,
  ];
  if (ip && mask) {
    lines.push(` ip address ${ip} ${mask}`);
    lines.push(` no shutdown`);
  } else {
    lines.push(` shutdown`);
  }
  const helpers = dhcp.getHelperAddresses(ifName);
  for (const h of helpers) {
    lines.push(` ip helper-address ${h}`);
  }
  lines.push('end');
  return lines.join('\n');
}

export function showCounters(router: Router): string {
  const c = router.getCounters();
  return [
    'IP statistics:',
    `  Rcvd:  ${c.ifInOctets} total octets`,
    `  Sent:  ${c.ifOutOctets} total octets`,
    `  Frags: ${c.ipForwDatagrams} forwarded`,
    `  Drop:  ${c.ipInHdrErrors} header errors, ${c.ipInAddrErrors} address errors`,
    '',
    'ICMP statistics:',
    `  Sent: ${c.icmpOutMsgs} total`,
    `    Destination unreachable: ${c.icmpOutDestUnreachs}`,
    `    Time exceeded: ${c.icmpOutTimeExcds}`,
    `    Echo replies: ${c.icmpOutEchoReps}`,
  ].join('\n');
}

export function showIpProtocols(router: Router): string {
  if (!router.isRIPEnabled()) return 'No routing protocol is configured.';
  const cfg = router.getRIPConfig();
  const ripRoutes = router.getRIPRoutes();
  const lines = [
    'Routing Protocol is "rip"',
    '  Version: 2',
    `  Update interval: ${cfg.updateInterval / 1000}s`,
    `  Route timeout: ${cfg.routeTimeout / 1000}s`,
    `  Garbage collection: ${cfg.gcTimeout / 1000}s`,
    `  Split horizon: ${cfg.splitHorizon ? 'enabled' : 'disabled'}`,
    `  Poisoned reverse: ${cfg.poisonedReverse ? 'enabled' : 'disabled'}`,
    '',
    '  Advertised networks:',
  ];
  for (const net of cfg.networks) {
    lines.push(`    ${net.network}/${net.mask.toCIDR()}`);
  }
  lines.push('');
  lines.push(`  RIP learned routes: ${ripRoutes.size}`);
  for (const [key, info] of ripRoutes) {
    lines.push(`    ${key} metric ${info.metric} via ${info.learnedFrom} (age ${info.age}s)${info.garbageCollect ? ' [gc]' : ''}`);
  }
  return lines.join('\n');
}
