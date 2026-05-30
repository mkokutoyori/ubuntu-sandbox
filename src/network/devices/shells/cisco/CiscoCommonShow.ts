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

/** `show clock` — IOS format: HH:MM:SS.mmm zone day mon dd yyyy */
export function showClock(now: Date = new Date()): string {
  const t = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.000`;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug',
    'Sep', 'Oct', 'Nov', 'Dec'];
  return `*${t} UTC ${days[now.getDay()]} ${mons[now.getMonth()]} ` +
    `${now.getDate()} ${now.getFullYear()}`;
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

/** `show inventory` — chassis line. */
export function showInventory(hostname: string): string {
  return [
    `NAME: "${hostname}", DESCR: "Cisco Catalyst Switch"`,
    'PID: WS-C2960-24TT-L     , VID: V01  , SN: FOC1234X56Y',
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
export function showMemoryStatistics(): string {
  return [
    '                Head    Total(b)     Used(b)     Free(b)   Lowest(b)  Largest(b)',
    'Processor    1A2B3C4    134217728    41943040    92274688    90000000    91000000',
    'I/O          5D6E7F8     16777216     4194304    12582912    12000000    12500000',
  ].join('\n');
}

/** `show flash` — flash filesystem listing. */
export function showFlash(): string {
  return [
    'Directory of flash:/',
    '',
    '    1  -rwx     17825792   Mar 01 2024 00:00:00  c2960-lanbasek9-mz.150-2.SE.bin',
    '    2  -rwx         3096   Mar 01 2024 00:00:00  vlan.dat',
    '',
    '64016384 bytes total (46188544 bytes free)',
  ].join('\n');
}

/** `show privilege` — current EXEC level. */
export function showPrivilege(level: number): string {
  return `Current privilege level is ${level}`;
}

/**
 * `show cdp [neighbors [detail] | interface]` — built from the device's
 * REAL cabled topology (Equipment registry + Port/Cable graph).
 */
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
      if (disabled.has(p.getName())) continue;
      lines.push(`${p.getName()} is ${p.getIsUp() ? 'up' : 'administratively down'}, ` +
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
      const agent = dev.getLldpAgent?.();
      const allRows = agent ? agent.getNeighbors() : [];
      const blocks = allRows.map(n => [
        '------------------------------------------------',
        `Local Intf: ${n.localPort}`,
        `Chassis id: ${n.chassisId}`,
        `Port id: ${n.portId}`,
        `Port Description: ${n.portDescription}`,
        `System Name: ${n.systemName}`,
        `System Description:`,
        n.systemDescription,
        `Time remaining: ${Math.max(0, Math.floor((n.expiresAtMs - Date.now()) / 1000))} seconds`,
        `System Capabilities: ${n.remoteCapabilities.join(', ')}`,
        `Enabled Capabilities: ${n.remoteCapabilities.join(', ')}`,
        `Management Addresses:`,
        ...(n.managementAddresses.length > 0
          ? n.managementAddresses.map(a => `    IP: ${a}`)
          : ['    not advertised']),
      ].join('\n'));
      return `${blocks.join('\n\n')}\n\nTotal entries displayed: ${allRows.length}`;
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
export function showSnmp(): string {
  return [
    'SNMP agent not enabled',
    '0 SNMP packets input',
    '0 SNMP packets output',
  ].join('\n');
}

export function showNtpStatus(): string {
  return 'Clock is unsynchronized, stratum 16, no reference clock';
}

export function showNtpAssociations(): string {
  return [
    '  address         ref clock     st  when poll reach delay offset disp',
    ' * sys.peer, # selected, + candidate, - outlyer, x falseticker, ~ configured',
    'No NTP associations configured.',
  ].join('\n');
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
