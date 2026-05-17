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
