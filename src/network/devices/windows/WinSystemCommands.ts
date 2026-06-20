/**
 * WinSystemCommands — cmd.exe system utilities extracted from WindowsPC.
 *
 * Each command is a pure function over a narrow WinSystemContext, following
 * the established per-command module pattern (WinPing, WinTracert,
 * WinIpconfig…). The context exposes only the device surfaces these
 * commands actually read or mutate, so they stay testable without a full
 * WindowsPC instance.
 */

import type { Port } from '../../hardware/Port';

/** Minimal process-manager surface needed by `start`. */
export interface WinSystemProcessManager {
  getAllProcesses(): Array<{ pid: number; name: string }>;
  spawnProcess(
    imageName: string,
    ppid: number,
    user: string,
    options: { session: string; sessionId: number },
  ): unknown;
}

export interface WinScheduledTask {
  taskName: string;
  taskPath: string;
  state: string;
  /** Program/command to run (`/TR`). */
  command?: string;
  /** Next scheduled run instant for one-time tasks; cleared once fired. */
  runAt?: Date;
  /** Last time the Task Scheduler actually ran this task. */
  lastRunTime?: Date;
  /** Last run result code (`0x0` on success). */
  lastResult?: string;
}

export interface WinSystemContext {
  readonly hostname: string;
  /** OS identity block (systeminfo header). */
  readonly os: { prettyName: string; version: string };
  /** Boot timestamp, when the host lifecycle reports one. */
  bootedAt(): Date | null;
  readonly hardware: {
    manufacturer: string;
    productName: string;
    cpu: { sockets: number; cpuFamily: number; model: number; stepping: number; vendor: string; clockMhz: number };
    memory: { totalKib: number; availableKib: number; swapTotalKib: number };
    firmware: { vendor: string; version: string; releaseDate: string };
  };
  readonly ports: Map<string, Port>;
  isDHCPConfigured(ifName: string): boolean;
  /** Volume serial source — same serial `dir` prints (single source of truth). */
  getVolumeSerialNumber(letter: string): string;
  readonly doskey: {
    entries(): Array<{ head: string; body: string }>;
    define(definition: string): void;
  };
  readonly env: Map<string, string>;
  readonly processManager: WinSystemProcessManager;
  readonly currentUser: string;
  isServiceRunning(name: string): boolean;
  readonly scheduledTasks: Map<string, WinScheduledTask>;
  /** Current simulated wall-clock instant (drives `schtasks` scheduling). */
  now(): Date;
}

// ─── systeminfo ──────────────────────────────────────────────────────

export function cmdSysteminfo(ctx: WinSystemContext): string {
  const lines: string[] = [];
  lines.push(`Host Name:                 ${ctx.hostname}`);
  lines.push(`OS Name:                   ${ctx.os.prettyName}`);
  lines.push(`OS Version:                ${ctx.os.version}`);
  lines.push(`OS Manufacturer:           Microsoft Corporation`);
  lines.push(`OS Configuration:          Member Workstation`);
  lines.push(`OS Build Type:             Multiprocessor Free`);
  const bootedAt = ctx.bootedAt();
  if (bootedAt) {
    lines.push(`System Boot Time:          ${bootedAt.toLocaleString('en-US')}`);
  }
  lines.push(`System Manufacturer:       ${ctx.hardware.manufacturer}`);
  lines.push(`System Model:              ${ctx.hardware.productName}`);
  lines.push(`System Type:               x64-based PC`);
  lines.push(...systeminfoHardwareLines(ctx));
  lines.push(`Network Card(s):           ${ctx.ports.size} NIC(s) Installed.`);
  let idx = 1;
  for (const [name, port] of ctx.ports) {
    const displayName = name.replace(/^eth/, 'Ethernet ');
    lines.push(`                           [${String(idx).padStart(2, '0')}]: Intel(R) Ethernet Connection`);
    const ip = port.getIPAddress();
    if (ip) {
      lines.push(`                                 Connection Name: ${displayName}`);
      lines.push(`                                 DHCP Enabled:    ${ctx.isDHCPConfigured(name) ? 'Yes' : 'No'}`);
      lines.push(`                                 IP address(es)`);
      lines.push(`                                 [01]: ${ip}`);
    } else {
      lines.push(`                                 Connection Name: ${displayName}`);
      lines.push(`                                 Status:          Media disconnected`);
    }
    idx++;
  }
  return lines.join('\n');
}

