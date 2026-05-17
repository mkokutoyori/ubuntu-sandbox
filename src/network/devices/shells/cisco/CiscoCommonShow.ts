/**
 * CiscoCommonShow — IOS `show`/utility command output common to the
 * Cisco switch and router. Single source of truth so CiscoSwitchShell
 * and CiscoIOSShell (both extend CiscoShellBase) don't duplicate it.
 */

function pad2(n: number): string { return String(n).padStart(2, '0'); }

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

/** `show cdp [neighbors [detail] | interface]` — CDP global/neighbours. */
export function showCdp(arg = ''): string {
  const a = arg.toLowerCase();
  if (a.includes('neighbor')) {
    const hdr =
      'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge\n' +
      '                  S - Switch, H - Host, I - IGMP, r - Repeater\n\n' +
      'Device ID    Local Intrfce   Holdtme   Capability  Platform  Port ID';
    return arg.toLowerCase().includes('detail')
      ? `${hdr}\n\nTotal cdp entries displayed : 0`
      : `${hdr}\n\nTotal cdp entries displayed : 0`;
  }
  if (a.includes('interface')) {
    return 'CDP is not enabled on any interface';
  }
  return [
    'Global CDP information:',
    '        Sending CDP packets every 60 seconds',
    '        Sending a holdtime value of 180 seconds',
    '        Sending CDPv2 advertisements is  enabled',
  ].join('\n');
}

/** `show lldp [neighbors [detail]]` — LLDP global/neighbours. */
export function showLldp(arg = ''): string {
  if (arg.toLowerCase().includes('neighbor')) {
    return [
      'Capability codes:',
      '    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device',
      '    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other',
      '',
      'Device ID           Local Intf     Hold-time  Capability      Port ID',
      '',
      'Total entries displayed: 0',
    ].join('\n');
  }
  return [
    'Global LLDP Information:',
    '    Status: ACTIVE',
    '    LLDP advertisements are sent every 30 seconds',
    '    LLDP hold time advertised is 120 seconds',
    '    LLDP interface reinitialisation delay is 2 seconds',
  ].join('\n');
}

/** `show snmp` — agent counters (sim is steady-state zero). */
export function showSnmp(): string {
  return [
    'Chassis: 0',
    '0 SNMP packets input',
    '    0 Bad SNMP version errors',
    '    0 Unknown community name',
    '    0 Encoding errors',
    '0 SNMP packets output',
    '    0 Too big errors',
    '    0 No such name errors',
    'SNMP logging: disabled',
  ].join('\n');
}

/** `show ntp status` — unsynchronised steady state. */
export function showNtpStatus(): string {
  return [
    'Clock is unsynchronized, stratum 16, no reference clock',
    'nominal freq is 250.0000 Hz, actual freq is 250.0000 Hz, precision is 2**18',
    'reference time is 00000000.00000000 (00:00:00.000 UTC Mon Jan 1 1900)',
    'clock offset is 0.0000 msec, root delay is 0.00 msec',
  ].join('\n');
}

/** `show ntp associations` — no peers in the sim. */
export function showNtpAssociations(): string {
  return [
    '  address         ref clock       st   when   poll reach  delay  offset   disp',
    ' * sys.peer, # selected, + candidate, - outlyer, x falseticker, ~ configured',
  ].join('\n');
}

/** `show line` — TTY summary (console + 5 vty). */
export function showLine(): string {
  const rows = [
    '   Tty Typ     Tx/Rx    A Modem  Roty AccO AccI   Uses   Noise  Overruns   Int',
    '*    0 CTY              -    -      -    -    -      1       0     0/0       -',
  ];
  for (let i = 1; i <= 5; i++) {
    rows.push(`     ${i} VTY              -    -      -    -    -      0       0     0/0       -`);
  }
  return rows.join('\n');
}

/** `show ip ssh` / `show ssh` — SSH server status, no active sessions. */
export function showIpSsh(): string {
  return [
    'SSH Enabled - version 2.0',
    'Authentication timeout: 120 secs; Authentication retries: 3',
    'Minimum expected Diffie Hellman key size : 1024 bits',
  ].join('\n');
}
export function showSshSessions(): string {
  return [
    'Connection Version Mode Encryption  Hmac        State            Username',
    '%No SSHv2 server connections running.',
  ].join('\n');
}

/** `show hosts` — static/dynamic name cache (empty). */
export function showHosts(): string {
  return [
    'Default domain is not set',
    'Name/address lookup uses domain service',
    'Name servers are 255.255.255.255',
    '',
    'Codes: UN - unknown, EX - expired, OK - OK, ?? - revalidate',
    '',
    'Host                      Port  Flags      Age Type   Address(es)',
  ].join('\n');
}

