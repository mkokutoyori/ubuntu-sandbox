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
import { IPAddress } from '../../../core/types';
import { resolveHuaweiInterfaceName as resolveHuaweiIfName } from '../cli-utils';
import { runningConfigACL, runningConfigInterfaceACL } from './HuaweiAclCommands';
import {
  displayClock as commonDisplayClock,
  displayCpuUsage as commonDisplayCpuUsage,
  displayMemoryUsage as commonDisplayMemoryUsage,
  displayUsers as commonDisplayUsers,
  displayDevice as commonDisplayDevice,
  displayAlarm as commonDisplayAlarm,
  displayElabel as commonDisplayElabel,
  displayLicense as commonDisplayLicense,
  displayLogbuffer as commonDisplayLogbuffer,
  displayTrapbuffer as commonDisplayTrapbuffer,
  displayPatchInformation as commonDisplayPatchInformation,
  displayDiagnosticInformation as commonDisplayDiagnosticInformation,
} from './HuaweiCommonDisplay';
import {
  AR2220_HARDWARE_PROFILE, renderHardwareVersion,
} from './HuaweiHardwareProfile';

// ─── Display State Accessor (passed from shell) ─────────────────────
export interface HuaweiDisplayState {
  isDhcpEnabled(): boolean;
  isDhcpSnoopingEnabled(): boolean;
  getDhcpSelectGlobal(): Set<string>;
  renderLogbuffer?(): string;
}

// ─── Pure Display Functions ──────────────────────────────────────────

