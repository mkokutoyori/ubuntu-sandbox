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