/**
 * The processor / BIOS / memory block of `systeminfo`, rendered from the
 * host's hardware inventory so it stays coherent with the device model.
 */
function systeminfoHardwareLines(ctx: WinSystemContext): string[] {
  const { cpu, memory, firmware } = ctx.hardware;
  const mb = (kib: number): string =>
    `${Math.round(kib / 1024).toLocaleString('en-US')} MB`;
  return [
    `Processor(s):              ${cpu.sockets} Processor(s) Installed.`,
    `                           [01]: Intel64 Family ${cpu.cpuFamily} ` +
      `Model ${cpu.model} Stepping ${cpu.stepping} ${cpu.vendor} ` +
      `~${cpu.clockMhz} Mhz`,
    `BIOS Version:              ${firmware.vendor} ${firmware.version}, ` +
      `${firmware.releaseDate}`,
    `Total Physical Memory:     ${mb(memory.totalKib)}`,
    `Available Physical Memory: ${mb(memory.availableKib)}`,
    `Virtual Memory: Max Size:  ${mb(memory.totalKib + memory.swapTotalKib)}`,
  ];
}

// ─── doskey ──────────────────────────────────────────────────────────

/**
 * `doskey NAME=BODY` installs a macro consumed by every subsequent
 * cmd dispatch. Without args, lists current macros (cmd.exe form).
 */
export function cmdDoskey(ctx: WinSystemContext, args: string[]): string {
  if (args.length === 0) {
    return ctx.doskey.entries().map(e => `${e.head}=${e.body}`).join('\n');
  }
  const joined = args.join(' ');
  if (!joined.includes('=')) {
    return ctx.doskey.entries().map(e => `${e.head}=${e.body}`).join('\n');
  }
  ctx.doskey.define(joined);
  return '';
}

// ─── vol / chcp / date / time ────────────────────────────────────────

export function cmdVol(ctx: WinSystemContext, args: string[]): string {
  const arg = (args[0] ?? 'C:').toUpperCase().replace(/[:\\]+$/, '');
  const letter = arg.charAt(0) || 'C';
  const serial = ctx.getVolumeSerialNumber(letter);
  return [
    ` Volume in drive ${letter} has no label.`,
    ` Volume Serial Number is ${serial}`,
  ].join('\n');
}

/** chcp — print/set active code page.  Defaults to 65001 (UTF-8). */
export function cmdChcp(args: string[]): string {
  if (args.length === 0) return 'Active code page: 65001';
  const cp = parseInt(args[0], 10);
  if (isNaN(cp)) return 'Invalid code page';
  return `Active code page: ${cp}`;
}

/** date /t — print today's date in MM/DD/YYYY (en-US). */
export function cmdDate(_args: string[]): string {
  const d = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dow = days[d.getDay()];
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dow} ${mm}/${dd}/${yyyy}`;
}

/** time /t — print current time in h:mm AM/PM (en-US). */
export function cmdTime(_args: string[]): string {
  const d = new Date();
  const h24 = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');
  const tt = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${min} ${tt}`;
}

// ─── start / setx ────────────────────────────────────────────────────

/**
 * `start <command>` — launch a program in a new session. Spawns into the
 * shared process manager so both `tasklist` and `Get-Process` see it.
 * Returns an empty string on success (matches cmd.exe semantics).
 */
