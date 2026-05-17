/**
 * HuaweiCommonDisplay — VRP `display` commands that are identical on
 * switches and routers.
 *
 * Single source of truth for the rendered text so HuaweiSwitchShell and
 * HuaweiVRPShell don't duplicate it (DRY). Each shell only wires a trie
 * entry to these pure functions.
 */

const WEEKDAYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `display clock` — date, weekday, timezone (VRP layout). */
export function displayClock(now: Date = new Date()): string {
  const date =
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const time =
    `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  return [
    `${date} ${time}`,
    WEEKDAYS[now.getDay()],
    'Time Zone(UTC) : UTC',
  ].join('\n');
}

/** `display cpu-usage` — steady-state utilisation snapshot. */
export function displayCpuUsage(now: Date = new Date()): string {
  const stamp =
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    ` ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  return [
    'CPU Usage Stat. Cycle: 60 (Second)',
    'CPU Usage            : 11% Max: 38%',
    `CPU Usage Stat. Time : ${stamp}`,
    'CPU utilization for five seconds: 11%: one minute: 12%: five minutes: 10%',
    '',
    'Max CPU Usage Stat. Time : 0000-00-00 00:00:00.',
  ].join('\n');
}

/** `display memory-usage` — pool totals + percentage. */
export function displayMemoryUsage(now: Date = new Date()): string {
  const stamp =
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    ` ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  return [
    `Memory utilization statistics at ${stamp}`,
    'System Total Memory Is: 536870912 bytes',
    'Total Memory Used Is: 193273528 bytes',
    'Memory Using Percentage Is: 36%',
  ].join('\n');
}

/** `display users` — active management sessions (console only by default). */
export function displayUsers(): string {
  return [
    '  User-Intf    Delay    Type   Network Address      AuthenStatus    AuthorcmdFlag',
    '+ 0    CON 0   00:00:00                              pass            no',
    '',
    'Wait     : Wait for the user to press ENTER.',
  ].join('\n');
}

/** `display device` — chassis/board inventory (single-board S-series/AR). */
export function displayDevice(hostname: string): string {
  return [
    `${hostname}'s Device status:`,
    '-------------------------------------------------------------------------------',
    'Slot  Sub  Type            Online    Power    Register     Status   Role',
    '-------------------------------------------------------------------------------',
    '1     -    S5720-28X-LI    Present   On       Registered   Normal   Master',
    '-------------------------------------------------------------------------------',
  ].join('\n');
}

/** `display history-command` — recent CLI history for the session. */
export function displayHistoryCommand(history: readonly string[]): string {
  if (history.length === 0) return '';
  return history.slice(-20).join('\n');
}

/** `display alarm` — active alarms (none in the sim). */
export function displayAlarm(): string {
  return 'Info: There is no alarm record.';
}

/** `display elabel` — electronic label / manufacturing info. */
export function displayElabel(hostname: string): string {
  return [
    '/$[ARCHIVES INFO VERSION]',
    '/$ArchivesInfoVersion=3.0;',
    '',
    '[Slot_1]',
    '/$[Board Integrated Component]',
    '/$BoardType=S5720-28X-LI-AC;',
    `/$BarCode=210235${hostname.toUpperCase().slice(0, 8)};`,
    '/$Item=02359556;',
    '/$Description=Huawei S5720-28X-LI-AC Switch;',
    '/$Manufactured=2024-01-01;',
    '/$VendorName=Huawei;',
  ].join('\n');
}

/** `display license` — license state (default trial). */
export function displayLicense(): string {
  return [
    ' Active License : default',
    ' License State  : Trial',
    ' Trial Days Left: 60',
  ].join('\n');
}

/** `display logbuffer` — informational log ring buffer. */
export function displayLogbuffer(now: Date = new Date()): string {
  const stamp =
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` +
    ` ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  return [
    'Logging buffer configuration and contents: enabled',
    'Allowed max buffer size : 512',
    'Actual buffer size : 512',
    'Channel number : 4 , Channel name : logbuffer',
    'Dropped messages : 0',
    'Overwritten messages : 0',
    'Current messages : 1',
    `${stamp} %01SRM/4/PORT_STATE: Port state changed.`,
  ].join('\n');
}

/** `display trapbuffer` — informational trap ring buffer. */
export function displayTrapbuffer(): string {
  return [
    'Trapping buffer configuration and contents: enabled',
    'Allowed max buffer size : 256',
    'Actual buffer size : 256',
    'Channel number : 3 , Channel name : trapbuffer',
    'Dropped messages : 0',
    'Current messages : 0',
  ].join('\n');
}

/** `display patch-information` — installed patches (none). */
export function displayPatchInformation(): string {
  return 'Info: No patch exists.';
}

/** `display diagnostic-information` — collection acknowledgement (stub). */
export function displayDiagnosticInformation(): string {
  return [
    'Info: It will take several minutes to save diagnostic information,',
    'please wait.....................',
    'Info: Diagnostic information collected.',
  ].join('\n');
}
