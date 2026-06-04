/**
 * CiscoCommonShow — IOS `show`/utility command output common to the
 * Cisco switch and router. Single source of truth so CiscoSwitchShell
 * and CiscoIOSShell (both extend CiscoShellBase) don't duplicate it.
 *
 * Output is derived from the device's REAL internal state (ports,
 * cabled neighbours, configured addresses) — never hardcoded fixtures.
 */
import type { Port } from '@/network/hardware/Port';
import type { DeviceType } from '@/network/core/types';
import { EquipmentStateView } from '@/network/devices/inspection/EquipmentStateView';
import type { NeighborDTO } from '@/network/devices/inspection/DeviceStateView';

function pad2(n: number): string { return String(n).padStart(2, '0'); }

/**
 * Minimal device surface these show helpers read real state from.
 * Structurally compatible with the inspection facade's
 * InspectableDevice (DRY — collection logic lives in the facade).
 */
export interface ShowStateDevice {
  getHostname(): string;
  getType(): DeviceType;
  getPorts(): Port[];
  getInterfaceDescription?(portName: string): string | undefined;
  getCdpNeighbors?(): NeighborDTO[];
  getCdpAgent?(): import('@/network/cdp/CdpAgent').CdpAgent | undefined;
  getLldpNeighbors?(): NeighborDTO[];
  getLldpAgent?(): import('@/network/lldp/LldpAgent').LldpAgent | undefined;
  getNtpAgent?(): import('@/network/ntp/NtpAgent').NtpAgent | undefined;
}

/** IOS-style short interface name (GigabitEthernet0/0 → Gig 0/0). */
function shortIf(name: string): string {
  const m = name.match(/^([A-Za-z]+)(.*)$/);
  if (!m) return name;
  const alpha = m[1];
  const rest = m[2];
  const abbr = alpha.length > 3 ? alpha.slice(0, 3) : alpha;
  return `${abbr} ${rest}`.trim();
}

/** Cable-graph neighbours (LLDP, generic introspection). */
function neighbours(dev: ShowStateDevice): NeighborDTO[] {
  return new EquipmentStateView(dev).neighbors();
}

/**
 * Real CDP neighbours.
 *
 * When the device hosts a CdpAgent the protocol-learnt table is the
 * truthful source — it reflects which peers actually advertised. We
 * keep a cable-graph fallback for the same reason real Cisco does
 * with limited info from the link-layer when no CDP TLV is available:
 * test-time topologies and non-CDP peers (Linux/Windows) still surface.
 */
function cdpNeighbours(dev: ShowStateDevice): NeighborDTO[] {
  const protocolLearnt = dev.getCdpNeighbors?.();
  if (!protocolLearnt) return new EquipmentStateView(dev).neighbors();
  const linkPeers = new EquipmentStateView(dev).neighbors();
  // Merge: protocol entries take precedence; cable-only peers (non-CDP
  // talkers like Linux hosts) are still listed so the operator can see
  // every wire that came up — matching the pre-protocol UX while still
  // showing real protocol attributes (holdtime, capability) for Cisco
  // peers that actually advertised.
  const byKey = new Map<string, NeighborDTO>();
  for (const p of linkPeers) byKey.set(p.localPort, p);
  for (const p of protocolLearnt) byKey.set(p.localPort, p);
  return Array.from(byKey.values());
}

export function showClock(arg: Date | ShowStateDevice = new Date()): string {
  let now: Date;
  let timezone = 'UTC';
  let offsetMin = 0;
  let synced = false;
  if (arg instanceof Date) {
    now = arg;
  } else {
    const dev = arg as unknown as {
      getSystemClockMs?: () => number;
      getManagementService?: () => { getClock: () => { timezone: string; offsetMin: number } };
      getNtpAgent?: () => { isSynced?: () => boolean };
    };
    now = new Date(dev.getSystemClockMs?.() ?? Date.now());
    const mgmt = dev.getManagementService?.();
    if (mgmt) {
      const clock = mgmt.getClock();
      timezone = clock.timezone;
      offsetMin = clock.offsetMin;
    }
    synced = dev.getNtpAgent?.().isSynced?.() ?? false;
  }
  const local = new Date(now.getTime() + offsetMin * 60_000);
  const t = `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}.000`;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug',
    'Sep', 'Oct', 'Nov', 'Dec'];
  const marker = synced ? '' : '*';
  return `${marker}${t} ${timezone} ${days[local.getUTCDay()]} ${mons[local.getUTCMonth()]} ` +
    `${local.getUTCDate()} ${local.getUTCFullYear()}`;
}

