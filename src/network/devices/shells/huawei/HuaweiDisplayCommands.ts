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
import { resolveHuaweiInterfaceName as resolveHuaweiIfName } from '../cli-utils';
import { runningConfigACL, runningConfigInterfaceACL } from './HuaweiAclCommands';

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
  const isVirtual = /^(LoopBack|Tunnel)/i.test(portName);

  const lines = [
    `${portName} current state : ${isUp ? (isConn || isVirtual ? 'UP' : 'DOWN') : 'Administratively DOWN'}`,
    `Line protocol current state : ${isConn || isVirtual ? 'UP' : 'DOWN'}`,
  ];

  const desc = router.getInterfaceDescription(portName);
  if (desc) lines.push(`Description: ${desc}`);

  lines.push(`Internet Address is ${ip && mask ? `${ip}/${mask}` : 'not configured'}`);

  // Tunnel-specific info
  const isTunnel = /^Tunnel/i.test(portName);
  if (isTunnel) {
    const extra = router._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig?.get(portName) as any;
    if (pending?.tunnelSource) lines.push(`Tunnel source ${pending.tunnelSource}`);
    if (pending?.tunnelDest) lines.push(`Tunnel destination ${pending.tunnelDest}`);
    const ipsecEng = (router as any)._getIPSecEngineInternal?.();
    if (ipsecEng) {
      const tp = (ipsecEng as any).tunnelProtection?.get(portName);
      if (tp) lines.push(`Tunnel protection IPSec profile ${tp.profileName}${tp.shared ? ' shared' : ''}`);
    }
  }

  lines.push(
    `The Maximum Transmit Unit is 1500`,
    `Input:  0 packets, 0 bytes`,
    `Output: 0 packets, 0 bytes`,
  );

  return lines.join('\n');
}

export function displayIpPool(router: Router, poolName: string): string {
  const dhcp = router._getDHCPServerInternal();
  const pool = dhcp.getPool(poolName);
  if (!pool) return `Error: Pool "${poolName}" does not exist.`;

  const leaseDays = Math.floor(pool.leaseDuration / 86400);
  const leaseStr = leaseDays >= 1 ? `${leaseDays} day(s)` : `${pool.leaseDuration} seconds`;
  const lines = [
    `Pool-name      : ${pool.name}`,
    `Pool-No        : 0`,
    `Position       : Local`,
    `Status         : Unlocked`,
    `Gateway-list   : ${pool.defaultRouter || 'not configured'}`,
    `Network        : ${pool.network || 'not configured'}`,
    `Mask           : ${pool.mask || 'not configured'}`,
    `DNS-list       : ${pool.dnsServers.join(' ') || 'not configured'}`,
    `Domain-name    : ${pool.domainName || 'not configured'}`,
    `Lease          : ${leaseStr}`,
  ];
  return lines.join('\n');
}

