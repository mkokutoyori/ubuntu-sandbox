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
import { dhcpEnabledFor } from './WinAdapterFacts';
import type { ProcessSession } from './WindowsProcessManager';
import { adapterDisplayName } from './netAdapter';

/** Minimal process-manager surface needed by `start`. */
export interface WinSystemProcessManager {
  getAllProcesses(): Array<{ pid: number; name: string }>;
  spawnProcess(
    imageName: string,
    ppid: number,
    user: string,
    options?: { session?: ProcessSession; sessionId?: number; elevation?: 'full' | 'default' | 'limited' },
  ): unknown;
}

export interface WinScheduledTask {
  taskName: string;
  taskPath: string;
  state: string;
  command?: string;
  runAt?: Date;
  intervalMs?: number;
  lastRunTime?: Date;
  lastResult?: string;
  /**
   * Ce que `schtasks /query /v` imprime en plus des trois colonnes du
   * tableau. Rien ici n'est décoratif : chaque champ est ce que
   * `/create` a reçu, et il n'y en a pas d'autre — un `Author` ou un
   * `Run As User` inventé serait pire qu'absent.
   */
  author?: string;
  runAsUser?: string;
  scheduleType?: string;
  /** Occurrences passées pendant que le planificateur était arrêté. */
  missedRuns?: number;
  startTime?: string;
  startDate?: Date;
  days?: string;
  months?: string;
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
    entries(): readonly { head: string; body: string }[];
    define(definition: string): void;
  };
  readonly env: Map<string, string>;
  readonly processManager: WinSystemProcessManager;
  readonly currentUser: string;
  isServiceRunning(name: string): boolean;
  readonly scheduledTasks: Map<string, WinScheduledTask>;
  /**
   * Ce que le planificateur consigne dans
   * `Microsoft-Windows-TaskScheduler/Operational` — le journal où se lit
   * l'historique d'une tâche sous Windows, et qui n'existait pas ici.
   * Optionnel : `cmdSchtasks` reste utilisable sans journal.
   */
  onTaskRegistered?(task: WinScheduledTask): void;
  onTaskDeleted?(taskName: string): void;
  /** Démarrage manuel — le même que celui de `Start-ScheduledTask`. */
  runTaskNow?(task: WinScheduledTask): void;
  now(): Date;
  /**
   * Real UAC elevation context for a process `start`s right now
   * (PRD-Winlogon.md §2.1 P5) — `'full'` while inside a `runas`-wrapped
   * command, `'limited'` for an Administrators-group member running
   * without having elevated, `undefined` otherwise (the 4688 falls back
   * to its historical name-based heuristic). Optional so a synthetic
   * test context that doesn't care about elevation keeps working
   * unchanged.
   */
  elevationContext?(): 'full' | 'default' | 'limited' | undefined;
}

// ─── systeminfo ──────────────────────────────────────────────────────