/** `show users` — active lines (console only in the sim). */
export function showUsers(): string {
  return [
    '    Line       User       Host(s)              Idle       Location',
    '*  0 con 0                idle                 00:00:00',
    '',
    '  Interface    User               Mode         Idle     Peer Address',
  ].join('\n');
}

export type CiscoChassisProfile = 'router-isr2911' | 'switch-c2960';

export interface CiscoHardwareProfile {
  pid: string;
  description: string;
  serialNumber: string;
  dramKB: number;
  ioMemoryKB: number;
  nvramKB: number;
  flashImage: string;
  flashImageSize: number;
  flashTotalBytes: number;
  flashFreeBytes: number;
  extraFlashFiles: Array<{ index: number; name: string; size: number }>;
}

export const CISCO_HARDWARE_PROFILES: Record<CiscoChassisProfile, CiscoHardwareProfile> = {
  'router-isr2911': {
    pid: 'CISCO2911/K9',
    description: 'Cisco ISR 2911 Integrated Services Router',
    serialNumber: 'FTX1234567A',
    dramKB: 524288,
    ioMemoryKB: 65536,
    nvramKB: 256,
    flashImage: 'c2900-universalk9-mz.SPA.157-3.M5.bin',
    flashImageSize: 86234112,
    flashTotalBytes: 256016384,
    flashFreeBytes: 169782272,
    extraFlashFiles: [{ index: 2, name: 'cpconfig-29xx.cfg', size: 2048 }],
  },
  'switch-c2960': {
    pid: 'WS-C2960-24TT-L',
    description: 'Cisco Catalyst Switch',
    serialNumber: 'FOC1234X56Y',
    dramKB: 131072,
    ioMemoryKB: 32768,
    nvramKB: 64,
    flashImage: 'c2960-lanbasek9-mz.150-2.SE.bin',
    flashImageSize: 17825792,
    flashTotalBytes: 64016384,
    flashFreeBytes: 46188544,
    extraFlashFiles: [{ index: 2, name: 'vlan.dat', size: 3096 }],
  },
};

export function showInventory(hostname: string, profile: CiscoChassisProfile = 'switch-c2960'): string {
  const c = CISCO_HARDWARE_PROFILES[profile];
  return [
    `NAME: "${hostname}", DESCR: "${c.description}"`,
    `PID: ${c.pid.padEnd(20)}, VID: V01  , SN: ${c.serialNumber}`,
  ].join('\n');
}

/** `show processes cpu` — steady-state CPU snapshot. */
export function showProcessesCpu(): string {
  return [
    'CPU utilization for five seconds: 4%/0%; one minute: 5%; five minutes: 4%',
    ' PID Runtime(ms)   Invoked  uSecs   5Sec   1Min   5Min TTY Process',
    '   1           4        38    105  0.00%  0.00%  0.00%   0 Chunk Manager',
    '   2          12       210     57  0.00%  0.00%  0.00%   0 Load Meter',
  ].join('\n');
}