export function cmdStart(ctx: WinSystemContext, args: string[]): string {
  // Strip cmd-style flags (/B, /WAIT, /MIN, ...) and the optional "title"
  // argument that precedes the executable.
  const filtered = args.filter(a => !a.startsWith('/'));
  if (filtered.length === 0) return '';
  let target = filtered[0].replace(/^["']|["']$/g, '');
  // `start "title" prog ...` form: drop the title token.
  if (filtered.length >= 2 && /^"[^"]*"$/.test(args.find(a => /^"[^"]*"$/.test(a)) ?? '')) {
    target = filtered[1].replace(/^["']|["']$/g, '');
  }
  if (!target) return '';
  const leaf = target.split(/[\\/]/).pop() ?? target;
  const imageName = /\.exe$/i.test(leaf) ? leaf : `${leaf}.exe`;
  const parent = ctx.processManager.getAllProcesses()
    .find(p => p.name.toLowerCase() === 'explorer.exe');
  const ppid = parent?.pid ?? 1;
  ctx.processManager.spawnProcess(imageName, ppid, ctx.currentUser, {
    session: 'Console', sessionId: 1,
  });
  return '';
}

/** `setx VAR VALUE [/M]` — persists an environment variable. */
export function cmdSetx(ctx: WinSystemContext, args: string[]): string {
  const filtered = args.filter(a => a.toUpperCase() !== '/M');
  if (filtered.length < 2) {
    return 'ERROR: Invalid syntax. Type "SETX /?" for usage.';
  }
  const name = filtered[0];
  const value = filtered.slice(1).join(' ').replace(/^"(.*)"$/, '$1');
  ctx.env.set(name, value);
  return `SUCCESS: Specified value was saved.`;
}

// ─── schtasks ────────────────────────────────────────────────────────

/**
 * `schtasks` — query/create/delete entries in the shared
 * `scheduledTasks` map so PowerShell's `Get-ScheduledTask` and
 * `Register-ScheduledTask` see the same data.
 */
export function cmdSchtasks(ctx: WinSystemContext, args: string[]): string {
  if (!ctx.isServiceRunning('Schedule')) {
    return `ERROR: The Task Scheduler service is not running.`;
  }
  const action = args[0]?.toLowerCase();
  const flagIdx = (name: string) => args.findIndex(a => a.toLowerCase() === name);
  const flagVal = (name: string) => { const i = flagIdx(name); return i >= 0 ? args[i + 1] : undefined; };
  const tn = flagVal('/tn');

  if (action === '/query') {
    const filtered = tn
      ? Array.from(ctx.scheduledTasks.values()).filter(t => t.taskName.toLowerCase() === tn.toLowerCase())
      : Array.from(ctx.scheduledTasks.values());
    const lines = [
      'Folder: \\',
      'TaskName                                 Next Run Time          Status',
      '======================================== ====================== ===============',
    ];
    for (const t of filtered) {
      const next = t.runAt ? fmtSchtasksDate(t.runAt) : 'N/A';
      lines.push(`${t.taskName.padEnd(40)} ${next.padEnd(22)} ${t.state}`);
    }
    return lines.join('\n');
  }
  if (action === '/create') {
    if (!tn) return 'ERROR: The required parameter "/TN" is missing.';
    const sc = flagVal('/sc')?.toUpperCase();
    const st = flagVal('/st');
    const task: WinScheduledTask = {
      taskName: tn, taskPath: '\\', state: 'Ready', command: flagVal('/tr'),
    };
    // Only one-time tasks (`/SC ONCE`, or a bare `/ST` with no schedule) are
    // armed to fire; recurring schedules are stored but not yet driven.
    if (st && (!sc || sc === 'ONCE')) task.runAt = parseSchtasksTime(st, ctx.now());
    ctx.scheduledTasks.set(tn.toLowerCase(), task);
    return `SUCCESS: The scheduled task "${tn}" has successfully been created.`;
  }
  if (action === '/delete') {
    if (!tn) return 'ERROR: The required parameter "/TN" is missing.';
    const removed = ctx.scheduledTasks.delete(tn.toLowerCase());
    return removed
      ? `SUCCESS: The scheduled task "${tn}" was successfully deleted.`
      : `ERROR: The system cannot find the file specified.`;
  }
  if (action === '/run') {
    if (!tn) return 'ERROR: The required parameter "/TN" is missing.';
    const task = ctx.scheduledTasks.get(tn.toLowerCase());
    if (!task) return 'ERROR: The system cannot find the file specified.';
    fireScheduledTask(task, ctx.processManager, ctx.now());
    return `SUCCESS: Attempted to run the scheduled task "${tn}".`;
  }
  if (action === '/end' || action === '/change') {
    return 'SUCCESS: The scheduled task was created/modified successfully.';
  }
  return 'SCHTASKS /parameter [arguments]\n\nDescription:\n    Enables an administrator to create, delete, query, change, run, and\n    end scheduled tasks on a local or remote computer.';
}

/**
 * Run a scheduled task's program now: spawn its image (so `tasklist` and
 * `Get-Process` see it), record the run, and disarm a one-time trigger.
 * Shared by `schtasks /run` and the Task Scheduler's clock-driven firing.
 */
export function fireScheduledTask(
  task: WinScheduledTask,
  pm: WinSystemProcessManager,
  now: Date,
): void {
  task.lastRunTime = now;
  task.lastResult = '0x0';
  task.state = 'Ready';
  task.runAt = undefined;
  if (!task.command) return;
  const target = task.command.replace(/^["']|["']$/g, '');
  const leaf = target.split(/[\\/]/).pop() ?? target;
  const imageName = /\.exe$/i.test(leaf) ? leaf : `${leaf}.exe`;
  const parent = pm.getAllProcesses().find(p => p.name.toLowerCase() === 'svchost.exe');
  pm.spawnProcess(imageName, parent?.pid ?? 1, 'NT AUTHORITY\\SYSTEM', {
    session: 'Services', sessionId: 0,
  });
}

/** Parse a `schtasks /ST` time-of-day (`HH:MM[:SS]`) into the next instant
 *  at or after `base`. Rolls to the following day when already past. */
function parseSchtasksTime(st: string, base: Date): Date {
  const m = st.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return new Date(base);
  const d = new Date(base);
  d.setHours(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 0, 0);
  if (d.getTime() <= base.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/** Format an instant the way `schtasks /query` shows the Next Run Time. */
function fmtSchtasksDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ─── nbtstat / wmic ──────────────────────────────────────────────────

/** `nbtstat -n / -a / -A` — returns a minimal local NetBIOS name table. */
export function cmdNbtstat(ctx: WinSystemContext, args: string[]): string {
  const flag = args[0]?.toLowerCase();
  if (flag === '-n') {
    return [
      '',
      '    Node IpAddress: [0.0.0.0] Scope Id: []',
      '',
      '                       NetBIOS Local Name Table',
      '',
      '       Name               Type         Status',
      '    ---------------------------------------------',
      `    ${ctx.hostname.toUpperCase().padEnd(16)} <00>  UNIQUE      Registered`,
      `    WORKGROUP        <00>  GROUP       Registered`,
      '',
    ].join('\n');
  }
  return 'NBTSTAT [ [-a RemoteName] [-A IP address] [-c] [-n] [-r] [-R] [-RR] [-s] [-S] [interval] ]';
}

/** `wmic logicaldisk get name` / minimal WMI stub. */
export function cmdWmic(args: string[]): string {
  if (args.length === 0) return 'wmic:root\\cli>';
  const joined = args.join(' ').toLowerCase();
  if (joined.includes('logicaldisk') && joined.includes('get name')) {
    return 'Name  \nC:    ';
  }
  if (joined.includes('os get caption')) {
    return 'Caption                              \nMicrosoft Windows 10 Enterprise      ';
  }
  if (joined.includes('cpu get name')) {
    return 'Name                                              \nIntel(R) Core(TM) i7 CPU @ 2.50GHz                ';
  }
  return '';
}