export function cmdSysteminfo(ctx: WinSystemContext): string {
  const lines: string[] = [];
  lines.push(`Host Name:                 ${ctx.hostname}`);
  lines.push(`OS Name:                   ${ctx.os.prettyName}`);
  lines.push(`OS Version:                ${ctx.os.version}`);
  lines.push(`OS Manufacturer:           Microsoft Corporation`);
  const memberRole = ctx.os.prettyName.includes('Server') ? 'Member Server' : 'Member Workstation';
  lines.push(`OS Configuration:          ${memberRole}`);
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
    const displayName = adapterDisplayName(name, ctx.ports);
    lines.push(`                           [${String(idx).padStart(2, '0')}]: Intel(R) Ethernet Connection`);
    const ip = port.getIPAddress();
    if (ip) {
      lines.push(`                                 Connection Name: ${displayName}`);
      lines.push(`                                 DHCP Enabled:    ${dhcpEnabledFor(port, ctx.isDHCPConfigured(name)) ? 'Yes' : 'No'}`);
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
    elevation: ctx.elevationContext?.(),
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
    const all = Array.from(ctx.scheduledTasks.values());
    const filtered = tn
      ? all.filter(t => t.taskName.toLowerCase() === tn.toLowerCase())
      : all;
    // Un tableau vide se lisait « aucune tâche à montrer » alors que le
    // nom demandé n'existe pas — le vrai le dit, comme `/delete` le fait
    // déjà ici.
    if (tn && filtered.length === 0) return 'ERROR: The system cannot find the file specified.';
    const format = (flagVal('/fo') ?? 'TABLE').toUpperCase();
    const verbose = flagIdx('/v') >= 0;
    if (format === 'LIST') return renderSchtasksList(ctx, filtered, verbose);
    if (format === 'CSV') return renderSchtasksCsv(ctx, filtered, verbose);
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
    const tr = flagVal('/tr');
    // Une tâche sans action est vide de sens ; le vrai la refuse.
    if (!tr) return 'ERROR: The required parameter "/TR" is missing.';
    // Écraser sans le dire ferait disparaître la tâche d'avant en silence.
    if (ctx.scheduledTasks.has(tn.toLowerCase()) && flagIdx('/f') < 0) {
      return `ERROR: The task "${tn}" already exists. Use /F to overwrite it.`;
    }
    const sc = flagVal('/sc')?.toUpperCase() ?? 'DAILY';
    const st = flagVal('/st');
    const mo = Number(flagVal('/mo')) || 1;
    const d = flagVal('/d')?.toUpperCase();
    const m = flagVal('/m')?.toUpperCase();
    const base = ctx.now();
    const task: WinScheduledTask = {
      taskName: tn, taskPath: '\\', state: 'Ready', command: tr,
      author: `${ctx.hostname}\\${ctx.currentUser}`,
      runAsUser: flagVal('/ru') ?? ctx.currentUser,
      scheduleType: SCHEDULE_LABELS[sc] ?? sc,
      startTime: st,
      startDate: base,
      days: d ?? (sc === 'DAILY' ? `Every ${mo} day(s)` : undefined),
      months: m,
    };
    const recurUnit = sc === 'MINUTE' ? 60_000 : sc === 'HOURLY' ? 3_600_000 : sc === 'DAILY' ? 86_400_000 : 0;
    if (recurUnit > 0) {
      task.intervalMs = mo * recurUnit;
      task.runAt = st ? parseSchtasksTime(st, base) : new Date(base.getTime() + task.intervalMs);
    } else if (sc === 'WEEKLY') {
      // Une hebdomadaire tombe un jour nommé ; sans `/d`, le vrai retient
      // le jour de la création.
      task.intervalMs = 7 * 86_400_000 * mo;
      task.runAt = nextWeekday(d, st, base);
      task.days = d ?? WEEKDAY_ABBR[base.getDay()];
    } else if (sc === 'MONTHLY') {
      task.runAt = nextMonthly(Number(flagVal('/d')) || base.getDate(), st, base);
      task.days = flagVal('/d') ?? String(base.getDate());
    } else if (st && sc === 'ONCE') {
      task.runAt = parseSchtasksTime(st, base);
    }
    // ONSTART, ONLOGON, ONIDLE et ONEVENT n'ont pas d'heure : leur
    // déclencheur est un événement que rien ici ne produit. `N/A` est
    // alors la vérité, pas une lacune d'affichage.
    ctx.scheduledTasks.set(tn.toLowerCase(), task);
    ctx.onTaskRegistered?.(task);
    return `SUCCESS: The scheduled task "${tn}" has successfully been created.`;
  }
  if (action === '/delete') {
    if (!tn) return 'ERROR: The required parameter "/TN" is missing.';
    const removed = ctx.scheduledTasks.delete(tn.toLowerCase());
    if (removed) ctx.onTaskDeleted?.(tn);
    return removed
      ? `SUCCESS: The scheduled task "${tn}" was successfully deleted.`
      : `ERROR: The system cannot find the file specified.`;
  }
  if (action === '/run') {
    if (!tn) return 'ERROR: The required parameter "/TN" is missing.';
    const task = ctx.scheduledTasks.get(tn.toLowerCase());
    if (!task) return 'ERROR: The system cannot find the file specified.';
    // Par le même chemin que `Start-ScheduledTask`, pour que les deux
    // laissent la même trace dans le journal.
    if (ctx.runTaskNow) ctx.runTaskNow(task);
    else runScheduledProgram(task, ctx.processManager, ctx.now());
    return `SUCCESS: Attempted to run the scheduled task "${tn}".`;
  }
  if (action === '/change') {
    if (!tn) return 'ERROR: The required parameter "/TN" is missing.';
    const task = ctx.scheduledTasks.get(tn.toLowerCase());
    if (!task) return 'ERROR: The system cannot find the file specified.';
    const has = (name: string) => flagIdx(name) >= 0;
    // L'état demandé était jusqu'ici accepté puis perdu : la commande
    // répondait SUCCESS et `/query` affichait toujours Ready.
    if (has('/disable')) task.state = 'Disabled';
    if (has('/enable')) task.state = 'Ready';
    const tr = flagVal('/tr');
    if (tr !== undefined) task.command = tr;
    const st = flagVal('/st');
    if (st !== undefined) task.runAt = parseSchtasksTime(st, ctx.now());
    return `SUCCESS: The parameters of scheduled task "${tn}" have been changed.`;
  }
  if (action === '/end') {
    if (!tn) return 'ERROR: The required parameter "/TN" is missing.';
    const task = ctx.scheduledTasks.get(tn.toLowerCase());
    if (!task) return 'ERROR: The system cannot find the file specified.';
    return `SUCCESS: The scheduled task "${tn}" has been terminated.`;
  }
  return 'SCHTASKS /parameter [arguments]\n\nDescription:\n    Enables an administrator to create, delete, query, change, run, and\n    end scheduled tasks on a local or remote computer.';
}