export function displayIpPoolAll(router: Router): string {
  const dhcp = router._getDHCPServerInternal();
  const pools = dhcp.getAllPools();
  if (pools.size === 0) return 'No DHCP pools configured.';
  const lines: string[] = [];
  for (const [, pool] of pools) {
    lines.push(displayIpPool(router, pool.name));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
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

export function displayArpFiltered(router: Router, filterType: 'static' | 'dynamic'): string {
  const arpTable = router._getArpTableInternal();
  const lines = ['IP ADDRESS      MAC ADDRESS     EXPIRE(M)  TYPE      INTERFACE'];
  let found = false;
  for (const [ip, entry] of arpTable) {
    const isStatic = (entry as any).type === 'static';
    if (filterType === 'static' && !isStatic) continue;
    if (filterType === 'dynamic' && isStatic) continue;
    found = true;
    const age = Math.floor((Date.now() - entry.timestamp) / 60000);
    const type = isStatic ? 'static' : 'D';
    lines.push(`${ip.padEnd(16)}${entry.mac.toString().padEnd(16)}${String(age).padEnd(11)}${type.padEnd(10)}${entry.iface}`);
  }
  if (!found) lines.push(`No ${filterType} ARP entries found.`);
  return lines.join('\n');
}

export function displayIpRoutingTableStatistics(router: Router): string {
  const table = router.getRoutingTable();
  const counts: Record<string, number> = {};
  for (const r of table) {
    const proto = r.type === 'connected' ? 'Direct' : r.type === 'rip' ? 'RIP' : r.type === 'ospf' ? 'OSPF' : 'Static';
    counts[proto] = (counts[proto] || 0) + 1;
  }
  const lines = [
    'Proto     route',
    '--------------------',
  ];
  let total = 0;
  for (const [proto, count] of Object.entries(counts)) {
    lines.push(`${proto.padEnd(10)}${count}`);
    total += count;
  }
  lines.push('--------------------');
  lines.push(`Total     ${total}`);
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

  // DHCP pool config
  const dhcp = router._getDHCPServerInternal();
  for (const [, pool] of dhcp.getAllPools()) {
    lines.push(`ip pool ${pool.name}`);
    if (pool.network && pool.mask) lines.push(` network ${pool.network} mask ${pool.mask}`);
    if (pool.defaultRouter) lines.push(` gateway-list ${pool.defaultRouter}`);
    if (pool.dnsServers.length > 0) lines.push(` dns-list ${pool.dnsServers.join(' ')}`);
    if (pool.domainName) lines.push(` domain-name ${pool.domainName}`);
    const days = Math.floor(pool.leaseDuration / 86400);
    const remSecs = pool.leaseDuration % 86400;
    const hours = Math.floor(remSecs / 3600);
    const mins = Math.floor((remSecs % 3600) / 60);
    if (pool.leaseDuration !== 86400) {
      let leaseStr = ` lease day ${days}`;
      if (hours > 0) leaseStr += ` hour ${hours}`;
      if (mins > 0) leaseStr += ` minute ${mins}`;
      lines.push(leaseStr);
    }
    lines.push('#');
  }
  const excluded = dhcp.getExcludedRanges();
  for (const range of excluded) {
    if (range.start === range.end) {
      lines.push(`dhcp server forbidden-ip ${range.start}`);
    } else {
      lines.push(`dhcp server forbidden-ip ${range.start} ${range.end}`);
    }
  }

  // ARP static entries
  const arpTable = router._getArpTableInternal();
  for (const [ip, entry] of arpTable) {
    if ((entry as any).type === 'static') {
      lines.push(`arp static ${ip} ${entry.mac.toString()}`);
    }
  }

  const descs = router._getInterfaceDescriptions();
  const ospfExtra = router._getOSPFExtraConfig();
  for (const [name, port] of ports) {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    lines.push(`interface ${name}`);
    const desc = descs.get(name);
    if (desc) lines.push(` description ${desc}`);
    if (ip && mask) {
      lines.push(` ip address ${ip} ${mask}`);
    } else {
      lines.push(` shutdown`);
    }
    if (dhcpSelectGlobal.has(name)) {
      lines.push(` dhcp select global`);
    }
    // DHCP relay helper addresses
    const helpers = dhcp.getHelperAddresses(name);
    for (const h of helpers) {
      lines.push(` dhcp relay server-ip ${h}`);
    }
    // Tunnel source/destination
    const pendingCfg = ospfExtra.pendingIfConfig?.get(name) as any;
    if (pendingCfg?.tunnelSource) lines.push(` source ${pendingCfg.tunnelSource}`);
    if (pendingCfg?.tunnelDest) lines.push(` destination ${pendingCfg.tunnelDest}`);
    // IPSec policy/profile applied to interface
    const ipsecEng2 = (router as any)._getIPSecEngineInternal?.();
    if (ipsecEng2) {
      const ifCrypto = (ipsecEng2 as any).ifaceCryptoMap?.get(name);
      if (ifCrypto) lines.push(` ipsec policy ${ifCrypto}`);
      const tp = (ipsecEng2 as any).tunnelProtection?.get(name);
      if (tp) lines.push(` ipsec profile ${tp.profileName}`);
    }
    lines.push(...runningConfigInterfaceACL(router, name));
    lines.push('#');
  }

  // ACL configuration
  const aclLines = runningConfigACL(router);
  if (aclLines.length > 0) {
    lines.push(...aclLines);
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
  // OSPF config
  const ospf = router._getOSPFEngineInternal();
  if (ospf) {
    const config = ospf.getConfig();
    lines.push('#');
    lines.push(`ospf ${config.processId}`);
    if (config.routerId && config.routerId !== '0.0.0.0') {
      lines.push(` router-id ${config.routerId}`);
    }
    // Group network statements by area
    const areaNetworks = new Map<string, Array<{ network: string; wildcard: string }>>();
    for (const net of config.networks) {
      if (!areaNetworks.has(net.areaId)) areaNetworks.set(net.areaId, []);
      areaNetworks.get(net.areaId)!.push({ network: net.network, wildcard: net.wildcard });
    }
    for (const [areaId, nets] of areaNetworks) {
      lines.push(` area ${areaId}`);
      for (const net of nets) {
        lines.push(`  network ${net.network} ${net.wildcard}`);
      }
    }
  }

  // IPSec/IKE configuration
  const ipsecEng = (router as any)._getIPSecEngineInternal?.() ?? null;
  if (ipsecEng) {
    const isakmpPolicies: Map<number, any> = (ipsecEng as any).isakmpPolicies;
    for (const [n, policy] of isakmpPolicies) {
      lines.push('#');
      lines.push(`ike proposal ${n}`);
      if (policy.huaweiEncryption) lines.push(` encryption-algorithm ${policy.huaweiEncryption}`);
      if (policy.hash) lines.push(` authentication-algorithm ${policy.hash}`);
      if (policy.group) lines.push(` dh group${policy.group}`);
    }
    const kr: any = (ipsecEng as any).ikev2Keyrings?.get('default');
    if (kr) {
      for (const [peerName, peer] of kr.peers as Map<string, any>) {
        lines.push('#');
        lines.push(`ike peer ${peerName}`);
        if (peer.address && peer.address !== '0.0.0.0') lines.push(` remote-address ${peer.address}`);
        if (peer.preSharedKey) lines.push(` pre-shared-key simple ${peer.preSharedKey}`);
      }
    }
    const transformSets: Map<string, any> = (ipsecEng as any).transformSets;
    for (const [name, ts] of transformSets) {
      lines.push('#');
      lines.push(`ipsec proposal ${name}`);
      if ((ts as any).protocol) lines.push(` transform ${(ts as any).protocol}`);
      if (ts.mode) lines.push(` encapsulation-mode ${ts.mode}`);
      const espEnc = ts.transforms.find((t: string) => t.match(/^esp-(aes|des|3des)/));
      if (espEnc) lines.push(` esp encryption-algorithm ${espEnc.replace('esp-', '')}`);
      const espAuth = ts.transforms.find((t: string) => t.includes('-hmac'));
      if (espAuth) {
        const algo = espAuth.replace('esp-', '').replace('-hmac', '');
        lines.push(` esp authentication-algorithm ${algo}`);
      }
    }
    const cryptoMaps: Map<string, any> = (ipsecEng as any).cryptoMaps;
    for (const [mapName, cmap] of cryptoMaps) {
      for (const [seq, entry] of cmap.staticEntries as Map<number, any>) {
        lines.push('#');
        lines.push(`ipsec policy ${mapName} ${seq} isakmp`);
        if (entry.peers?.length > 0) lines.push(` ike-peer ${entry.peers[0]}`);
        if (entry.transformSets?.length > 0) lines.push(` proposal ${entry.transformSets.join(' ')}`);
      }
    }
    const ipsecProfiles: Map<string, any> = (ipsecEng as any).ipsecProfiles;
    for (const [profName, prof] of ipsecProfiles) {
      lines.push('#');
      lines.push(`ipsec profile ${profName}`);
      if (prof.transformSetName) lines.push(` proposal ${prof.transformSetName}`);
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

export function displayIpv6RoutingTable(router: Router): string {
  const rt = (router as any)._getIPv6RoutingTableInternal?.() || [];
  const lines = ['IPv6 Routing Table'];
  if (rt.length === 0) {
    lines.push('No IPv6 routes configured.');
    return lines.join('\n');
  }
  for (const r of rt) {
    const prefix = r.prefix ? `${r.prefix}/${r.prefixLength}` : 'unknown';
    const nh = r.nextHop || 'directly connected';
    const iface = r.iface || '';
    lines.push(`  ${prefix} via ${nh} ${iface}`);
  }
  return lines.join('\n');
}

export function displayIpv6InterfaceBrief(router: Router): string {
  const ports = router._getPortsInternal();
  const lines = ['Interface                         IPv6 Address                    State'];
  for (const [name, port] of ports) {
    const addrs = port.getIPv6Addresses?.() || [];
    const addrStr = addrs.length > 0 ? addrs.map((a: any) => `${a.address}/${a.prefixLength}`).join(', ') : 'unassigned';
    const state = port.isConnected() ? 'up' : 'down';
    lines.push(`${name.padEnd(34)}${addrStr.padEnd(32)}${state}`);
  }
  return lines.join('\n');
}

export function displayDebugging(router: Router): string {
  const lines: string[] = [];
  const dhcp = router._getDHCPServerInternal();
  const dhcpDebug = dhcp.formatDebugShow();
  if (!dhcpDebug.includes('No')) {
    lines.push('DHCP debugging:');
    lines.push(dhcpDebug);
  }
  const ipsecEng = (router as any)._getIPSecEngineInternal?.();
  if (ipsecEng) {
    const debug = (ipsecEng as any).debugFlags || {};
    if (debug.isakmp) lines.push('IKE debugging is on');
    if (debug.ipsec) lines.push('IPSec debugging is on');
    if (debug.ikev2) lines.push('IKEv2 debugging is on');
  }
  if (lines.length === 0) return 'No debugging is enabled.';
  return lines.join('\n');
}

export function displayIpProtocols(router: Router): string {
  if (!router.isRIPEnabled()) return 'No routing protocol is configured.';
  const cfg = router.getRIPConfig();
  const ripRoutes = router.getRIPRoutes();
  const lines = [
    'Routing Protocol is "rip"',
    '  Version: 2',
    `  Update interval: ${cfg.updateInterval / 1000}s`,
    `  Route timeout: ${cfg.routeTimeout / 1000}s`,
    `  Garbage collection: ${cfg.gcTimeout / 1000}s`,
    '',
    '  Networks:',
  ];
  for (const net of cfg.networks) {
    lines.push(`    ${net.network}/${net.mask}`);
  }
  lines.push('');
  lines.push(`  Routes learned: ${ripRoutes.size}`);
  return lines.join('\n');
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

export function displayCurrentConfigInterface(router: Router, ifName: string): string {
  const portName = resolveHuaweiInterfaceName(router, ifName) || ifName;
  const port = router.getPort(portName);
  if (!port) return `Error: Interface "${ifName}" does not exist.`;

  const ip = port.getIPAddress();
  const mask = port.getSubnetMask();
  const desc = router.getInterfaceDescription(portName);
  const lines = [
    '#',
    `interface ${portName}`,
  ];
  if (desc) lines.push(` description ${desc}`);
  if (ip && mask) {
    lines.push(` ip address ${ip} ${mask}`);
  } else {
    lines.push(` shutdown`);
  }

  // Tunnel interface source/destination
  const extra = router._getOSPFExtraConfig();
  const pending = extra.pendingIfConfig?.get(portName) as any;
  if (pending?.tunnelSource) lines.push(` source ${pending.tunnelSource}`);
  if (pending?.tunnelDest) lines.push(` destination ${pending.tunnelDest}`);

  lines.push('#');
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
  trie.register('display arp static', 'Display static ARP entries', () => displayArpFiltered(getRouter(), 'static'));
  trie.register('display arp dynamic', 'Display dynamic ARP entries', () => displayArpFiltered(getRouter(), 'dynamic'));
  trie.register('display current-configuration', 'Display running configuration', () => {
    const s = getState();
    return displayCurrentConfig(getRouter(), s.isDhcpEnabled(), s.isDhcpSnoopingEnabled(), s.getDhcpSelectGlobal());
  });
  trie.register('display counters', 'Display traffic counters', () => displayCounters(getRouter()));
  trie.register('display rip', 'Display RIP information', () => displayRip(getRouter()));
  trie.register('display ip protocols', 'Display routing protocol status', () => displayIpProtocols(getRouter()));
  trie.register('display ip routing-table statistics', 'Display routing table statistics', () =>
    displayIpRoutingTableStatistics(getRouter()));

  trie.register('display debugging', 'Display active debugging flags', () =>
    displayDebugging(getRouter()));

  trie.register('display ipv6 routing-table', 'Display IPv6 routing table', () =>
    displayIpv6RoutingTable(getRouter()));

  trie.register('display ipv6 interface brief', 'Display IPv6 interface summary', () =>
    displayIpv6InterfaceBrief(getRouter()));

  trie.registerGreedy('display current-configuration interface', 'Display interface running config', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    return displayCurrentConfigInterface(getRouter(), args.join(' '));
  });

  trie.registerGreedy('display interface', 'Display interface information', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    return displayInterface(getRouter(), args.join(' '));
  });

  trie.registerGreedy('display ip pool name', 'Display DHCP pool information', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    return displayIpPool(getRouter(), args.join(' '));
  });

  trie.register('display ip pool', 'Display all DHCP pools', () =>
    displayIpPoolAll(getRouter()));
}

// ─── Interface Name Resolution (Huawei format) ──────────────────────

/**
 * Resolve abbreviated Huawei interface name (backward-compatible wrapper).
 * Delegates to shared resolveHuaweiInterfaceName in cli-utils.
 */
export function resolveHuaweiInterfaceName(router: Router, input: string): string | null {
  return resolveHuaweiIfName(router.getPortNames(), input);
}