export function displayVersion(router: Router): string {
  return renderHardwareVersion(
    router._getHostnameInternal(),
    '0 days, 0 hours, 0 minutes',
    AR2220_HARDWARE_PROFILE,
  );
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

function huaweiProtoName(r: { type: string }): string {
  switch (r.type) {
    case 'connected': return 'Direct';
    case 'rip': return 'RIP';
    case 'ospf': return 'OSPF';
    case 'eigrp': return 'EIGRP';
    case 'bgp': return 'BGP';
    case 'default': return 'Static';
    default: return 'Static';
  }
}

function huaweiDefaultPreference(type: string): number {
  switch (type) {
    case 'connected': return 0;
    case 'ospf': return 10;
    case 'rip': return 100;
    case 'bgp': return 255;
    default: return 60;
  }
}

function huaweiConnectedNextHop(router: Router, r: any): string {
  const port = router.getPort(r.iface);
  const ip = port?.getIPAddress?.();
  if (ip) return ip.toString();
  return '127.0.0.1';
}

function renderHuaweiRouteRows(router: Router, table: any[]): string[] {
  const rows: string[] = [];
  for (const r of table) {
    const dest = `${r.network}/${r.mask.toCIDR()}`.padEnd(19);
    const proto = huaweiProtoName(r).padEnd(8);
    const pref = r.preference ?? huaweiDefaultPreference(r.type);
    const pre = String(pref).padEnd(5);
    const cost = String(r.metric ?? 0).padEnd(6);
    const flags = (r.type === 'connected' ? 'D' : 'RD').padEnd(6);
    let nh: string;
    if (r.type === 'connected') nh = huaweiConnectedNextHop(router, r);
    else if (r.nextHop) nh = r.nextHop.toString();
    else nh = '0.0.0.0';
    rows.push(`${dest} ${proto}${pre}${cost}${flags}${nh.padEnd(16)}${r.iface}`);
  }
  return rows;
}

export function displayIpRoutingTable(router: Router): string {
  const table = router.getRoutingTable();
  const destSet = new Set(table.map(r => `${r.network}/${r.mask.toCIDR()}`));
  const lines = [
    'Route Flags: R - relay, D - download to fib',
    '------------------------------------------------------------------------------',
    'Routing Tables: Public',
    `         Destinations : ${destSet.size}        Routes : ${table.length}`,
    '',
    'Destination/Mask    Proto   Pre  Cost  Flags NextHop         Interface',
  ];
  lines.push(...renderHuaweiRouteRows(router, table));
  return lines.join('\n');
}

export function displayIpRoutingTableProtocol(router: Router, proto: string): string {
  const wanted = proto.toLowerCase();
  const table = router.getRoutingTable().filter(r => {
    const name = huaweiProtoName(r).toLowerCase();
    if (wanted === 'direct') return r.type === 'connected';
    if (wanted === 'static') return r.type === 'static' || r.type === 'default';
    return name === wanted;
  });
  const destSet = new Set(table.map(r => `${r.network}/${r.mask.toCIDR()}`));
  const head = [
    'Route Flags: R - relay, D - download to fib',
    '------------------------------------------------------------------------------',
    `Public routing table : ${proto.toUpperCase()}`,
    `         Destinations : ${destSet.size}        Routes : ${table.length}`,
    '',
    'Destination/Mask    Proto   Pre  Cost  Flags NextHop         Interface',
  ];
  return [...head, ...renderHuaweiRouteRows(router, table)].join('\n');
}

export function displayIpRoutingTableForDest(router: Router, dest: string): string {
  const table = router.getRoutingTable();
  const targetInt = (() => {
    try { return new IPAddress(dest).toUint32(); } catch { return null; }
  })();
  if (targetInt === null) return `Error: Invalid IP address ${dest}`;
  const matches = table.filter(r => {
    const net = r.network.toUint32();
    const mask = r.mask.toUint32();
    return (targetInt & mask) === (net & mask);
  });
  if (matches.length === 0) return `Route does not exist.`;
  const head = [
    'Route Flags: R - relay, D - download to fib',
    '------------------------------------------------------------------------------',
    `Routing Table : Public`,
    `Summary Count : ${matches.length}`,
    '',
    'Destination/Mask    Proto   Pre  Cost  Flags NextHop         Interface',
  ];
  return [...head, ...renderHuaweiRouteRows(router, matches)].join('\n');
}

export function displayIpIntBrief(router: Router): string {
  const ports = router._getPortsInternal();
  const lines = [
    '*down: administratively down',
    '^down: standby',
    '(l): loopback',
    '(s): spoofing',
    'The number of interface that is UP in Physical is 0',
    'The number of interface that is DOWN in Physical is 0',
    'The number of interface that is UP in Protocol is 0',
    'The number of interface that is DOWN in Protocol is 0',
    '',
    'Interface                         IP Address/Mask      Physical   Protocol',
  ];
  for (const [name, port] of ports) {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const ipStr = ip && mask ? `${ip}/${mask.toCIDR()}` : 'unassigned';
    const phys = (port.getIsUp() ? (port.isConnected() ? 'up' : 'down') : '*down').toUpperCase();
    const proto = (port.getIsUp() && port.isConnected() ? 'up' : 'down').toUpperCase();
    lines.push(`${name.padEnd(34)}${ipStr.padEnd(21)}${phys.padEnd(11)}${proto}`);
  }
  return lines.join('\n');
}

export function displayIpInterface(router: Router, ifName: string): string {
  const portName = resolveHuaweiInterfaceName(router, ifName) || ifName;
  const port = router.getPort(portName);
  if (!port) return `Error: Wrong parameter found at '^' position.`;
  const ip = port.getIPAddress();
  const mask = port.getSubnetMask();
  const isUp = port.getIsUp();
  const conn = port.isConnected();
  const phys = (isUp ? (conn ? 'up' : 'down') : 'administratively down');
  const proto = (isUp && conn ? 'up' : 'down');
  const lines = [
    `${portName} current state : ${phys.toUpperCase()}`,
    `Line protocol current state : ${proto.toUpperCase()}`,
    `Internet Address is ${ip && mask ? `${ip}/${mask.toCIDR()}` : 'unassigned'}`,
    `Broadcast address : ${ip && mask ? ip.toString() : '0.0.0.0'}`,
    `The Maximum Transmit Unit : 1500 bytes`,
    `Input bandwidth utilization  : 0%`,
    `Output bandwidth utilization : 0%`,
    `    Last 300 seconds input rate 0 bits/sec, 0 packets/sec`,
    `    Last 300 seconds output rate 0 bits/sec, 0 packets/sec`,
    `    Input:  0 packets, 0 bytes`,
    `    Output: 0 packets, 0 bytes`,
  ];
  return lines.join('\n');
}

/** `display interface` (all) — real per-port detail. */
export function displayInterfaceAll(router: Router): string {
  const names = [...router._getPortsInternal().keys()];
  if (!names.length) return 'No interfaces present.';
  return names.map((n) => displayInterface(router, n)).join('\n');
}

/** `display interface brief` — real status table. */
export function displayInterfaceBrief(router: Router): string {
  const rows = [
    'PHY: Physical   *down: administratively down',
    'Interface                   PHY     Protocol  InUti OutUti   inErrors  outErrors',
  ];
  for (const [name, port] of router._getPortsInternal()) {
    const phy = port.getIsUp() ? (port.isConnected() ? 'up' : 'down') : '*down';
    const proto = port.getIsUp() && port.isConnected() ? 'up' : 'down';
    rows.push(`${name.padEnd(28)}${phy.padEnd(8)}${proto.padEnd(10)}` +
      `0%    0%       0          0`);
  }
  return rows.join('\n');
}

/** `display interface description` — real description table. */
export function displayInterfaceDescription(router: Router): string {
  const rows = ['Interface                     PHY     Protocol Description'];
  for (const [name, port] of router._getPortsInternal()) {
    const phy = port.getIsUp() ? (port.isConnected() ? 'up' : 'down') : '*down';
    const proto = port.getIsUp() && port.isConnected() ? 'up' : 'down';
    const desc = router.getInterfaceDescription(name) || '';
    rows.push(`${name.padEnd(30)}${phy.padEnd(8)}${proto.padEnd(9)}${desc}`);
  }
  return rows.join('\n');
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
    // Real VRP renders the canonical interface name (GigabitEthernet*)
    // rather than the abbreviated 'GE*' device label.
    const renderedName = name.startsWith('GE') ? name.replace(/^GE/, 'GigabitEthernet') : name;
    lines.push(`interface ${renderedName}`);
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

  // user-interface vty <range> blocks — idle-timeout, acl, protocol, …
  const vtyStore = (router as unknown as { _getVtyLineConfig?: () => { renderAllHuawei: () => string[] } })._getVtyLineConfig?.();
  if (vtyStore) {
    const vty = vtyStore.renderAllHuawei();
    if (vty.length > 0) lines.push(...vty);
  }

  const listUsers = (router as unknown as {
    _listLocalUsers?: () => ReadonlyArray<{ name: string; privilege: number; secret: string; factoryDefault?: boolean }>;
  })._listLocalUsers;
  if (listUsers) {
    const users = listUsers.call(router).filter(u => !u.factoryDefault);
    if (users.length > 0) {
      lines.push('aaa');
      for (const u of users) {
        lines.push(` local-user ${u.name} password cipher ${u.secret}`);
        lines.push(` local-user ${u.name} privilege level ${u.privilege}`);
        lines.push(` local-user ${u.name} service-type ssh`);
      }
      lines.push('#');
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

function renderHuaweiIpv6Rows(rt: any[]): string[] {
  const rows: string[] = [];
  for (const r of rt) {
    const prefix = r.prefix ? `${r.prefix}/${r.prefixLength}` : '::/0';
    const proto = r.type === 'connected' ? 'Direct' : r.type === 'default' ? 'Static' : 'Static';
    const pre = r.preference ?? (r.type === 'connected' ? 0 : 60);
    const cost = r.metric ?? 0;
    const flags = r.type === 'connected' ? 'D' : 'RD';
    const nh = r.nextHop ? r.nextHop.toString() : '::';
    rows.push(`Destination  : ${prefix}`);
    rows.push(`NextHop      : ${nh}`);
    rows.push(`Preference   : ${pre}`);
    rows.push(`Cost         : ${cost}`);
    rows.push(`Protocol     : ${proto}`);
    rows.push(`RelayNextHop : ::`);
    rows.push(`TunnelID     : 0x0`);
    rows.push(`Interface    : ${r.iface || '-'}`);
    rows.push(`Flags        : ${flags}`);
    rows.push('');
  }
  return rows;
}

export function displayIpv6RoutingTable(router: Router): string {
  const rt = (router as any)._getIPv6RoutingTableInternal?.() || [];
  const head = [
    'Routing Table : Public',
    `         Destinations : ${rt.length}        Routes : ${rt.length}`,
    '',
  ];
  if (rt.length === 0) {
    return [...head, 'No IPv6 routes configured.'].join('\n');
  }
  return [...head, ...renderHuaweiIpv6Rows(rt)].join('\n').trimEnd();
}

export function displayIpv6RoutingTableProtocol(router: Router, proto: string): string {
  const wanted = proto.toLowerCase();
  const rt = ((router as any)._getIPv6RoutingTableInternal?.() || []).filter((r: any) => {
    if (wanted === 'direct') return r.type === 'connected';
    if (wanted === 'static') return r.type === 'static' || r.type === 'default';
    return false;
  });
  const head = [
    `Public Routing Table : ${proto.toUpperCase()}`,
    `         Destinations : ${rt.length}        Routes : ${rt.length}`,
    '',
  ];
  if (rt.length === 0) return [...head, 'No IPv6 routes configured.'].join('\n');
  return [...head, ...renderHuaweiIpv6Rows(rt)].join('\n').trimEnd();
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
  trie.registerGreedy('display ip routing-table', 'Display IP routing table', (args) => {
    if (args.length === 0) return displayIpRoutingTable(getRouter());
    if (/^\d+\.\d+\.\d+\.\d+$/.test(args[0])) return displayIpRoutingTableForDest(getRouter(), args[0]);
    return displayIpRoutingTable(getRouter());
  });
  trie.register('display ip traffic', 'Display IP traffic statistics', () => displayCounters(getRouter()));
  trie.register('display arp', 'Display ARP table', () => displayArp(getRouter()));
  trie.register('display arp all', 'Display all ARP entries', () => displayArp(getRouter()));
  trie.register('display arp static', 'Display static ARP entries', () => displayArpFiltered(getRouter(), 'static'));
  trie.register('display arp dynamic', 'Display dynamic ARP entries', () => displayArpFiltered(getRouter(), 'dynamic'));
  trie.register('display current-configuration', 'Display running configuration', () => {
    const s = getState();
    return displayCurrentConfig(getRouter(), s.isDhcpEnabled(), s.isDhcpSnoopingEnabled(), s.getDhcpSelectGlobal());
  });

  trie.register('display saved-configuration', 'Display saved configuration', () => {
    const s = getState();
    return displayCurrentConfig(getRouter(), s.isDhcpEnabled(), s.isDhcpSnoopingEnabled(), s.getDhcpSelectGlobal());
  });

  trie.register('display startup', 'Display startup configuration', () => {
    return [
      'MainBoard:',
      `  Configured startup system software:    flash:/vrp.cc`,
      `  Startup system software:                flash:/vrp.cc`,
      `  Next startup system software:           flash:/vrp.cc`,
      `  Startup saved-configuration file:       flash:/vrpcfg.zip`,
      `  Next startup saved-configuration file:  flash:/vrpcfg.zip`,
      `  Startup license file:                   NULL`,
      `  Next startup license file:              NULL`,
      `  Startup patch package:                  NULL`,
      `  Next startup patch package:             NULL`,
    ].join('\n');
  });

  trie.registerGreedy('display history-command', 'Display CLI history', () => {
    return 'Info: No history command.';
  });

  trie.registerGreedy('display alarm', 'Display alarm records', () =>
    commonDisplayAlarm());

  trie.register('display aaa configuration', 'Display AAA configuration', () => {
    return [
      '  Domain Name           : default',
      '  Domain State          : Active',
      '  Authentication-scheme : default',
      '  Authorization-scheme  : default',
      '  Accounting-scheme     : default',
      '  Service-scheme        : -',
      '  RADIUS-server-template: -',
      '  HWTACACS-server-template: -',
    ].join('\n');
  });

  trie.register('display aaa online-fail-record', 'Display AAA failed login attempts', () => {
    return 'Info: No online-fail record.';
  });

  trie.register('display user-interface', 'Display user interface info', () => {
    const vty = (getRouter() as unknown as { _getVtyLineConfig?: () => { renderAllHuawei: () => string[] } })._getVtyLineConfig?.();
    const cfg = vty ? vty.renderAllHuawei() : [];
    const lines = [
      '  Idx    Type            Tx/Rx    Modem  Privi  ActualPrivi  Auth   Int',
      '+ 0      CON 0           9600     -      0      0            N      -',
      '  34     VTY 0           -        -      0      0            N      -',
      '  35     VTY 1           -        -      0      0            N      -',
      '  36     VTY 2           -        -      0      0            N      -',
      '  37     VTY 3           -        -      0      0            N      -',
      '  38     VTY 4           -        -      0      0            N      -',
    ];
    if (cfg.length > 0) { lines.push(''); lines.push(...cfg); }
    return lines.join('\n');
  });

  trie.register('display dhcp server statistics', 'Display DHCP server statistics', () => {
    const dhcp = getRouter()._getDHCPServerInternal();
    const pools = dhcp.getAllPools();
    return [
      'DHCP server packets statistics:',
      '  Receive total: 0',
      '  Send total: 0',
      '  Discover: 0      Offer: 0',
      '  Request: 0       Ack: 0',
      '  Nak: 0           Release: 0',
      '  Inform: 0        Decline: 0',
      `Pool number: ${pools.size}`,
    ].join('\n');
  });

  trie.register('display nat session all', 'Display NAT session table', () => {
    return 'Info: No NAT session is found.';
  });

  trie.register('display nat address-group', 'Display NAT address groups', () => {
    return 'Info: No NAT address-group is configured.';
  });

  trie.register('display vrrp', 'Display VRRP groups', () => {
    return 'Info: No VRRP backup group is configured.';
  });

  trie.register('display vrrp brief', 'Display VRRP brief', () => {
    return [
      'Total: 0     Master: 0     Backup: 0     Non-active: 0',
      'VRID  State        Interface                Type     Virtual IP',
    ].join('\n');
  });

  trie.register('display lldp neighbor', 'Display LLDP neighbors', () => {
    return 'Info: No LLDP neighbor is found.';
  });

  trie.register('display lldp neighbor brief', 'Display LLDP brief', () => {
    return 'Local Intf    Neighbor Dev    Neighbor Intf    Exptime(s)';
  });

  trie.registerGreedy('display bgp peer', 'Display BGP peers', () => {
    return 'Info: BGP is not running.';
  });

  trie.registerGreedy('display bgp routing-table', 'Display BGP routing table', () => {
    return 'Info: BGP is not running.';
  });

  trie.register('display ospf routing', 'Display OSPF routing', () => {
    const ospf = getRouter()._getOSPFEngineInternal();
    if (!ospf) return 'Info: OSPF is not running.';
    return 'OSPF Process 1 with Router ID 0.0.0.0\n  Routing Tables\n\n  Routing for Network';
  });

  trie.registerGreedy('display rip', 'Display RIP info', (args) => {
    if (args[1] === 'route') {
      if (!getRouter().isRIPEnabled()) return 'Info: RIP is not enabled.';
      const routes = getRouter().getRIPRoutes();
      const lines = ['  Peer       Family      Destination/Mask      Nexthop      Cost  Tag    Flags'];
      for (const [key, info] of routes) {
        lines.push(`  ${info.learnedFrom}      IPv4        ${key}      ${info.learnedFrom}    ${info.metric}     0      A`);
      }
      return lines.join('\n');
    }
    return displayRip(getRouter());
  });
  trie.register('display counters', 'Display traffic counters', () => displayCounters(getRouter()));
  trie.register('display rip', 'Display RIP information', () => displayRip(getRouter()));
  trie.register('display ip protocols', 'Display routing protocol status', () => displayIpProtocols(getRouter()));
  trie.register('display ip routing-table statistics', 'Display routing table statistics', () =>
    displayIpRoutingTableStatistics(getRouter()));

  trie.registerGreedy('display ip routing-table protocol', 'Filter routes by protocol', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    return displayIpRoutingTableProtocol(getRouter(), args[0]);
  });

  trie.registerGreedy('display ip routing-table verbose', 'Verbose routing table', () =>
    displayIpRoutingTable(getRouter()));

  trie.register('display ip routing-table limit', 'Display routing table limit', () =>
    `Routing Table Limit:\n  Configured : unlimited\n  Current    : ${getRouter().getRoutingTable().length}`);

  trie.register('display router id', 'Display router id', () => {
    const ports = getRouter()._getPortsInternal();
    for (const [, p] of ports) {
      const ip = p.getIPAddress?.();
      if (ip) return `Router ID: ${ip}`;
    }
    return 'Router ID: 0.0.0.0';
  });

  trie.register('display fib', 'Display forwarding table', () => displayIpRoutingTable(getRouter()));

  trie.registerGreedy('display ipv6 routing-table protocol', 'Filter IPv6 routes by protocol', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    return displayIpv6RoutingTableProtocol(getRouter(), args[0]);
  });

  trie.registerGreedy('display ip interface', 'Display IP interface details', (args) => {
    if (args.length === 0) return displayIpIntBrief(getRouter());
    const first = args[0].toLowerCase();
    if ('brief'.startsWith(first)) return displayIpIntBrief(getRouter());
    return displayIpInterface(getRouter(), args.join(' '));
  });

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
    const sub = (args[0] || '').toLowerCase();
    if (args.length === 0) return displayInterfaceAll(getRouter());
    if (sub === 'brief') return displayInterfaceBrief(getRouter());
    if (sub === 'description') return displayInterfaceDescription(getRouter());
    return displayInterface(getRouter(), args.join(' '));
  });

  trie.registerGreedy('display ip pool name', 'Display DHCP pool information', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    return displayIpPool(getRouter(), args.join(' '));
  });

  trie.register('display ip pool', 'Display all DHCP pools', () =>
    displayIpPoolAll(getRouter()));

  // ── Common VRP display commands (shared with the switch, DRY) ──
  trie.register('display clock', 'Display system clock', () => commonDisplayClock());
  trie.register('display cpu-usage', 'Display CPU usage', () => commonDisplayCpuUsage());
  trie.register('display memory-usage', 'Display memory usage', () => commonDisplayMemoryUsage());
  trie.register('display users', 'Display user sessions', () => commonDisplayUsers());
  trie.register('display device', 'Display device status', () =>
    commonDisplayDevice(getRouter().getHostname(), AR2220_HARDWARE_PROFILE));
  trie.register('display alarm', 'Display alarm records', () => commonDisplayAlarm());
  trie.register('display elabel', 'Display electronic label', () =>
    commonDisplayElabel(getRouter().getHostname(), AR2220_HARDWARE_PROFILE));
  trie.register('display license', 'Display license information', () => commonDisplayLicense());
  trie.register('display logbuffer', 'Display log buffer', () =>
    getState().renderLogbuffer?.() ?? commonDisplayLogbuffer(),
  );
  trie.register('display trapbuffer', 'Display trap buffer', () => commonDisplayTrapbuffer());
  trie.register('display patch-information', 'Display patch information', () =>
    commonDisplayPatchInformation());
  trie.register('display diagnostic-information', 'Collect diagnostic information', () =>
    commonDisplayDiagnosticInformation());
}

// ─── Interface Name Resolution (Huawei format) ──────────────────────

/**
 * Resolve abbreviated Huawei interface name (backward-compatible wrapper).
 * Delegates to shared resolveHuaweiInterfaceName in cli-utils.
 */
export function resolveHuaweiInterfaceName(router: Router, input: string): string | null {
  return resolveHuaweiIfName(router.getPortNames(), input);
}
