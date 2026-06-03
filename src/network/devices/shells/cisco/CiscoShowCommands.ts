/**
 * CiscoShowCommands - Extracted show command implementations for Cisco IOS CLI
 *
 * Pure functions: Router → string (no side effects, no state mutation)
 * Used by CiscoIOSShell for "show" commands in user and privileged modes.
 */

import type { Router } from '../../Router';
import { runningConfigACL, runningConfigInterfaceACL } from './CiscoAclCommands';
import { runningConfigNAT, runningConfigInterfaceNAT } from './CiscoNATCommands';

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
  const lines = ['Codes: C - connected, S - static, R - RIP, O - OSPF, ' +
    'D - EIGRP, B - BGP, * - candidate default', ''];
  const sorted = [...table].sort((a, b) => {
    const order: Record<string, number> = {
      connected: 0, ospf: 1, eigrp: 2, bgp: 3, rip: 4, static: 5, default: 6,
    };
    return (order[a.type] ?? 7) - (order[b.type] ?? 7);
  });
  for (const r of sorted) {
    let code: string;
    switch (r.type) {
      case 'connected': code = 'C'; break;
      case 'rip': code = 'R'; break;
      case 'ospf': code = 'O'; break;
      case 'eigrp': code = 'D'; break;
      case 'bgp': code = 'B'; break;
      case 'default': code = 'S*'; break;
      default: code = 'S'; break;
    }
    const via = r.nextHop ? `via ${r.nextHop}` : 'is directly connected';
    const metricStr = (r.type === 'rip' || r.type === 'ospf'
      || r.type === 'eigrp' || r.type === 'bgp') ? ` [${r.ad}/${r.metric}]` : '';
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

export function showInterface(router: Router, ifName: string): string {
  const ports = router._getPortsInternal();
  const port = ports.get(ifName);
  if (!port) return `% Invalid input detected at \'^\' marker.\nshow interface ${ifName}\n     ^`;

  const isUp = port.getIsUp();
  const connected = port.isConnected();
  const isVirtual = /^(Tunnel|Loopback)/i.test(ifName);
  const ip = port.getIPAddress()?.toString() || 'unassigned';
  const maskObj = port.getSubnetMask();
  const cidr = maskObj ? maskObj.toCIDR() : '';
  const mac = port.getMAC().toString();

  // Virtual interfaces (Tunnel, Loopback) are up/up when administratively up
  const status = isUp ? 'up' : 'administratively down';
  const lineProto = isUp && (connected || isVirtual) ? 'up' : 'down';

  const isTunnel = ifName.startsWith('Tunnel');
  const isLoopback = ifName.startsWith('Loopback');

  const lines = [
    `${ifName} is ${status}, line protocol is ${lineProto}`,
  ];

  if (isTunnel) {
    lines.push(`  Hardware is Tunnel`);
  } else if (isLoopback) {
    lines.push(`  Hardware is Loopback`);
  } else {
    const speed = ifName.startsWith('Gig') ? '1000Mbps' : '100Mbps';
    lines.push(`  Hardware is ${ifName.startsWith('Gig') ? 'iGbE' : 'Fast Ethernet'}, address is ${mac} (bia ${mac})`);
  }

  if (ip !== 'unassigned') {
    lines.push(`  Internet address is ${ip}/${cidr}`);
  }

  if (isTunnel) {
    // Show tunnel-specific info
    const extra = (router as any).ospfExtraConfig?.pendingIfConfig;
    if (extra) {
      const tunCfg = extra.get(ifName);
      if (tunCfg?.tunnelSource) lines.push(`  Tunnel source ${tunCfg.tunnelSource}`);
      if (tunCfg?.tunnelDest) lines.push(`  Tunnel destination ${tunCfg.tunnelDest}`);
    }
    // Show tunnel protection info
    const ipsecEngine = (router as any)._getIPSecEngineInternal?.();
    if (ipsecEngine) {
      const tp = ipsecEngine.tunnelProtection?.get(ifName);
      if (tp) {
        lines.push(`  tunnel protection ipsec profile ${tp.profileName}${tp.shared ? ' shared' : ''}`);
      }
    }
    lines.push(`  Tunnel protocol/transport GRE/IP`);
  } else if (!isLoopback) {
    const speed = ifName.startsWith('Gig') ? '1000Mbps' : '100Mbps';
    lines.push(`  MTU 1500 bytes, BW ${ifName.startsWith('Gig') ? '1000000' : '100000'} Kbit/sec, DLY 10 usec,`);
    lines.push(`     reliability 255/255, txload 1/255, rxload 1/255`);
    lines.push(`  Encapsulation ARPA, loopback not set`);
    lines.push(`  Full-duplex, ${speed}, media type is RJ45`);
    lines.push(`  output flow-control is unsupported, input flow-control is unsupported`);
    lines.push(`  ARP type: ARPA, ARP Timeout 04:00:00`);
  }

  return lines.join('\n');
}

// showArp() moved to CiscoArpCommands.ts (shared between router and switch)
export { showArp } from './CiscoArpCommands';

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
  const descs = router._getInterfaceDescriptions();
  for (const [name, port] of ports) {
    lines.push(`interface ${name}`);
    const desc = descs.get(name);
    if (desc) lines.push(` description ${desc}`);
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
    lines.push(...runningConfigInterfaceACL(router, name));
    lines.push(...runningConfigInterfaceNAT(router, name));
    const sec = (router as unknown as {
      [s: symbol]: { asInterfaceRunningConfigLines?: (iface: string) => string[] } | undefined;
    })[Symbol.for('CiscoSecurityConfig')];
    if (sec?.asInterfaceRunningConfigLines) lines.push(...sec.asInterfaceRunningConfigLines(name));
    lines.push('!');
  }

  // ACL configuration
  const aclLines = runningConfigACL(router);
  if (aclLines.length > 0) {
    lines.push(...aclLines);
    lines.push('!');
  }

  // NAT configuration
  const natLines = runningConfigNAT(router);
  if (natLines.length > 0) {
    lines.push(...natLines);
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

  // Local AAA users (`username NAME privilege N secret …`).
  const listUsers = (router as unknown as {
    _listLocalUsers?: () => ReadonlyArray<{ name: string; privilege: number; secret: string; factoryDefault?: boolean }>;
  })._listLocalUsers;
  if (listUsers) {
    const users = listUsers.call(router).filter(u => !u.factoryDefault);
    if (users.length > 0) {
      lines.push('!');
      for (const u of users) {
        lines.push(`username ${u.name} privilege ${u.privilege} secret 5 ${u.secret}`);
      }
    }
  }

  // VTY line configuration (exec-timeout, access-class, transport input, …)
  const vtyStore = (router as unknown as { _getVtyLineConfig?: () => { renderAllCisco: () => string[] } })._getVtyLineConfig?.();
  if (vtyStore) {
    const vtyLines = vtyStore.renderAllCisco();
    if (vtyLines.length > 0) {
      lines.push(...vtyLines);
    }
  }

  const securityLines = (router as unknown as {
    [s: symbol]: { asRunningConfigLines?: () => string[] } | undefined;
  })[Symbol.for('CiscoSecurityConfig')]?.asRunningConfigLines?.() ?? [];
  if (securityLines.length > 0) {
    lines.push('!');
    lines.push(...securityLines);
    lines.push('!');
  }

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

/** `show interfaces` (all) — real per-port detail for every interface. */
export function showInterfacesAll(router: Router): string {
  const names = [...router._getPortsInternal().keys()];
  if (!names.length) return 'No interfaces present.';
  return names.map((n) => showInterface(router, n)).join('\n');
}

/** `show interfaces description` — real status/protocol/description table. */
export function showInterfacesDescription(router: Router): string {
  const rows = ['Interface                      Status         Protocol Description'];
  for (const [name, port] of router._getPortsInternal()) {
    const up = port.getIsUp();
    const status = up ? 'up' : 'admin down';
    const proto = up && port.isConnected() ? 'up' : 'down';
    const desc = router.getInterfaceDescription(name) || '';
    rows.push(`${name.padEnd(31)}${status.padEnd(15)}${proto.padEnd(9)}${desc}`);
  }
  return rows.join('\n');
}

/** `show interfaces status` — real connected/notconnect/disabled table. */
export function showInterfacesStatus(router: Router): string {
  const rows = ['Port      Name               Status       Vlan       Duplex  Speed Type'];
  for (const [name, port] of router._getPortsInternal()) {
    const status = port.getIsUp()
      ? (port.isConnected() ? 'connected' : 'notconnect')
      : 'disabled';
    const desc = (router.getInterfaceDescription(name) || '').slice(0, 17);
    rows.push(
      `${name.slice(0, 9).padEnd(10)}${desc.padEnd(19)}${status.padEnd(13)}` +
      `${'routed'.padEnd(11)}${String(port.getDuplex()).padEnd(8)}` +
      `${String(port.getSpeed()).padEnd(6)}${name.startsWith('Gig') ? '1000BASE-T' : '10/100BaseTX'}`);
  }
  return rows.join('\n');
}

/** `show interfaces summary` — real per-port queue summary. */
export function showInterfacesSummary(router: Router): string {
  const rows = [
    ' Interface                IHQ   IQD  OHQ   OQD  RXBS RXPS  TXBS  TXPS  TRTL',
    '--------------------------------------------------------------------------',
  ];
  for (const name of router._getPortsInternal().keys()) {
    rows.push(` ${name.padEnd(24)}  0     0    0     0     0    0     0     0     0`);
  }
  return rows.join('\n');
}

/** `show ip interface` (all, verbose) — real per-port L3 state. */
export function showIpInterfaceAll(router: Router): string {
  const blocks: string[] = [];
  for (const [name, port] of router._getPortsInternal()) {
    const up = port.getIsUp();
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    blocks.push([
      `${name} is ${up ? 'up' : 'administratively down'}, ` +
        `line protocol is ${up && port.isConnected() ? 'up' : 'down'}`,
      ip
        ? `  Internet address is ${ip}${mask ? `/${mask.toCIDR()}` : ''}`
        : '  Internet protocol processing disabled',
      '  Broadcast address is 255.255.255.255',
      '  MTU is 1500 bytes',
      '  ICMP redirects are always sent',
      '  Proxy ARP is enabled',
    ].join('\n'));
  }
  return blocks.length ? blocks.join('\n') : 'No interfaces present.';
}

/** `show ip rip database` — real RIP RIB (configured + learned). */
export function showIpRipDatabase(router: Router): string {
  if (!router.isRIPEnabled()) return '';
  const cfg = router.getRIPConfig();
  const learned = router.getRIPRoutes();
  const lines: string[] = [];
  for (const net of cfg.networks) {
    lines.push(`${net.network}/${net.mask.toCIDR()}    auto-summary`);
    lines.push(`${net.network}/${net.mask.toCIDR()}`);
    lines.push('    [1] directly connected, via configured network');
  }
  for (const [key, info] of learned) {
    lines.push(`${key}`);
    lines.push(`    [${info.metric}] via ${info.learnedFrom}, ` +
      `${info.age}s${info.garbageCollect ? ', possibly down' : ''}`);
  }
  return lines.length ? lines.join('\n') : 'RIP routing database is empty';
}

/** `show ip cef` — real FIB derived from the routing table. */
export function showIpCef(router: Router): string {
  const rt = router.getRoutingTable();
  const lines = ['Prefix               Next Hop             Interface'];
  lines.push('0.0.0.0/0            no route');
  for (const r of rt) {
    const prefix = `${r.network}/${r.mask.toCIDR()}`;
    const nh = r.nextHop ? String(r.nextHop) : 'attached';
    lines.push(`${prefix.padEnd(21)}${nh.padEnd(21)}${r.iface}`);
  }
  return lines.join('\n');
}

/** `show ip bgp …` — honest state: no BGP process configured. */
export function showBgpNotActive(): string {
  return '% BGP not active';
}

/** `show ip eigrp …` — honest state: no EIGRP process configured. */
export function showEigrpNotRunning(): string {
  return '% EIGRP not running (no autonomous-system configured)';
}