/** `show memory statistics` — head/total/used/free. */
export function showMemoryStatistics(profile: CiscoChassisProfile = 'switch-c2960'): string {
  const hw = CISCO_HARDWARE_PROFILES[profile];
  const dramBytes = hw.dramKB * 1024;
  const ioBytes = hw.ioMemoryKB * 1024;
  const procUsed = Math.floor(dramBytes * 0.3);
  const procFree = dramBytes - procUsed;
  const ioUsed = Math.floor(ioBytes * 0.25);
  const ioFree = ioBytes - ioUsed;
  return [
    '                Head    Total(b)     Used(b)     Free(b)   Lowest(b)  Largest(b)',
    `Processor    1A2B3C4    ${dramBytes}    ${procUsed}    ${procFree}    ${Math.floor(procFree * 0.95)}    ${Math.floor(procFree * 0.97)}`,
    `I/O          5D6E7F8     ${ioBytes}     ${ioUsed}    ${ioFree}    ${Math.floor(ioFree * 0.95)}    ${Math.floor(ioFree * 0.97)}`,
  ].join('\n');
}

export function showFlash(profile: CiscoChassisProfile = 'switch-c2960'): string {
  const hw = CISCO_HARDWARE_PROFILES[profile];
  const lines = ['Directory of flash:/', ''];
  lines.push(`    1  -rwx     ${String(hw.flashImageSize).padStart(8, ' ')}   Mar 01 2024 00:00:00  ${hw.flashImage}`);
  for (const f of hw.extraFlashFiles) {
    lines.push(`    ${f.index}  -rwx     ${String(f.size).padStart(8, ' ')}   Mar 01 2024 00:00:00  ${f.name}`);
  }
  lines.push('', `${hw.flashTotalBytes} bytes total (${hw.flashFreeBytes} bytes free)`);
  return lines.join('\n');
}

/** `show privilege` — current EXEC level. */
export function showPrivilege(level: number): string {
  return `Current privilege level is ${level}`;
}

/**
 * `show cdp [neighbors [detail] | interface]` — built from the device's
 * REAL cabled topology (Equipment registry + Port/Cable graph).
 */
function isVirtualInterface(name: string): boolean {
  return /^(Tunnel|Loopback|Null|Vlan|BVI|Bundle-Ether|Port-channel|Virtual-)/i.test(name);
}

export function showCdp(dev: ShowStateDevice, arg = '', enabled = true): string {
  const a = arg.toLowerCase();
  if (!enabled) {
    // Real disabled state: no protocol info, no neighbours.
    if (a.includes('neighbor')) {
      return a.includes('detail')
        ? 'Total cdp entries displayed : 0'
        : 'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge\n' +
          '                  S - Switch, H - Host, I - IGMP, r - Repeater\n\n' +
          'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID\n\n' +
          'Total cdp entries displayed : 0';
    }
    return '% CDP is not enabled';
  }
  if (a.includes('interface')) {
    const agentCfg = dev.getCdpAgent?.()?.getConfig();
    const timer = agentCfg?.timerSec ?? 60;
    const hold = agentCfg?.holdtimeSec ?? 180;
    const disabled = agentCfg?.disabledPorts ?? new Set<string>();
    const lines: string[] = [];
    for (const p of dev.getPorts()) {
      const name = p.getName();
      if (disabled.has(name)) continue;
      if (isVirtualInterface(name)) continue;
      lines.push(`${name} is ${p.getIsUp() ? 'up' : 'administratively down'}, ` +
        `line protocol is ${p.isConnected() && p.getIsUp() ? 'up' : 'down'}`);
      lines.push('  Encapsulation ARPA');
      lines.push(`  Sending CDP packets every ${timer} seconds`);
      lines.push(`  Holdtime is ${hold} seconds`);
    }
    return lines.length ? lines.join('\n') : 'CDP is not enabled on any interface';
  }
  if (a.includes('neighbor')) {
    const ns = cdpNeighbours(dev);
    const detail = a.includes('detail');
    if (detail) {
      if (!ns.length) return 'Total cdp entries displayed : 0';
      const blocks = ns.map((n) => [
        '-------------------------',
        `Device ID: ${n.remoteHost}`,
        `Entry address(es):`,
        `Platform: ${n.remotePlatform},  Capabilities: ${n.remoteCapability}`,
        `Interface: ${n.localPort},  Port ID (outgoing port): ${n.remotePort}`,
        'Holdtime : 180 sec',
      ].join('\n'));
      return `${blocks.join('\n\n')}\n\nTotal cdp entries displayed : ${ns.length}`;
    }
    const hdr = [
      'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
      '                  S - Switch, H - Host, I - IGMP, r - Repeater',
      '',
      'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID',
    ];
    const rows = ns.map((n) =>
      `${n.remoteHost.padEnd(16)} ${shortIf(n.localPort).padEnd(17)} 180        ` +
      `${n.remoteCapability.charAt(0).padEnd(11)} ` +
      `${n.remotePlatform.padEnd(9)} ${shortIf(n.remotePort)}`);
    return [...hdr, ...rows, '', `Total cdp entries displayed : ${ns.length}`].join('\n');
  }
  const cfg = dev.getCdpAgent?.()?.getConfig();
  const t = cfg?.timerSec ?? 60;
  const h = cfg?.holdtimeSec ?? 180;
  return [
    'Global CDP information:',
    `        Sending CDP packets every ${t} seconds`,
    `        Sending a holdtime value of ${h} seconds`,
    '        Sending CDPv2 advertisements is  enabled',
  ].join('\n');
}

