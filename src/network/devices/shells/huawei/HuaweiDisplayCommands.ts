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
import { huaweiCipher, huaweiIrreversibleCipher } from '@/crypto';
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
    if (dhcp.isSnoopingEnabled(name)) {
      lines.push(` dhcp snooping enable`);
    }
    lines.push(...renderHuaweiInterfaceExtras(router, port, name));
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
    _listLocalUsers?: () => ReadonlyArray<{ name: string; privilege: number; secret: string; secretAlgo?: string; factoryDefault?: boolean }>;
  })._listLocalUsers;
  if (listUsers) {
    const users = listUsers.call(router).filter(u => !u.factoryDefault);
    if (users.length > 0) {
      lines.push('aaa');
      for (const u of users) {
        // Real VRP never echoes the cleartext: 'cipher' is reversible
        // (AES), everything else is hashed one-way (irreversible-cipher).
        const field = u.secretAlgo === 'cipher'
          ? `password cipher ${huaweiCipher(u.secret)}`
          : `password irreversible-cipher ${huaweiIrreversibleCipher(u.secret)}`;
        lines.push(` local-user ${u.name} ${field}`);
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

export function displayIpv6Interface(router: Router, ifName: string): string {
  const portName = resolveHuaweiInterfaceName(router, ifName) || ifName;
  const port = router.getPort(portName);
  if (!port) return `Error: Wrong parameter found at '^' position.`;
  const ipv6Enabled = (port as any).ipv6Enabled === true;
  const addrs = port.getIPv6Addresses?.() || [];
  const isUp = port.getIsUp();
  const isConn = port.isConnected();
  const isVirtual = /^(LoopBack|Tunnel)/i.test(portName);
  const ipv6Mtu = (port as any).ipv6Mtu;
  const raHalt = (port as any).ipv6NdRaHalt === true;
  const lines = [
    `${portName} current state : ${isUp ? (isConn || isVirtual ? 'UP' : 'DOWN') : 'Administratively DOWN'}`,
    `IPv6 protocol current state : ${ipv6Enabled ? 'UP' : 'DOWN'}`,
  ];
  if (addrs.length === 0) lines.push('IPv6 is enabled, link-local address is not assigned');
  for (const a of addrs as Array<{ address: string; prefixLength: number }>) {
    lines.push(`  Global unicast address(es):`);
    lines.push(`    ${a.address}, subnet is ${a.address}/${a.prefixLength}`);
  }
  if (ipv6Mtu) lines.push(`MTU is ${ipv6Mtu} bytes`);
  if (raHalt) lines.push('ND RA messages are suppressed');
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

  appendManagementConfig(lines, router);

  const routingExtras = (router as unknown as { getHuaweiRoutingExtras?: () => import('../../router/routing/HuaweiRoutingExtras').HuaweiRoutingExtras }).getHuaweiRoutingExtras?.();
  if (routingExtras) {
    const rl = routingExtras.asRunningConfigLines();
    if (rl.length > 0) { lines.push('#'); lines.push(...rl); }
  }

  const bfd = (router as unknown as { getHuaweiBfdService?: () => import('../../router/bfd/HuaweiBfdService').HuaweiBfdService }).getHuaweiBfdService?.();
  if (bfd) {
    const bl = bfd.asRunningConfigLines();
    if (bl.length > 0) { lines.push('#'); lines.push(...bl); }
  }

  return lines.join('\n');
}

function appendManagementConfig(lines: string[], router: Router): void {
  const mgmt = (router as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
  if (!mgmt) return;

  const stelnet = mgmt.getStelnet();
  if (stelnet.enabled) { lines.push('#'); lines.push('stelnet server enable'); }
  const telnet = mgmt.getTelnet();
  if (telnet.enabled) { lines.push('#'); lines.push('telnet server enable'); }
  const ssh = mgmt.getSsh();
  if (ssh.enabled) {
    lines.push('#');
    lines.push('ssh server enable');
    if (ssh.port !== 22) lines.push(`ssh server port ${ssh.port}`);
  }
  const snmp = mgmt.getSnmp();
  if (snmp.enabled) {
    lines.push('#');
    if (snmp.sysContact) lines.push(`snmp-agent sys-info contact ${snmp.sysContact}`);
    if (snmp.sysLocation) lines.push(`snmp-agent sys-info location ${snmp.sysLocation}`);
    for (const [, c] of snmp.communities) {
      lines.push(`snmp-agent community ${c.access} ${c.name}${c.aclName ? ' acl ' + c.aclName : ''}`);
    }
    for (const t of snmp.trapHosts) {
      lines.push(`snmp-agent target-host ${t.host} params securityname ${t.community} ${t.version}`);
    }
    for (const r of mgmt.getRawEntries('snmp')) lines.push(`snmp-agent ${r.line}`);
  }
  const ntp = mgmt.getNtp();
  const ntpRaw = mgmt.getRawEntries('ntp');
  if (ntpRaw.length > 0 || ntp.sourceInterface || ntp.authentication || ntp.masterStratum) {
    lines.push('#');
    if (ntp.sourceInterface) lines.push(`ntp-service source-interface ${ntp.sourceInterface}`);
    if (ntp.authentication) lines.push('ntp-service authentication enable');
    for (const [id, k] of ntp.authKeys) {
      lines.push(`ntp-service authentication-keyid ${id} authentication-mode ${k.algo} ${k.key}`);
    }
    for (const id of ntp.trustedKeys) {
      lines.push(`ntp-service reliable authentication-keyid ${id}`);
    }
    if (ntp.accessAcl) lines.push(`ntp-service access-acl ${ntp.accessAcl}`);
    if (ntp.masterStratum !== undefined) lines.push(`ntp-service refclock-master ${ntp.masterStratum}`);
    for (const r of ntpRaw) lines.push(`ntp-service ${r.line}`);
  }
  const clock = mgmt.getClock();
  if (clock.timezone !== 'UTC' || clock.summerTimezone) {
    lines.push('#');
    if (clock.timezone !== 'UTC') {
      const sign = clock.offsetMin >= 0 ? 'add' : 'minus';
      const abs = Math.abs(clock.offsetMin);
      lines.push(`clock timezone ${clock.timezone} ${sign} ${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`);
    }
    if (clock.summerTimezone) {
      lines.push(`clock daylight-saving-time ${clock.summerTimezone} repeating ${clock.daylightStart} ${clock.daylightEnd}`);
    }
  }
  const info = mgmt.getInfoCenter();
  if (info.enabled && (info.sources.length > 0 || info.loghosts.length > 0)) {
    lines.push('#');
    lines.push(`info-center enable`);
    if (info.timestamp !== 'date') lines.push(`info-center timestamp ${info.timestamp}`);
    for (const s of info.sources) lines.push(`info-center source ${s.source} channel ${s.channel} level ${s.severity}`);
    for (const h of info.loghosts) lines.push(`info-center loghost ${h.ip} channel ${h.channel} facility ${h.facility}`);
  }
  const sflow = mgmt.getSflow();
  if (sflow.enabled) {
    lines.push('#');
    if (sflow.agentIp) lines.push(`sflow agent ip ${sflow.agentIp}`);
    for (const c of sflow.collectors) lines.push(`sflow collector ${c.id} ip ${c.ip} port ${c.port}`);
    for (const s of sflow.samplers) lines.push(`sflow sampling rate ${s.rate}`);
  }
  const routingLimit = (router as unknown as { getRoutingTableLimit?: () => { max: number; thresholdPct?: number } | null }).getRoutingTableLimit?.();
  if (routingLimit) {
    lines.push('#');
    lines.push(`ip routing-table limit ${routingLimit.max}${routingLimit.thresholdPct !== undefined ? ' ' + routingLimit.thresholdPct : ''}`);
  }
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

  lines.push(...renderHuaweiInterfaceExtras(router, port, portName));

  const vrrp = (router as unknown as { getHuaweiVrrpService?: () => import('../../router/redundancy/HuaweiVrrpService').HuaweiVrrpService }).getHuaweiVrrpService?.();
  if (vrrp) lines.push(...vrrp.asInterfaceRunningConfigLines(portName));

  lines.push('#');
  return lines.join('\n');
}

export function renderHuaweiInterfaceExtras(router: Router, port: any, portName: string): string[] {
  const lines: string[] = [];
  const extra = router._getOSPFExtraConfig();
  const pending = extra.pendingIfConfig?.get(portName) as any;
  if (pending?.tunnelProtocol) lines.push(` tunnel-protocol ${pending.tunnelProtocol}`);
  if (pending?.tunnelSource) lines.push(` source ${pending.tunnelSource}`);
  if (pending?.tunnelDest) lines.push(` destination ${pending.tunnelDest}`);
  if (pending?.greKey !== undefined) lines.push(` gre key ${pending.greKey}`);
  if (pending?.ipsecProfile) lines.push(` ipsec profile ${pending.ipsecProfile}`);
  if (pending?.tunnelKeepalivePeriod !== undefined) {
    const kp = pending.tunnelKeepalivePeriod;
    const kr = pending.tunnelKeepaliveRetry;
    lines.push(` keepalive period ${kp}${kr !== undefined ? ` retry-times ${kr}` : ''}`);
  }
  if (port.dot1qVlan !== undefined) lines.push(` dot1q termination vid ${port.dot1qVlan}`);
  if (port.arpBroadcastEnabled) lines.push(` arp broadcast enable`);
  if (port.proxyArp) lines.push(` arp-proxy enable`);
  if (port.arpTimeoutSec !== undefined && port.arpTimeoutSec !== 4 * 60 * 60 && typeof port.getArpTimeoutSec === 'function') {
    lines.push(` arp expire-time ${port.getArpTimeoutSec()}`);
  }
  if (typeof port.getMTU === 'function' && port.getMTU() !== 1500) lines.push(` mtu ${port.getMTU()}`);
  if (typeof port.getBandwidthKbps === 'function' && port.getBandwidthKbps() > 0) lines.push(` bandwidth ${port.getBandwidthKbps()}`);
  if (port.configuredMacAddress) lines.push(` mac-address ${port.configuredMacAddress}`);
  if (port.loopbackInternal) lines.push(` loopback internal`);
  if (port.flowControl) lines.push(` flow-control`);
  if (port.ipv6Enabled) lines.push(` ipv6 enable`);
  if (port.ipv6Mtu) lines.push(` ipv6 mtu ${port.ipv6Mtu}`);
  if (port.ipv6NdRaHalt) lines.push(` ipv6 nd ra halt`);
  return lines;
}

// ─── Trie Registration ──────────────────────────────────────────────

function huaweiVrrpAgent(router: Router): import('../../../vrrp/VrrpAgent').VrrpAgent | undefined {
  return (router as unknown as { getVrrpAgent?: () => import('../../../vrrp/VrrpAgent').VrrpAgent }).getVrrpAgent?.();
}

function huaweiVrrpLiveState(
  router: Router,
  ifName: string,
  vrid: number,
): 'Initialize' | 'Backup' | 'Master' | undefined {
  const live = huaweiVrrpAgent(router)?.getGroup(ifName, vrid);
  if (!live) return undefined;
  if (live.state === 'master') return 'Master';
  if (live.state === 'backup') return 'Backup';
  return 'Initialize';
}

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
    const dev = getRouter() as unknown as { getShell?: () => { getCmdHistory?: () => readonly string[] } };
    const shell = dev.getShell?.();
    const history = shell?.getCmdHistory?.() ?? [];
    if (history.length === 0) return 'Info: No history command.';
    return history.join('\n');
  });

  trie.registerGreedy('display alarm', 'Display alarm records', () =>
    commonDisplayAlarm());

  trie.register('display aaa configuration', 'Display AAA configuration', () => {
    const aaa = (getRouter() as unknown as { getShell?: () => { getAaaExtraConfig?: () => { authenticationSchemes: string[]; authorizationSchemes: string[]; accountingSchemes: string[]; domains: string[] } | null } }).getShell?.();
    const cfg = aaa?.getAaaExtraConfig?.();
    if (!cfg) {
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
    }
    const lines: string[] = [];
    const domains = cfg.domains.length > 0 ? cfg.domains : ['default'];
    for (const d of domains) {
      lines.push(`  Domain Name           : ${d}`);
      lines.push('  Domain State          : Active');
      lines.push(`  Authentication-scheme : ${cfg.authenticationSchemes[0] ?? 'default'}`);
      lines.push(`  Authorization-scheme  : ${cfg.authorizationSchemes[0] ?? 'default'}`);
      lines.push(`  Accounting-scheme     : ${cfg.accountingSchemes[0] ?? 'default'}`);
      lines.push('  Service-scheme        : -');
      lines.push('  RADIUS-server-template: -');
      lines.push('  HWTACACS-server-template: -');
    }
    return lines.join('\n');
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

  trie.register('display dhcp snooping configuration', 'Display DHCP snooping configuration', () => {
    const sw = (getRouter() as unknown as { getSecurityService?: () => import('../../switch/SwitchSecurityService').SwitchSecurityService }).getSecurityService?.();
    if (!sw) return 'Info: DHCP snooping is not configured';
    const enabled = sw.isDhcpSnoopingEnabled();
    const vlans = sw.getDhcpSnoopingVlans();
    const trust = sw.getDhcpSnoopingTrust();
    const lines = [
      `DHCP snooping global status : ${enabled ? 'enabled' : 'disabled'}`,
      `DHCP snooping enabled VLANs : ${vlans.length === 0 ? 'none' : vlans.join(',')}`,
    ];
    if (trust.length > 0) {
      lines.push('Trusted interfaces:');
      for (const t of trust) lines.push(`  ${t.ifName}`);
    }
    return lines.join('\n');
  });

  trie.register('display arp anti-attack configuration', 'Display ARP anti-attack configuration', () => {
    const sw = (getRouter() as unknown as { getSecurityService?: () => import('../../switch/SwitchSecurityService').SwitchSecurityService }).getSecurityService?.();
    if (!sw) return 'Info: ARP anti-attack is not configured';
    const policies = sw.getArpAntiAttackPolicies();
    if (policies.length === 0) return 'Info: ARP anti-attack is not configured';
    return policies.map(p =>
      `ARP anti-attack: validateSource=${!!p.validateSource}, rateLimit=${p.rateLimit ?? 'none'}, detectionMode=${p.detectionMode ?? 'none'}`
    ).join('\n');
  });

  trie.register('display ip source check user-bind configuration', 'Display IP source guard configuration', () => {
    const sw = (getRouter() as unknown as { getSecurityService?: () => import('../../switch/SwitchSecurityService').SwitchSecurityService }).getSecurityService?.();
    if (!sw) return 'Info: IP source guard is not configured';
    const enabled = sw.isIpSourceGuardEnabled();
    const bindings = sw.getIpSourceGuardBindings();
    const lines = [`IP source guard global status: ${enabled ? 'enabled' : 'disabled'}`];
    if (bindings.length === 0) {
      lines.push('Info: No static user bindings configured');
    } else {
      lines.push('Static bindings:');
      for (const b of bindings) {
        lines.push(`  ip=${b.ipAddress ?? '-'} mac=${b.macAddress ?? '-'} interface=${b.ifName ?? '-'} vlan=${b.vlan ?? '-'} type=${b.type}`);
      }
    }
    return lines.join('\n');
  });

  trie.register('display dhcp server statistics', 'Display DHCP server statistics', () => {
    const dhcp = getRouter()._getDHCPServerInternal();
    const pools = dhcp.getAllPools();
    const s = (dhcp as unknown as { getStats?: () => { discovers: number; offers: number; requests: number; acks: number; naks: number; releases: number; informs: number; declines: number } }).getStats?.() ?? {
      discovers: 0, offers: 0, requests: 0, acks: 0, naks: 0, releases: 0, informs: 0, declines: 0,
    };
    const total = s.discovers + s.requests + s.releases + s.informs + s.declines;
    const sent = s.offers + s.acks + s.naks;
    return [
      'DHCP server packets statistics:',
      `  Receive total: ${total}`,
      `  Send total: ${sent}`,
      `  Discover: ${s.discovers}      Offer: ${s.offers}`,
      `  Request: ${s.requests}       Ack: ${s.acks}`,
      `  Nak: ${s.naks}           Release: ${s.releases}`,
      `  Inform: ${s.informs}        Decline: ${s.declines}`,
      `Pool number: ${pools.size}`,
    ].join('\n');
  });

  trie.register('display nat session all', 'Display NAT session table', () => {
    const nat = (getRouter() as unknown as { _getNATEngine?: () => { getSessions?: () => readonly { localIP: string; localPort: number; outsideGlobal?: string; outsideGlobalPort?: number; protocol: number }[] } })._getNATEngine?.();
    const sessions = nat?.getSessions?.() ?? [];
    if (sessions.length === 0) return 'Info: No NAT session is found.';
    const lines = ['Protocol  Local                         Global                        Outside'];
    for (const s of sessions) {
      lines.push(`${String(s.protocol).padEnd(10)}${(s.localIP + ':' + s.localPort).padEnd(30)}${(s.outsideGlobal ?? '-') + ':' + (s.outsideGlobalPort ?? 0)}`);
    }
    return lines.join('\n');
  });

  trie.register('display nat address-group', 'Display NAT address groups', () => {
    const nat = (getRouter() as unknown as { _getNATEngine?: () => { getPools?: () => Map<string, { name: string; startIP: string; endIP: string }> } })._getNATEngine?.();
    const pools = nat?.getPools?.();
    if (!pools || pools.size === 0) return 'Info: No NAT address-group is configured.';
    return [...pools.values()].map(p => `${p.name}: ${p.startIP} - ${p.endIP}`).join('\n');
  });

  trie.register('display vrrp', 'Display VRRP groups', () => {
    const svc = (getRouter() as unknown as { getHuaweiVrrpService?: () => import('../../router/redundancy/HuaweiVrrpService').HuaweiVrrpService }).getHuaweiVrrpService?.();
    const groups = svc?.list() ?? [];
    if (groups.length === 0) return 'Info: No VRRP backup group is configured.';
    return groups.map(g => [
      `${g.ifName} | Virtual Router ${g.vrid}`,
      `    State : ${huaweiVrrpLiveState(getRouter(), g.ifName, g.vrid) ?? g.state}`,
      `    Virtual IP : ${g.virtualIps.join(', ') || '<none>'}`,
      `    Priority : ${g.priority}`,
      `    Advertisement timer : ${g.advertiseTimerSec} seconds`,
      `    Preempt mode : ${g.preemptMode ? 'Yes' : 'No'}${g.preemptDelaySec > 0 ? ' (delay ' + g.preemptDelaySec + 's)' : ''}`,
      `    Authentication : ${g.authMode}`,
      g.description ? `    Description : ${g.description}` : '',
    ].filter(Boolean).join('\n')).join('\n');
  });
  trie.registerGreedy('display vrrp interface', 'Display VRRP on interface', (args) => {
    const svc = (getRouter() as unknown as { getHuaweiVrrpService?: () => import('../../router/redundancy/HuaweiVrrpService').HuaweiVrrpService }).getHuaweiVrrpService?.();
    const ifName = args.join(' ');
    const groups = svc?.list().filter(g => g.ifName === ifName) ?? [];
    if (groups.length === 0) return `Info: No VRRP group on ${ifName}`;
    return groups.map(g => `VRID ${g.vrid}: state=${huaweiVrrpLiveState(getRouter(), g.ifName, g.vrid) ?? g.state} virtual-ip=${g.virtualIps.join(',')}`).join('\n');
  });
  trie.register('display vrrp statistics', 'Display VRRP statistics', () => {
    const svc = (getRouter() as unknown as { getHuaweiVrrpService?: () => import('../../router/redundancy/HuaweiVrrpService').HuaweiVrrpService }).getHuaweiVrrpService?.();
    const groups = svc?.list() ?? [];
    if (groups.length === 0) return 'Info: No VRRP groups';
    return groups.map(g => `${g.ifName} | VRID ${g.vrid} | Adv sent: 0 received: 0 | Track triggers: ${g.trackEntries.length}`).join('\n');
  });

  trie.register('display bfd configuration all', 'Display BFD configuration', () => {
    const svc = (getRouter() as unknown as { getHuaweiBfdService?: () => import('../../router/bfd/HuaweiBfdService').HuaweiBfdService }).getHuaweiBfdService?.();
    if (!svc || !svc.isEnabled()) return 'Info: BFD is not enabled';
    const sessions = svc.list();
    if (sessions.length === 0) return 'Info: No BFD sessions configured';
    return sessions.map(s => [
      `Session: ${s.name}`,
      `  Peer IP: ${s.peerIp ?? '<not set>'}`,
      `  Source IP: ${s.sourceIp ?? '<not set>'}`,
      s.outIface ? `  Interface: ${s.outIface}` : '',
      `  Local discriminator: ${s.discriminatorLocal ?? 'auto'}`,
      `  Remote discriminator: ${s.discriminatorRemote ?? 'auto'}`,
      `  Min Tx interval: ${s.minTxIntervalMs ?? 'default'}ms`,
      `  Min Rx interval: ${s.minRxIntervalMs ?? 'default'}ms`,
      `  Detect multiplier: ${s.detectMultiplier ?? 3}`,
    ].filter(Boolean).join('\n')).join('\n\n');
  });
  trie.register('display bfd session all', 'Display BFD sessions', () => {
    const svc = (getRouter() as unknown as { getHuaweiBfdService?: () => import('../../router/bfd/HuaweiBfdService').HuaweiBfdService }).getHuaweiBfdService?.();
    if (!svc) return 'Info: BFD is not enabled';
    const sessions = svc.list();
    if (sessions.length === 0) return 'Info: No BFD sessions';
    const lines = ['Local Remote      PeerIpAddr       State     Type        InterfaceName'];
    for (const s of sessions) {
      lines.push(`${String(s.discriminatorLocal ?? '-').padEnd(6)}${String(s.discriminatorRemote ?? '-').padEnd(12)}${(s.peerIp ?? '-').padEnd(17)}${s.state.padEnd(10)}${(s.auto ? 'AUTO' : 'STATIC').padEnd(12)}${s.outIface ?? '-'}`);
    }
    return lines.join('\n');
  });

  trie.registerGreedy('display qos car interface', 'Display QoS CAR', () => 'Info: No QoS CAR configured');
  trie.registerGreedy('display qos configuration interface', 'Display QoS configuration', () => 'Info: No QoS policy configured');
  trie.registerGreedy('display qos cq interface', 'Display custom queue', () => 'Info: Custom queueing not configured');
  trie.registerGreedy('display qos pq interface', 'Display priority queue', () => 'Info: Priority queueing not configured');
  trie.registerGreedy('display qos queue statistics interface', 'Display QoS queue stats', () => 'Info: No QoS statistics');
  trie.register('display qos map-table', 'Display QoS map tables', () => 'Info: No QoS map tables');
  trie.registerGreedy('display traffic classifier', 'Display traffic classifiers', () => 'Info: No traffic classifiers configured');
  trie.registerGreedy('display traffic behavior', 'Display traffic behaviors', () => 'Info: No traffic behaviors configured');
  trie.registerGreedy('display traffic policy', 'Display traffic policies', () => 'Info: No traffic policies configured');

  trie.register('display vrrp brief', 'Display VRRP brief', () => {
    const svc = (getRouter() as unknown as { getHuaweiVrrpService?: () => import('../../router/redundancy/HuaweiVrrpService').HuaweiVrrpService }).getHuaweiVrrpService?.();
    const groups = svc?.list() ?? [];
    const states = groups.map(g => huaweiVrrpLiveState(getRouter(), g.ifName, g.vrid) ?? g.state);
    const master = states.filter(s => s === 'Master').length;
    const backup = states.filter(s => s === 'Backup').length;
    const total = groups.length;
    const lines = [
      `Total: ${total}     Master: ${master}     Backup: ${backup}     Non-active: ${total - master - backup}`,
      'VRID  State        Interface                Type     Virtual IP',
    ];
    groups.forEach((g, idx) => lines.push(`${String(g.vrid).padEnd(6)}${states[idx].padEnd(13)}${g.ifName.padEnd(25)}Normal   ${g.virtualIps.join(',')}`));
    return lines.join('\n');
  });

  trie.register('display ssh server status', 'Display SSH server status', () => {
    const mgmt = (getRouter() as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
    const ssh = mgmt?.getSsh();
    if (!ssh || !ssh.enabled) return 'SSH server: Disabled';
    return [
      `SSH version: ${ssh.version}`,
      `SSH authentication retries: ${ssh.retries}`,
      `SSH server timeout (sec): ${ssh.timeout}`,
      `SSH server port: ${ssh.port}`,
    ].join('\n');
  });

  trie.register('display stelnet server', 'Display STelnet server status', () => {
    const mgmt = (getRouter() as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
    const st = mgmt?.getStelnet();
    if (!st || !st.enabled) return 'STelnet server: Disabled';
    return `STelnet server: Enabled\nSTelnet server port: ${st.port}`;
  });

  trie.register('display telnet server status', 'Display Telnet server status', () => {
    const mgmt = (getRouter() as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
    const tn = mgmt?.getTelnet();
    if (!tn || !tn.enabled) return 'Telnet server: Disabled';
    return `Telnet server: Enabled\nTelnet server port: ${tn.port}`;
  });

  trie.register('display snmp-agent local-engineid', 'Display SNMP engine ID', () => {
    const snmp = (getRouter() as unknown as { getSnmpService?: () => import('../../router/management/SnmpService').SnmpService }).getSnmpService?.();
    return snmp ? `SNMP local EngineID: ${snmp.getEngineId()}` : 'SNMP is not enabled';
  });

  trie.register('display snmp-agent sys-info', 'Display SNMP system info', () => {
    const snmp = (getRouter() as unknown as { getSnmpService?: () => import('../../router/management/SnmpService').SnmpService }).getSnmpService?.();
    if (!snmp) return 'SNMP is not enabled';
    return [
      `Contact: ${snmp.getContact() || '<not set>'}`,
      `Location: ${snmp.getLocation() || '<not set>'}`,
      `Chassis-id: ${snmp.getChassisId() || '<not set>'}`,
    ].join('\n');
  });

  trie.register('display ntp-service status', 'Display NTP service status', () => {
    const ntp = (getRouter() as unknown as { getNtpAgent?: () => { isSynced: () => boolean; getConfig: () => { localStratum: number; sourceInterface: string; refIdentifier: string } } }).getNtpAgent?.();
    if (!ntp) return 'Clock is unsynchronized';
    const synced = ntp.isSynced();
    const cfg = ntp.getConfig();
    return [
      `Clock status: ${synced ? 'synchronized' : 'unsynchronized'}`,
      `Clock stratum: ${cfg.localStratum}`,
      `Reference clock ID: ${cfg.refIdentifier || '.INIT.'}`,
      cfg.sourceInterface ? `Source interface: ${cfg.sourceInterface}` : '',
    ].filter(Boolean).join('\n');
  });

  trie.register('display ntp-service sessions', 'Display NTP sessions', () => {
    const ntp = (getRouter() as unknown as { getNtpAgent?: () => { getConfig: () => { associations: Map<string, { serverIp: string; stratum: number; pollSec: number; preferred: boolean }> } } }).getNtpAgent?.();
    const assocs = ntp?.getConfig().associations;
    if (!assocs || assocs.size === 0) return 'No NTP associations';
    const lines = ['  address         stratum poll reach   delay   offset    disp'];
    for (const [, a] of assocs) {
      lines.push(`  ${a.serverIp.padEnd(15)} ${String(a.stratum).padEnd(7)} ${String(a.pollSec).padEnd(4)} 377     0.0     0.0       0.0${a.preferred ? '  *' : ''}`);
    }
    return lines.join('\n');
  });

  trie.register('display info-center', 'Display info-center configuration', () => {
    const mgmt = (getRouter() as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
    const ic = mgmt?.getInfoCenter();
    if (!ic) return 'Info-center: Disabled';
    return [
      `Info-center: ${ic.enabled ? 'Enabled' : 'Disabled'}`,
      `Timestamp format: ${ic.timestamp}`,
      `Configured sources: ${ic.sources.length}`,
      `Configured loghosts: ${ic.loghosts.length}`,
    ].join('\n');
  });

  trie.register('display sflow', 'Display sFlow configuration', () => {
    const mgmt = (getRouter() as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
    const sf = mgmt?.getSflow();
    if (!sf || !sf.enabled) return 'sFlow: Disabled';
    return [
      `sFlow: Enabled`,
      `Agent IP: ${sf.agentIp || '<not set>'}`,
      `Collectors: ${sf.collectors.length}`,
      `Samplers: ${sf.samplers.length}`,
    ].join('\n');
  });

  trie.register('display lldp neighbor', 'Display LLDP neighbors', () => {
    const agent = (getRouter() as unknown as { getLldpAgent?: () => { getNeighbors: () => readonly { localPort: string; chassisId: string; portId: string; systemName: string; portDescription: string; expiresAtMs: number }[] } }).getLldpAgent?.();
    const neighbors = agent?.getNeighbors() ?? [];
    if (neighbors.length === 0) return 'Info: No LLDP neighbor is found.';
    return neighbors.map(n => [
      `Local Intf: ${n.localPort}`,
      `Chassis id: ${n.chassisId}`,
      `Port id: ${n.portId}`,
      `Port description: ${n.portDescription}`,
      `System name: ${n.systemName}`,
      `Time remaining: ${Math.max(0, Math.floor((n.expiresAtMs - Date.now()) / 1000))} seconds`,
    ].join('\n')).join('\n\n');
  });

  trie.register('display lldp neighbor brief', 'Display LLDP brief', () => {
    const agent = (getRouter() as unknown as { getLldpAgent?: () => { getNeighbors: () => readonly { localPort: string; systemName: string; portId: string; expiresAtMs: number }[] } }).getLldpAgent?.();
    const neighbors = agent?.getNeighbors() ?? [];
    const lines = ['Local Intf    Neighbor Dev    Neighbor Intf    Exptime(s)'];
    for (const n of neighbors) {
      const exp = Math.max(0, Math.floor((n.expiresAtMs - Date.now()) / 1000));
      lines.push(`${n.localPort.padEnd(14)}${n.systemName.padEnd(16)}${n.portId.padEnd(17)}${exp}`);
    }
    return lines.join('\n');
  });

  trie.registerGreedy('display bgp peer', 'Display BGP peers', () => {
    const ex = (getRouter() as unknown as { getHuaweiRoutingExtras?: () => import('../../router/routing/HuaweiRoutingExtras').HuaweiRoutingExtras }).getHuaweiRoutingExtras?.();
    const bgp = ex?.getBgp();
    if (!bgp) return 'Info: BGP is not running.';
    const lines = [
      `BGP local router ID : ${bgp.routerId ?? '0.0.0.0'}`,
      `Local AS number : ${bgp.asn}`,
      `Total number of peers : ${bgp.peers.size}              Peers in established state : 0`,
      '  Peer            V          AS  MsgRcvd  MsgSent  OutQ  Up/Down       State PrefRcv',
    ];
    for (const [, p] of bgp.peers) {
      lines.push(`  ${p.ip.padEnd(15)}  4    ${String(p.asNumber ?? bgp.asn).padEnd(5)}     0        0     0  00:00:00          Idle       0`);
    }
    return lines.join('\n');
  });

  trie.registerGreedy('display bgp routing-table', 'Display BGP routing table', () => {
    const ex = (getRouter() as unknown as { getHuaweiRoutingExtras?: () => import('../../router/routing/HuaweiRoutingExtras').HuaweiRoutingExtras }).getHuaweiRoutingExtras?.();
    const bgp = ex?.getBgp();
    if (!bgp) return 'Info: BGP is not running.';
    const lines = [
      `BGP Local router ID : ${bgp.routerId ?? '0.0.0.0'}`,
      ' Total Number of Routes: ' + bgp.networks.length,
      ' Network            NextHop         MED        LocPrf    PrefVal Path/Ogn',
    ];
    for (const n of bgp.networks) {
      lines.push(` ${(n.ip + '/' + n.mask).padEnd(19)}0.0.0.0         0          100       0       i`);
    }
    return lines.join('\n');
  });

  trie.register('display bgp group', 'Display BGP peer groups', () => {
    const ex = (getRouter() as unknown as { getHuaweiRoutingExtras?: () => import('../../router/routing/HuaweiRoutingExtras').HuaweiRoutingExtras }).getHuaweiRoutingExtras?.();
    const bgp = ex?.getBgp();
    if (!bgp || bgp.groups.size === 0) return 'Info: No BGP peer groups configured.';
    return [...bgp.groups.values()].map(g => `Group ${g.name}: kind=${g.kind ?? 'unspecified'} AS=${bgp.asn}`).join('\n');
  });
  trie.register('display bgp network', 'Display BGP advertised networks', () => {
    const ex = (getRouter() as unknown as { getHuaweiRoutingExtras?: () => import('../../router/routing/HuaweiRoutingExtras').HuaweiRoutingExtras }).getHuaweiRoutingExtras?.();
    const bgp = ex?.getBgp();
    if (!bgp || bgp.networks.length === 0) return 'Info: No BGP advertised networks.';
    return bgp.networks.map(n => `  ${n.ip}/${n.mask}`).join('\n');
  });
  trie.register('display bgp paths', 'Display BGP AS-paths', () => 'Info: No BGP paths.');
  trie.register('display bgp ipv6 peer', 'Display BGP IPv6 peers', () => 'Info: IPv6 BGP not running.');

  trie.register('display isis brief', 'Display IS-IS brief', () => {
    const ex = (getRouter() as unknown as { getHuaweiRoutingExtras?: () => import('../../router/routing/HuaweiRoutingExtras').HuaweiRoutingExtras }).getHuaweiRoutingExtras?.();
    const all = ex?.listIsis() ?? [];
    if (all.length === 0) return 'Info: IS-IS is not enabled.';
    return all.map(p => [
      `ISIS protocol information for system instance: ${p.processId}`,
      `  System Id : ${(p.netAddress ?? '').split('.').slice(3, 6).join('.') || '<unset>'}`,
      `  Level     : ${p.isLevel ?? 'Level-1-2'}`,
      `  Cost-style: ${p.costStyle ?? 'narrow'}`,
    ].join('\n')).join('\n');
  });
  trie.register('display isis interface', 'Display IS-IS interfaces', () => {
    const ex = (getRouter() as unknown as { getHuaweiRoutingExtras?: () => import('../../router/routing/HuaweiRoutingExtras').HuaweiRoutingExtras }).getHuaweiRoutingExtras?.();
    if (!ex?.listIsis().length) return 'Info: IS-IS is not enabled.';
    return 'Interface           Type   IPv4 State Level     Cost                MTU\n(no IS-IS-enabled interfaces)';
  });
  trie.register('display isis lsdb', 'Display IS-IS LSDB', () => {
    const ex = (getRouter() as unknown as { getHuaweiRoutingExtras?: () => import('../../router/routing/HuaweiRoutingExtras').HuaweiRoutingExtras }).getHuaweiRoutingExtras?.();
    if (!ex?.listIsis().length) return 'Info: IS-IS is not enabled.';
    return 'LSPID                 Seq Num     Checksum    Holdtime   Length   ATT/P/OL\n(no LSPs)';
  });
  trie.register('display isis peer', 'Display IS-IS peers', () => {
    const ex = (getRouter() as unknown as { getHuaweiRoutingExtras?: () => import('../../router/routing/HuaweiRoutingExtras').HuaweiRoutingExtras }).getHuaweiRoutingExtras?.();
    if (!ex?.listIsis().length) return 'Info: IS-IS is not enabled.';
    return 'System ID         Interface          Circuit ID         State HoldTime Type     PRI\n(no peers established)';
  });
  trie.register('display isis route', 'Display IS-IS routing table', () => {
    const ex = (getRouter() as unknown as { getHuaweiRoutingExtras?: () => import('../../router/routing/HuaweiRoutingExtras').HuaweiRoutingExtras }).getHuaweiRoutingExtras?.();
    if (!ex?.listIsis().length) return 'Info: IS-IS is not enabled.';
    return 'Route information for ISIS\n  No routes installed';
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

  trie.registerGreedy('display ipv6 interface', 'Display IPv6 interface detail', (args) => {
    if (args.length === 0) return displayIpv6InterfaceBrief(getRouter());
    return displayIpv6Interface(getRouter(), args.join(' '));
  });

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