/** `show vrf` / `show ip vrf` — no VRFs configured. */
export function showVrf(): string {
  return '  Name                             Default RD            Protocols   Interfaces';
}

/** `show boot` — boot variables. */
export function showBoot(): string {
  return [
    'BOOT variable = flash:',
    'CONFIG_FILE variable does not exist',
    'BOOTLDR variable does not exist',
    'Configuration register is 0x2102',
  ].join('\n');
}

/** `show redundancy` — single-RP steady state. */
export function showRedundancy(): string {
  return [
    'Redundant System Information :',
    '       Available system uptime = 0 minutes',
    'Current Processor Information :',
    '       Active Location = slot 0',
    '       Current Software state = ACTIVE',
  ].join('\n');
}

/** `show file systems` — flash/nvram listing. */
export function showFileSystems(): string {
  return [
    'File Systems:',
    '',
    '       Size(b)     Free(b)      Type  Flags  Prefixes',
    '*    64016384    46188544     flash     rw   flash:',
    '       522232      522232     nvram     rw   nvram:',
    '            -           -    opaque     rw   system:',
  ].join('\n');
}

/** `show calendar` — hardware calendar (mirrors clock). */
export function showCalendar(now: Date = new Date()): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug',
    'Sep', 'Oct', 'Nov', 'Dec'];
  const t = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  return `${t} UTC ${days[now.getDay()]} ${mons[now.getMonth()]} ` +
    `${now.getDate()} ${now.getFullYear()}`;
}

/** `show terminal` — terminal/line parameters. */
export function showTerminal(): string {
  return [
    'Line 0, Location: "", Type: ""',
    'Length: 24 lines, Width: 80 columns',
    'Baud rate (TX/RX) is 9600/9600',
    'Status: PSI Enabled, Ready, Active',
    'Editing is enabled.',
    'History is enabled, history size is 20.',
  ].join('\n');
}

/** `show processes memory` — per-process memory snapshot. */
export function showProcessesMemory(): string {
  return [
    'Processor Pool Total:  134217728 Used:   41943040 Free:   92274688',
    ' PID TTY  Allocated      Freed    Holding    Getbufs    Retbufs Process',
    '   0   0      40000       1000     200000          0          0 *Init*',
    '   1   0       1200        300       4096          0          0 Chunk Manager',
  ].join('\n');
}

/** `show buffers` — buffer pool summary. */
export function showBuffers(): string {
  return [
    'Buffer elements:',
    '     1119 in free list (1119 max allowed)',
    'Public buffer pools:',
    'Small buffers, 104 bytes (total 50, permanent 50, peak 50):',
    '     50 in free list (20 min, 150 max allowed)',
  ].join('\n');
}

/** `show tcp brief` — TCP connection table (empty). */
export function showTcpBrief(): string {
  return 'TCB       Local Address           Foreign Address        (state)';
}

/** `show sockets` — open sockets (none). */
export function showSockets(): string {
  return 'Proto    Local Address      Foreign Address      State';
}

/** `show stacks` — process stack utilisation. */
export function showStacks(): string {
  return [
    'Minimum process stacks:',
    'Free/Size   Name',
    ' 5600/6000  Init',
    'Interrupt level stacks:',
    'Level    Called Unused/Size Name',
  ].join('\n');
}

/** `show reload` — no reload scheduled. */
export function showReload(): string {
  return 'No reload is scheduled.';
}

/** `show aaa sessions` / `show aaa servers` — AAA state. */
export function showAaa(arg = ''): string {
  if (arg.toLowerCase().includes('server')) {
    return 'No AAA servers configured';
  }
  return [
    'Total sessions since last reload: 0',
    'Session Id: 0   Unique Id: 0   User Name: N/A   IP Address: 0.0.0.0',
  ].join('\n');
}

/** `show environment` — power/temperature/fan steady-state. */
export function showEnvironment(): string {
  return [
    'SYSTEM TEMPERATURE is OK',
    'Temperature value: 35C, state: GREEN',
    'Power supply: OK',
    'Fan: OK',
  ].join('\n');
}

/** `show controllers <intf>` — generic controller status. */
export function showControllers(arg = ''): string {
  const intf = arg.trim() || 'Interface';
  return [
    `${intf} - controller status`,
    '  Hardware is present and operational',
    '  0 carrier transitions',
  ].join('\n');
}