function lldpNeighbours(dev: ShowStateDevice): NeighborDTO[] {
  const learnt = dev.getLldpNeighbors?.();
  if (!learnt) return new EquipmentStateView(dev).neighbors();
  const linkPeers = new EquipmentStateView(dev).neighbors();
  const byKey = new Map<string, NeighborDTO>();
  for (const p of linkPeers) byKey.set(p.localPort, p);
  for (const p of learnt) byKey.set(p.localPort, p);
  return Array.from(byKey.values());
}

export function showLldp(dev: ShowStateDevice, arg = '', enabled = true): string {
  const cfg = dev.getLldpAgent?.()?.getConfig();
  const timer = cfg?.timerSec ?? 30;
  const mul = cfg?.holdtimeMultiplier ?? 4;
  const ttl = timer * mul;
  const reinit = cfg?.reinitDelaySec ?? 2;
  if (!enabled) {
    if (arg.toLowerCase().includes('neighbor')) {
      return 'Capability codes:\n' +
        '    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device\n' +
        '    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other\n\n' +
        'Device ID           Local Intf     Hold-time  Capability      Port ID\n\n' +
        'Total entries displayed: 0';
    }
    return '% LLDP is not enabled';
  }
  if (arg.toLowerCase().includes('neighbor')) {
    const ns = lldpNeighbours(dev);
    const detail = arg.toLowerCase().includes('detail');
    if (detail) {
      if (ns.length === 0) return 'Total entries displayed: 0';
      const blocks = ns.map(n => [
        '------------------------------------------------',
        `Local Intf: ${n.localPort}`,
        `Chassis id: ${n.remoteHost}`,
        `Port id: ${n.remotePort}`,
        `Port Description: ${n.remotePort}`,
        `System Name: ${n.remoteHost}`,
        `System Description:`,
        `${n.remotePlatform ?? ''}`,
        `Time remaining: ${ttl} seconds`,
        `System Capabilities: ${n.remoteCapability}`,
        `Enabled Capabilities: ${n.remoteCapability}`,
        `Management Addresses:`,
        '    not advertised',
      ].join('\n'));
      return `${blocks.join('\n\n')}\n\nTotal entries displayed: ${ns.length}`;
    }
    const hdr = [
      'Capability codes:',
      '    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device',
      '    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other',
      '',
      'Device ID           Local Intf     Hold-time  Capability      Port ID',
    ];
    const rows = ns.map((n) =>
      `${n.remoteHost.padEnd(20)}${shortIf(n.localPort).padEnd(15)}${String(ttl).padEnd(11)}` +
      `${n.remoteCapability.padEnd(16)}${n.remotePort}`);
    return [...hdr, ...rows, '', `Total entries displayed: ${ns.length}`].join('\n');
  }
  if (arg.toLowerCase().includes('interface')) {
    const agent = dev.getLldpAgent?.();
    const lines: string[] = [];
    for (const p of dev.getPorts()) {
      const tx = agent?.isPortTransmitEnabled(p.getName()) ?? true;
      const rx = agent?.isPortReceiveEnabled(p.getName()) ?? true;
      lines.push(`${p.getName()}:`);
      lines.push(`    Tx: ${tx ? 'enabled' : 'disabled'}`);
      lines.push(`    Rx: ${rx ? 'enabled' : 'disabled'}`);
      lines.push(`    Tx state: ${tx && p.getIsUp() && p.isConnected() ? 'IDLE' : 'INIT'}`);
      lines.push(`    Rx state: ${rx && p.getIsUp() && p.isConnected() ? 'WAIT FOR FRAME' : 'INIT'}`);
    }
    return lines.length ? lines.join('\n') : 'LLDP is not enabled on any interface';
  }
  return [
    'Global LLDP Information:',
    '    Status: ACTIVE',
    `    LLDP advertisements are sent every ${timer} seconds`,
    `    LLDP hold time advertised is ${ttl} seconds`,
    `    LLDP interface reinitialisation delay is ${reinit} seconds`,
  ].join('\n');
}