export function runScheduledProgram(
  task: WinScheduledTask,
  pm: WinSystemProcessManager,
  now: Date,
): void {
  task.lastRunTime = now;
  task.lastResult = '0x0';
  // Une exécution ne réveille pas une tâche désactivée : désactiver coupe
  // les déclencheurs, et un `/run` manuel ne rend pas la tâche active.
  if (task.state !== 'Disabled') task.state = 'Ready';
  if (!task.command) return;
  const target = task.command.replace(/^["']|["']$/g, '');
  const leaf = target.split(/[\\/]/).pop() ?? target;
  const imageName = /\.exe$/i.test(leaf) ? leaf : `${leaf}.exe`;
  const parent = pm.getAllProcesses().find(p => p.name.toLowerCase() === 'svchost.exe');
  pm.spawnProcess(imageName, parent?.pid ?? 1, 'NT AUTHORITY\\SYSTEM', {
    session: 'Services', sessionId: 0,
  });
}

/**
 * Les champs de `schtasks /query`, du plus court au plus bavard.
 *
 * `/fo LIST` en donne cinq ; `/v` y ajoute tout ce que la tâche porte.
 * Les valeurs figées (`Logon Mode`, `Idle Time`, `Power Management`, …)
 * sont celles qu'une tâche créée en ligne de commande a réellement, et
 * pas un remplissage : `schtasks /create` ne propose aucune option pour
 * les changer, donc elles ne peuvent pas différer.
 */
function schtasksFields(ctx: WinSystemContext, t: WinScheduledTask, verbose: boolean): Array<[string, string]> {
  const na = (v: string | undefined) => (v && v.length > 0 ? v : 'N/A');
  const base: Array<[string, string]> = [
    ['HostName', ctx.hostname],
    ['TaskName', `${t.taskPath}${t.taskName}`],
    ['Next Run Time', t.runAt ? fmtSchtasksDate(t.runAt) : 'N/A'],
    ['Status', t.state],
    ['Logon Mode', 'Interactive/Background'],
  ];
  if (!verbose) return base;
  return [
    ...base,
    ['Last Run Time', t.lastRunTime ? fmtSchtasksDate(t.lastRunTime) : 'N/A'],
    // 267011 : « la tâche n'a pas encore tourné ». C'est le code que le
    // vrai affiche, et non un blanc.
    ['Last Result', t.lastResult ?? (t.lastRunTime ? '0' : '267011')],
    ['Author', na(t.author)],
    ['Task To Run', na(t.command)],
    ['Start In', 'N/A'],
    ['Comment', 'N/A'],
    ['Scheduled Task State', t.state === 'Disabled' ? 'Disabled' : 'Enabled'],
    ['Idle Time', 'Disabled'],
    ['Power Management', 'Stop On Battery Mode, No Start On Batteries'],
    ['Run As User', na(t.runAsUser)],
    ['Delete Task If Not Rescheduled', 'Disabled'],
    ['Stop Task If Runs X Hours and X Mins', '72:00:00'],
    ['Schedule', 'Scheduling data is not available in this format.'],
    ['Schedule Type', na(t.scheduleType)],
    ['Start Time', t.startTime ? fmtSchtasksClock(t.startTime) : 'N/A'],
    ['Start Date', t.startDate ? fmtSchtasksDay(t.startDate) : 'N/A'],
    ['End Date', 'N/A'],
    ['Days', na(t.days)],
    ['Months', na(t.months)],
    ['Repeat: Every', 'Disabled'],
    ['Repeat: Until: Time', 'Disabled'],
    ['Repeat: Until: Duration', 'Disabled'],
    ['Repeat: Stop If Still Running', 'Disabled'],
  ];
}

function renderSchtasksList(ctx: WinSystemContext, tasks: WinScheduledTask[], verbose: boolean): string {
  const out: string[] = ['Folder: \\'];
  for (const t of tasks) {
    const fields = schtasksFields(ctx, t, verbose);
    const width = Math.max(...fields.map(([k]) => k.length)) + 2;
    for (const [k, v] of fields) out.push(`${(k + ':').padEnd(width)}${v}`);
    out.push('');
  }
  return out.join('\n');
}

function renderSchtasksCsv(ctx: WinSystemContext, tasks: WinScheduledTask[], verbose: boolean): string {
  if (tasks.length === 0) return '';
  const header = schtasksFields(ctx, tasks[0], verbose).map(([k]) => `"${k}"`).join(',');
  const rows = tasks.map((t) =>
    schtasksFields(ctx, t, verbose).map(([, v]) => `"${v}"`).join(','));
  return [header, ...rows].join('\n');
}

/** Les libellés que `/query /v` imprime pour `Schedule Type`. */
const SCHEDULE_LABELS: Record<string, string> = {
  MINUTE: 'One Time Only, Minute', HOURLY: 'One Time Only, Hourly',
  DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', ONCE: 'One Time Only',
  ONSTART: 'At system start up', ONLOGON: 'At logon time', ONIDLE: 'On idle',
};

const WEEKDAY_ABBR = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function nextWeekday(day: string | undefined, st: string | undefined, base: Date): Date {
  const target = day ? WEEKDAY_ABBR.indexOf(day) : base.getDay();
  const at = st ? parseSchtasksTime(st, base) : new Date(base);
  if (target < 0) return at;
  const out = new Date(at);
  // `parseSchtasksTime` a déjà pu basculer au lendemain si l'heure était
  // passée ; on avance ensuite jusqu'au bon jour.
  while (out.getDay() !== target) out.setDate(out.getDate() + 1);
  return out;
}

function nextMonthly(dayOfMonth: number, st: string | undefined, base: Date): Date {
  const out = new Date(base);
  out.setDate(Math.min(Math.max(dayOfMonth, 1), 31));
  if (st) {
    const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(st);
    if (t) out.setHours(Number(t[1]), Number(t[2]), t[3] ? Number(t[3]) : 0, 0);
  } else {
    out.setHours(0, 0, 0, 0);
  }
  if (out.getTime() <= base.getTime()) out.setMonth(out.getMonth() + 1);
  return out;
}

function parseSchtasksTime(st: string, base: Date): Date {
  const m = st.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return new Date(base);
  const d = new Date(base);
  d.setHours(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 0, 0);
  if (d.getTime() <= base.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

function fmtSchtasksDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** `03:00` tel que schtasks l'imprime : `3:00:00 AM`. */
function fmtSchtasksClock(st: string): string {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(st);
  if (!m) return st;
  const h = Number(m[1]);
  const suffix = h < 12 ? 'AM' : 'PM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${m[2]}:${m[3] ?? '00'} ${suffix}`;
}

function fmtSchtasksDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
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
export function cmdWmic(ctx: WinSystemContext, args: string[]): string {
  if (args.length === 0) return 'wmic:root\\cli>';
  const joined = args.join(' ').toLowerCase();
  if (joined.includes('logicaldisk') && joined.includes('get name')) {
    return 'Name  \nC:    ';
  }
  if (joined.includes('os get caption')) {
    return `Caption                              \n${ctx.os.prettyName.padEnd(38)}`;
  }
  if (joined.includes('cpu get name')) {
    return 'Name                                              \nIntel(R) Core(TM) i7 CPU @ 2.50GHz                ';
  }
  if (joined.startsWith('nic ') || joined === 'nic') return wmicNic(ctx);
  if (joined.startsWith('nicconfig')) return wmicNicConfig(ctx);
  return '';
}

function wmicNic(ctx: WinSystemContext): string {
  const lignes = [`${'MACAddress'.padEnd(20)}${'Name'.padEnd(30)}NetEnabled`];
  for (const [name, port] of ctx.ports) {
    const mac = port.getMAC()?.toWindowsString() ?? '';
    const affiche = adapterDisplayName(name, ctx.ports);
    lignes.push(`${mac.padEnd(20)}${affiche.padEnd(30)}${port.isAdminDown() ? 'FALSE' : 'TRUE'}`);
  }
  return lignes.join('\n');
}

function wmicNicConfig(ctx: WinSystemContext): string {
  const lignes = [`${'IPAddress'.padEnd(24)}${'IPSubnet'.padEnd(20)}MACAddress`];
  for (const [name, port] of ctx.ports) {
    const mac = port.getMAC()?.toWindowsString() ?? '';
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    lignes.push(
      `${(ip ? `{"${ip}"}` : '').padEnd(24)}${(mask ? `{"${mask}"}` : '').padEnd(20)}${mac}`,
    );
    void name;
  }
  return lignes.join('\n');
}