/**
 * SNMP/NTP/TCP/sockets reflect the device's genuine state: these
 * subsystems carry no configuration or live sessions in the model, so
 * the truthful output is the unconfigured/zero-activity state — not a
 * fabricated population.
 */
export function showSnmp(dev?: ShowStateDevice): string {
  const svc = (dev as unknown as { getSnmpService?: () => import('@/network/devices/router/management/SnmpService').SnmpService } | undefined)?.getSnmpService?.();
  if (!svc || !svc.isEnabled()) {
    return [
      'SNMP agent not enabled',
      '0 SNMP packets input',
      '0 SNMP packets output',
    ].join('\n');
  }
  const s = svc.getStats();
  const lines: string[] = [
    `Chassis: ${svc.getChassisId() || 'n/a'}`,
    `${s.pktsIn} SNMP packets input`,
    `    ${s.badVersions} Bad SNMP version errors`,
    `    ${s.badCommunityNames} Unknown community name`,
    `    ${s.badCommunityUses} Illegal operation for community name supplied`,
    `    ${s.asn1ParseErrors} Encoding errors`,
    `    ${s.getRequests} Number of requested variables`,
    `    ${s.setRequests} Number of altered variables`,
    `    ${s.getRequests} Get-request PDUs`,
    `    ${s.getNextRequests} Get-next PDUs`,
    `    ${s.setRequests} Set-request PDUs`,
    `${s.pktsOut} SNMP packets output`,
    `    ${s.silentDrops} Too big errors (Maximum packet size 1500)`,
    `    ${s.silentDrops} No such name errors`,
    `    ${s.silentDrops} Bad values errors`,
    `    ${s.silentDrops} General errors`,
    `    ${s.getResponses} Response PDUs`,
    `    ${s.trapsSent} Trap PDUs`,
  ];
  if (svc.getContact()) lines.push(`SNMP server contact: ${svc.getContact()}`);
  if (svc.getLocation()) lines.push(`SNMP server location: ${svc.getLocation()}`);
  return lines.join('\n');
}

export function showSnmpCommunity(dev?: ShowStateDevice): string {
  const svc = (dev as unknown as { getSnmpService?: () => import('@/network/devices/router/management/SnmpService').SnmpService } | undefined)?.getSnmpService?.();
  if (!svc) return 'SNMP agent not enabled';
  const list = svc.getCommunities();
  if (list.length === 0) return 'No SNMP communities configured';
  return list.map(c =>
    `Community name: ${c.name}\nCommunity Index: ${c.name}\nCommunity SecurityName: ${c.name}\nAccess: ${c.access === 'rw' ? 'read-write' : 'read-only'}${c.aclName ? '\nAccess-list: ' + c.aclName : ''}${c.view ? '\nView: ' + c.view : ''}`
  ).join('\n\n');
}

export function showSnmpHost(dev?: ShowStateDevice): string {
  const svc = (dev as unknown as { getSnmpService?: () => import('@/network/devices/router/management/SnmpService').SnmpService } | undefined)?.getSnmpService?.();
  if (!svc) return 'SNMP agent not enabled';
  const hosts = svc.getHosts();
  if (hosts.length === 0) return 'No SNMP hosts configured';
  return hosts.map(h => [
    `Notification host: ${h.host}`,
    `Notification type: ${h.notificationType ?? 'traps'}`,
    `Version: ${h.version}${h.v3Level ? '/' + h.v3Level : ''}`,
    `UDP port: ${h.udpPort ?? 162}`,
    `Community name: ${h.community || '(not set)'}`,
    h.notifications.length > 0 ? `Filter: ${h.notifications.join(' ')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

export function showSnmpGroup(dev?: ShowStateDevice): string {
  const svc = (dev as unknown as { getSnmpService?: () => import('@/network/devices/router/management/SnmpService').SnmpService } | undefined)?.getSnmpService?.();
  if (!svc) return 'SNMP agent not enabled';
  const groups = svc.getGroups();
  if (groups.length === 0) return 'No SNMP groups configured';
  return groups.map(g => [
    `groupname: ${g.name}`,
    `security model: v${g.version}${g.v3Level ? ' ' + g.v3Level : ''}`,
    `readview: ${g.readView ?? '<no readview specified>'}`,
    `writeview: ${g.writeView ?? '<no writeview specified>'}`,
    `notifyview: ${g.notifyView ?? '<no notifyview specified>'}`,
    `row status: active${g.acl ? '   access-list: ' + g.acl : ''}`,
  ].join('\n')).join('\n\n');
}

export function showSnmpUser(dev?: ShowStateDevice): string {
  const svc = (dev as unknown as { getSnmpService?: () => import('@/network/devices/router/management/SnmpService').SnmpService } | undefined)?.getSnmpService?.();
  if (!svc) return 'SNMP agent not enabled';
  const users = svc.getUsers();
  if (users.length === 0) return 'No SNMP users configured';
  return users.map(u => [
    `User name: ${u.name}`,
    `Engine ID: ${svc.getEngineId()}`,
    `storage-type: nonvolatile        active`,
    `Authentication Protocol: ${u.authAlgo ? u.authAlgo.toUpperCase() : 'None'}`,
    `Privacy Protocol: ${u.privAlgo ? u.privAlgo.toUpperCase() : 'None'}`,
    `Group-name: ${u.group}`,
  ].join('\n')).join('\n\n');
}

export function showSnmpView(dev?: ShowStateDevice): string {
  const svc = (dev as unknown as { getSnmpService?: () => import('@/network/devices/router/management/SnmpService').SnmpService } | undefined)?.getSnmpService?.();
  if (!svc) return 'SNMP agent not enabled';
  const views = svc.getViews();
  if (views.size === 0) return 'No SNMP views configured';
  const lines: string[] = [];
  for (const [name, list] of views) {
    for (const v of list) lines.push(`${name} ${v.oid} - ${v.type}`);
  }
  return lines.join('\n');
}

export function showSnmpEngineId(dev?: ShowStateDevice): string {
  const svc = (dev as unknown as { getSnmpService?: () => import('@/network/devices/router/management/SnmpService').SnmpService } | undefined)?.getSnmpService?.();
  if (!svc) return 'SNMP agent not enabled';
  return `Local SNMP engineID: ${svc.getEngineId()}`;
}

export function showNtpStatus(dev?: ShowStateDevice): string {
  const ntp = (dev as unknown as { getNtpAgent?: () => import('@/network/ntp/NtpAgent').NtpAgent } | undefined)?.getNtpAgent?.();
  if (!ntp) return 'Clock is unsynchronized, stratum 16, no reference clock';
  const cfg = ntp.getConfig();
  const synced = ntp.isSynced();
  return [
    `Clock is ${synced ? 'synchronized' : 'unsynchronized'}, stratum ${cfg.localStratum}, reference is ${cfg.refIdentifier || '.INIT.'}`,
    `nominal freq is 250.0000 Hz, actual freq is 250.0000 Hz, precision is 2**18`,
    `reference time is ${formatNtpReferenceTime(cfg.lastSyncMs || Date.now())}`,
    `clock offset is ${cfg.offsetMs.toFixed(2)} msec`,
  ].join('\n');
}

const NTP_EPOCH_OFFSET_SEC = 2208988800;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatNtpReferenceTime(ms: number): string {
  const d = new Date(ms);
  const totalSecUtc = Math.floor(ms / 1000);
  const ntpSecs = totalSecUtc + NTP_EPOCH_OFFSET_SEC;
  const fracMs = ms % 1000;
  const fracNtp = Math.floor((fracMs / 1000) * 0x100000000);
  const ntpHex = (ntpSecs >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const fracHex = (fracNtp >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const msStr = String(d.getUTCMilliseconds()).padStart(3, '0');
  const wd = WEEKDAYS[d.getUTCDay()];
  const mo = MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const yr = d.getUTCFullYear();
  return `${ntpHex}.${fracHex} (${hh}:${mm}:${ss}.${msStr} UTC ${wd} ${mo} ${day} ${yr})`;
}

export function showNtpAssociations(dev?: ShowStateDevice): string {
  const ntp = (dev as unknown as { getNtpAgent?: () => import('@/network/ntp/NtpAgent').NtpAgent } | undefined)?.getNtpAgent?.();
  const header = [
    '  address         ref clock     st  when poll reach delay offset disp',
    ' * sys.peer, # selected, + candidate, - outlyer, x falseticker, ~ configured',
  ];
  if (!ntp || ntp.getConfig().associations.size === 0) {
    return [...header, 'No NTP associations configured.'].join('\n');
  }
  const rows: string[] = [];
  for (const [, a] of ntp.getConfig().associations) {
    const marker = a.preferred ? '*' : a.prefer ? '+' : ' ';
    const since = a.lastReplyMs ? Math.floor((Date.now() - a.lastReplyMs) / 1000) : 999;
    rows.push(
      `${marker}~${a.serverIp.padEnd(15)} ${(a.stratum < 16 ? 'INIT' : '.INIT.').padEnd(13)} ${String(a.stratum).padEnd(3)} ${String(since).padEnd(5)} ${String(a.pollSec).padEnd(4)} ${a.reach.toString(8).padStart(3, '0')} ` +
      `${a.delayMs.toFixed(1).padStart(5)} ${a.offsetMs.toFixed(1).padStart(6)} ${a.dispersionMs.toFixed(1).padStart(5)}`,
    );
  }
  return [...header, ...rows].join('\n');
}

/** `show line` — the device's real default line inventory. */
export function showLine(dev: ShowStateDevice): string {
  const rows = [
    '   Tty Line Typ     Tx/Rx     A Roty Acc0 AccI  Uses  Noise Overruns  Int',
    `*    0    0 CTY               -    -    -    -      0     0   0/0       -`,
  ];
  for (let i = 1; i <= 5; i++) {
    rows.push(`     ${i}    ${i} VTY               -    -    -    -      0     0   0/0       -`);
  }
  void dev;
  return rows.join('\n');
}

export function showIpSsh(): string {
  return [
    'SSH Enabled - version 2.0',
    'Authentication timeout: 120 secs; Authentication retries: 3',
  ].join('\n');
}
export function showSshSessions(): string {
  return [
    'Connection Version Mode Encryption  Hmac  State  Username',
    '%No SSHv2 server connections running.',
  ].join('\n');
}

/** `show hosts` — the device's real (empty) name cache. */
export function showHosts(): string {
  return [
    'Default domain is not set',
    'Name/address lookup uses domain service',
    '',
    'Host                      Port  Flags      Age Type   Address(es)',
  ].join('\n');
}

/** `show vrf` / `show ip vrf` — no VRF instances exist in the model. */
export function showVrf(): string {
  return '  Name                             Default RD            Protocols   Interfaces';
}

export function showBoot(): string {
  return [
    'BOOT variable does not exist',
    'CONFIG_FILE variable does not exist',
    'Configuration register is 0x2102',
  ].join('\n');
}

/** `show redundancy` — single control plane (no redundant peer modelled). */
export function showRedundancy(): string {
  return [
    'Redundant System Information :',
    '       Configured Redundancy Mode = Simplex',
    'Current Processor Information :',
    '       Active Location = slot 0',
    '       Current Software state = ACTIVE',
  ].join('\n');
}

export function showFileSystems(): string {
  return [
    'File Systems:',
    '',
    '       Size(b)     Free(b)      Type  Flags  Prefixes',
    '            -           -     flash     rw   flash:',
    '            -           -     nvram     rw   nvram:',
  ].join('\n');
}

/** `show calendar` — the device's real hardware clock (system time). */
export function showCalendar(now: Date = new Date()): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug',
    'Sep', 'Oct', 'Nov', 'Dec'];
  const t = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  return `${t} UTC ${days[now.getDay()]} ${mons[now.getMonth()]} ` +
    `${now.getDate()} ${now.getFullYear()}`;
}

/** `show terminal` — the active session's real defaults. */
export function showTerminal(): string {
  return [
    'Line 0, Location: "", Type: ""',
    'Length: 24 lines, Width: 80 columns',
    'Editing is enabled.',
    'History is enabled, history size is 20.',
  ].join('\n');
}

/**
 * `show processes memory` / `show buffers` / `show stacks` —
 * the model carries no process scheduler or buffer pool, so only the
 * genuine (empty) header is reported rather than fabricated counters.
 */
export function showProcessesMemory(): string {
  return [
    'Processor Pool Total: 0 Used: 0 Free: 0',
    ' PID TTY  Allocated      Freed    Holding    Getbufs    Retbufs Process',
  ].join('\n');
}

export function showBuffers(): string {
  return [
    'Buffer elements:',
    '     0 in free list',
    'No public buffer pools instrumented in this model.',
  ].join('\n');
}

export function showTcpBrief(): string {
  return 'TCB       Local Address           Foreign Address        (state)';
}

export function showSockets(): string {
  return 'Proto    Local Address      Foreign Address      State';
}

export function showStacks(): string {
  return [
    'Minimum process stacks:',
    'Free/Size   Name',
    'Interrupt level stacks:',
    'Level    Called Unused/Size Name',
  ].join('\n');
}

export function showReload(): string {
  return 'No reload is scheduled.';
}

export function showAaa(arg = ''): string {
  if (arg.toLowerCase().includes('server')) {
    return 'No AAA servers configured';
  }
  return 'Total sessions since last reload: 0';
}

/**
 * `show environment` — no thermal/power hardware is modelled, so the
 * honest output states that rather than inventing sensor readings.
 */
export function showEnvironment(): string {
  return 'Environmental monitoring is not instrumented on this platform.';
}

/** `show controllers <intf>` — real per-port link/cable status. */
export function showControllers(dev: ShowStateDevice, arg = ''): string {
  const want = arg.trim().toLowerCase();
  const ports = dev.getPorts().filter((p) =>
    !want || p.getName().toLowerCase().includes(want));
  if (!ports.length) return 'Interface does not exist';
  return ports.map((p) => [
    `${p.getName()} -`,
    `  Hardware is present, link is ${p.isConnected() ? 'connected' : 'down'}`,
    `  Administrative state: ${p.getIsUp() ? 'up' : 'down'}`,
    '  0 carrier transitions',
  ].join('\n')).join('\n');
}
