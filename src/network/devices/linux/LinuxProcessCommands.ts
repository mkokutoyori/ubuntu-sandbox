/**
 * LinuxProcessCommands — ps, top, kill, pidof, pgrep, pkill, systemctl, service.
 *
 * These commands wrap LinuxProcessManager and LinuxServiceManager and format
 * their output to match real Ubuntu/Debian binaries closely enough that
 * scripts that parse the output keep working.
 */

import type { LinuxProcessManager, Signal } from './LinuxProcessManager';
import { SIGNAL_NUMBERS } from './LinuxProcessManager';
import type { LinuxServiceManager, ServiceUnit, ServiceState } from './LinuxServiceManager';
import type { LinuxJobTable } from './jobs/LinuxJobTable';
import { runPs } from './ps/PsCommand';
import { memPercent, kbToMiB } from './system/ProcFormat';

function topCpuTime(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${min}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function loadAverage(running: number): string {
  const v = running.toFixed(2);
  return `${v}, ${v}, ${v}`;
}
import { LinuxService } from './service/LinuxService';
import { fullUnitName, unitSuffix } from './systemd/DependencyGraph';
import { exitStatusLabel } from './systemd/ExitStatus';
import { renderDependencyTree } from './systemd/DependencyTree';

/** Parameters describing the calling shell, used to render `ps` output. */
export interface ProcessCmdContext {
  pm: LinuxProcessManager;
  currentUser: string;
  currentUid: number;
  /** TTY of the current shell session, e.g. "pts/0". */
  tty: string;
  /** PID of the interactive `-bash`, so `ps -p $$` resolves. */
  shellPid?: number;
  /** PID of whoever is currently executing this command (`currentBashPid()`);
   *  used by `nice <cmd>`, which applies to the calling process, not `shellPid`. */
  currentPid?: number;
  /** Optional per-shell job table — needed for `kill %N` jobspec resolution. */
  jobs?: LinuxJobTable;
  /** Seconds since boot, for `top`'s header. Same source as `uptime`. */
  uptimeSeconds?: number;
  /** Host memory model — same source as `free` / `/proc/meminfo`. */
  memory?: import('../host/hardware').MemoryProfile;
  /** Runs a command line through the shell — backs `nice <cmd>`. */
  execute?: (cmd: string) => { output: string; exitCode: number };
}

// ─── ps ───────────────────────────────────────────────────────────────

/**
 * `ps` delegates to the modular selection/format engine in
 * {@link runPs}. The engine handles selection (-e/-p/-C/-u/--ppid),
 * formats (default/-f/-l/aux/-o), --sort and error reporting.
 */
export function cmdPs(args: string[], ctx: ProcessCmdContext): string {
  return runPs(args, ctx);
}

// ─── top ──────────────────────────────────────────────────────────────

export function cmdTop(args: string[], ctx: ProcessCmdContext): string {
  // We always print one snapshot — the simulator has no interactive top.
  const procs = ctx.pm.list();
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false });
  const mib = (kib: number) => Math.round(kib / 1024);
  const mem = ctx.memory;
  const totalMem = mem ? mib(mem.totalKib) : 3981;
  const usedMem = mem ? mib(mem.usedKib) : 1258;
  const freeMem = mem ? mib(mem.freeKib) : 1468;
  const bufCache = mem ? mib(mem.buffCacheKib) : 1254;

  const sleeping = procs.filter(p => p.state === 'S').length;
  const running = procs.filter(p => p.state === 'R').length;
  const stopped = procs.filter(p => p.state === 'T').length;
  const zombie = procs.filter(p => p.state === 'Z').length;

  const lines: string[] = [];
  const upSec = ctx.uptimeSeconds ?? 0;
  const upDays = Math.floor(upSec / 86_400);
  const upH = Math.floor((upSec % 86_400) / 3600);
  const upM = Math.floor((upSec % 3600) / 60);
  const upClause = upDays > 0
    ? `${upDays} day${upDays > 1 ? 's' : ''}, ${upH}:${String(upM).padStart(2, '0')}`
    : upH > 0 ? `${upH}:${String(upM).padStart(2, '0')}` : `${upM} min`;
  const runnable = procs.filter(p => p.state === 'R' || p.state === 'D').length;
  lines.push(`top - ${timeStr} up  ${upClause},  1 user,  load average: ${loadAverage(runnable)}`);
  lines.push(
    `Tasks: ${procs.length} total,  ${running} running, ${sleeping} sleeping,  ${stopped} stopped,  ${zombie} zombie`,
  );
  const busyPct = Math.min(100, running * 100);
  const us = (busyPct * 0.6).toFixed(1);
  const sy = (busyPct * 0.4).toFixed(1);
  const id = (100 - busyPct).toFixed(1);
  lines.push(`%Cpu(s):  ${us} us,  ${sy} sy,  0.0 ni,${id.padStart(5)} id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st`);
  lines.push(`MiB Mem :  ${totalMem}.0 total,  ${freeMem}.0 free,  ${usedMem}.0 used,  ${bufCache}.0 buff/cache`);
  lines.push('MiB Swap:  2048.0 total,  2048.0 free,      0.0 used.  2519.0 avail Mem');
  lines.push('');
  lines.push('    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND');

  for (const p of procs) {
    const pcpu = upSec > 0 ? ((p.cpuTime / 1000) / upSec) * 100 : 0;
    const mem = memPercent(p.rss);
    lines.push(
      [
        String(p.pid).padStart(7),
        p.user.padEnd(9),
        String(p.priority).padStart(3),
        String(p.nice).padStart(4),
        `${kbToMiB(p.vsize)}M`.padStart(7),
        `${kbToMiB(p.rss)}M`.padStart(6),
        '4M'.padStart(6),
        p.state,
        pcpu.toFixed(1).padStart(5),
        mem.padStart(5),
        topCpuTime(p.cpuTime).padStart(9),
        p.comm,
      ].join(' '),
    );
  }
  return lines.join('\n');
}

// ─── kill ─────────────────────────────────────────────────────────────

/** Map a -<num> or -SIGFOO style argument to a Signal name. */
function parseSignalArg(token: string): Signal | null {
  const cleaned = token.replace(/^-/, '');
  // Numeric form: -9, -15, etc.
  if (/^\d+$/.test(cleaned)) {
    const num = parseInt(cleaned, 10);
    for (const [name, n] of Object.entries(SIGNAL_NUMBERS)) {
      if (n === num) return name as Signal;
    }
    return null;
  }
  // Symbolic forms: SIGTERM, TERM, sigterm, term, KILL, etc.
  const upper = cleaned.toUpperCase();
  const candidates = [upper, `SIG${upper}`];
  for (const c of candidates) {
    if ((SIGNAL_NUMBERS as Record<string, number>)[c] !== undefined) {
      return c as Signal;
    }
  }
  return null;
}

export interface KillResult {
  output: string;
  exitCode: number;
}

export function cmdKill(args: string[], ctx: ProcessCmdContext): KillResult {
  if (args.length === 0) {
    return {
      output: 'kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]',
      exitCode: 2,
    };
  }

  // kill -l → list signals
  if (args[0] === '-l') {
    const list: string[] = [];
    const entries = Object.entries(SIGNAL_NUMBERS).sort((a, b) => a[1] - b[1]);
    for (const [name, num] of entries) {
      list.push(`${num}) ${name}`);
    }
    return { output: list.join('\n'), exitCode: 0 };
  }

  let signal: Signal = 'SIGTERM';
  const pidArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-s' || a === '-n') {
      const sig = parseSignalArg(args[++i] || '');
      if (!sig) return { output: `kill: ${args[i]}: invalid signal specification`, exitCode: 1 };
      signal = sig;
    } else if (a.startsWith('-') && a.length > 1) {
      const sig = parseSignalArg(a);
      if (!sig) return { output: `kill: ${a.slice(1)}: invalid signal specification`, exitCode: 1 };
      signal = sig;
    } else {
      pidArgs.push(a);
    }
  }

  if (pidArgs.length === 0) {
    return { output: 'kill: not enough arguments', exitCode: 2 };
  }

  // Self-kill with a terminating signal: bash exits with 128+signum
  // (e.g. SIGINT → 130). Common pattern used by tests that simulate
  // Ctrl-C: `bash -c 'kill -INT \$\$'`.
  const sigNum = SIGNAL_NUMBERS[signal] ?? 0;
  // SIGABRT/SIGSEGV aren't part of the Signal union this simulator
  // supports (no core-dump signals) - `signal` can never equal them.
  const TERMINATING_SIGS = new Set<Signal>([
    'SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGKILL', 'SIGHUP', 'SIGPIPE',
  ]);
  if (TERMINATING_SIGS.has(signal)) {
    for (const pidStr of pidArgs) {
      const n = Number.parseInt(pidStr, 10);
      if (!Number.isFinite(n) || n <= 0 || n >= 100000) continue;
      const tracked = ctx.pm.get(n);
      // Unknown PID? Fall through to the normal loop so the kernel-style
      // "No such process" diagnostic is emitted with the correct exit code.
      if (!tracked) continue;
      if (tracked.pid === 1) continue;
      if (tracked.pid !== (ctx.shellPid ?? -1)) continue;
      // Self-kill of the current shell with a terminating signal: bash
      // exits with 128 + signum (e.g. SIGINT → 130).
      return { output: '', exitCode: 128 + sigNum };
    }
  }

  const errors: string[] = [];
  let exitCode = 0;
  for (const pidArg of pidArgs) {
    if (pidArg.startsWith('%')) {
      const job = ctx.jobs?.resolve(pidArg);
      if (!job) {
        errors.push(`bash: kill: ${pidArg}: no such job`);
        exitCode = 1;
        continue;
      }
      ctx.pm.kill(job.pid, signal);
      const TERMINATES = new Set<Signal>(['SIGTERM','SIGINT','SIGQUIT','SIGKILL','SIGHUP']);
      if (TERMINATES.has(signal)) ctx.jobs?.remove(job.id);
      continue;
    }
    const pid = parseInt(pidArg, 10);
    if (isNaN(pid)) {
      errors.push(`kill: ${pidArg}: arguments must be process or job IDs`);
      exitCode = 1;
      continue;
    }
    if (!ctx.pm.get(pid)) {
      errors.push(`kill: (${pid}) - No such process`);
      exitCode = 1;
      continue;
    }
    const ok = ctx.pm.kill(pid, signal);
    if (!ok) {
      errors.push(`kill: (${pid}) - Operation not permitted`);
      exitCode = 1;
    }
  }
  return { output: errors.join('\n'), exitCode };
}

// ─── pidof / pgrep / pkill ────────────────────────────────────────────

export function cmdPidof(args: string[], ctx: ProcessCmdContext): KillResult {
  if (args.length === 0) return { output: '', exitCode: 1 };
  const allPids: number[] = [];
  for (const name of args) {
    allPids.push(...ctx.pm.pidof(name));
  }
  if (allPids.length === 0) return { output: '', exitCode: 1 };
  return { output: allPids.sort((a, b) => b - a).join(' '), exitCode: 0 };
}

export function cmdPgrep(args: string[], ctx: ProcessCmdContext): KillResult {
  // pgrep [-l] [-a] [-x] [-u user[,user...]] [pattern]
  let listLong = false;
  let listFull = false;
  let exact = false;
  let users: string[] | null = null;
  const patterns: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-l') listLong = true;
    else if (a === '-a') listFull = true;
    else if (a === '-x') exact = true;
    else if (a === '-u') users = (args[++i] ?? '').split(',').filter(Boolean);
    else patterns.push(a);
  }
  // Real pgrep only requires *some* selection criterion — a name pattern
  // is one, but `-u user` alone (list everything that user owns) is
  // equally valid and a common idiom.
  if (patterns.length === 0 && !users) {
    return { output: 'pgrep: no matching criteria specified', exitCode: 2 };
  }
  const pattern = patterns[0];
  const pids = pattern ? ctx.pm.pgrep(pattern, exact) : ctx.pm.list().map(p => p.pid);
  const filtered = pids
    .map(pid => ctx.pm.get(pid)!)
    .filter(p => (users ? users.includes(p.user) : true));
  if (filtered.length === 0) return { output: '', exitCode: 1 };
  const lines = filtered.map(p => (
    listFull ? `${p.pid} ${p.command}` : listLong ? `${p.pid} ${p.comm}` : String(p.pid)
  ));
  return { output: lines.join('\n'), exitCode: 0 };
}

export function cmdPkill(args: string[], ctx: ProcessCmdContext): KillResult {
  let signal: Signal = 'SIGTERM';
  let exact = false;
  const positional: string[] = [];
  for (const a of args) {
    if (a === '-x') { exact = true; continue; }
    if (a.startsWith('-')) {
      const sig = parseSignalArg(a);
      if (sig) {
        signal = sig;
        continue;
      }
    }
    positional.push(a);
  }
  if (positional.length === 0) {
    return { output: 'pkill: no matching criteria specified', exitCode: 2 };
  }
  const count = ctx.pm.pkill(positional[0], signal, exact);
  return { output: '', exitCode: count > 0 ? 0 : 1 };
}

/**
 * `killall` — signal every process whose command name matches *exactly*.
 * PID 1 (init/systemd) is protected: it can never be signalled, exactly as
 * on a real host.
 */
export function cmdKillall(args: string[], ctx: ProcessCmdContext): KillResult {
  let signal: Signal = 'SIGTERM';
  const names: string[] = [];
  for (const a of args) {
    if (a.startsWith('-')) {
      const sig = parseSignalArg(a);
      if (sig) signal = sig;
      continue; // ignore other flags (-q -v -w -e -I …)
    }
    names.push(a);
  }
  if (names.length === 0) {
    return { output: 'killall: usage: killall [OPTION]... [--] NAME...', exitCode: 1 };
  }

  const out: string[] = [];
  let signalled = 0;
  for (const name of names) {
    const pids = ctx.pm.pidof(name);
    if (pids.length === 0) {
      out.push(`${name}: no process found`);
      continue;
    }
    for (const pid of pids) {
      if (pid === 1) {
        out.push(`${name}(1): Operation not permitted`);
        continue;
      }
      ctx.pm.kill(pid, signal);
      signalled++;
    }
  }
  return { output: out.join('\n'), exitCode: signalled === 0 ? 1 : 0 };
}

// ─── systemctl ────────────────────────────────────────────────────────

export interface SysCtlResult {
  output: string;
  exitCode: number;
}

function unitFailedResult(u: ServiceUnit): string {
  if (u.failedReason === 'start-limit-hit') return 'start-limit-hit';
  // `oom-kill` est un résultat systemd à part entière, distinct de
  // `signal` : la cause est distincte, et c'est ce mot qui envoie
  // l'opérateur regarder la mémoire plutôt que la configuration (§F5.9).
  if (u.failedReason === 'oom-kill') return 'oom-kill';
  if (u.lastExit?.signal !== undefined) return 'signal';
  if (u.lastExit?.code !== undefined && u.lastExit.code !== 0) return 'exit-code';
  return 'exit-code';
}

const ACTIVE_SUBSTATE: Record<ReturnType<typeof unitSuffix>, string> = {
  service: 'running',
  target: 'active',
  socket: 'listening',
  timer: 'waiting',
};

/**
 * La ligne `Active:` en DEUX morceaux, parce que la couleur ne les couvre
 * pas tous les deux.
 *
 * systemd imprime `printf("     Active: %s%s (%s)%s", on, state, sub, off)`
 * puis, EN DEHORS de la couleur, le `(Result: …)` et le ` since …`. La
 * distinction ne se voit pas sur une capture d'écran, elle se lit dans
 * `systemctl-show.c` : `état (sous-état)` est colorié, la date ne l'est
 * jamais. Rendre la ligne entière verte serait plus voyant et faux.
 */
function unitActiveParts(u: ServiceUnit): { head: string; tail: string } {
  switch (u.state) {
    case 'active':
      return {
        head: `active (${ACTIVE_SUBSTATE[unitSuffix(u.name)]})`,
        tail: ` since ${u.activeSince?.toUTCString() ?? new Date().toUTCString()}`,
      };
    case 'activating':
      return { head: u.autoRestartPending ? 'activating (auto-restart)' : 'activating (start)', tail: '' };
    case 'deactivating':
      return { head: 'deactivating (stop)', tail: '' };
    case 'failed':
      return { head: 'failed', tail: ` (Result: ${unitFailedResult(u)})` };
    default:
      return { head: 'inactive (dead)', tail: '' };
  }
}


function unitProcessLine(u: ServiceUnit): string | null {
  const exit = u.lastExit;
  if (!exit) return null;
  const cause = exit.signal !== undefined
    ? `code=killed, signal=${exit.signal.replace(/^SIG/, '')}`
    : `code=exited, status=${exit.code ?? 0}/${exitStatusLabel(exit.code ?? 0)}`;
  return `    Process: ExecStart=${u.execStart} (${cause})`;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatTimerDate(d: Date | null): string {
  if (!d) return 'n/a';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${DAY_NAMES[d.getUTCDay()]} ${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}

function formatTimerDelta(later: Date | null, earlier: Date | null): string {
  if (!later || !earlier) return 'n/a';
  const seconds = Math.round((later.getTime() - earlier.getTime()) / 1000);
  if (seconds < 0) return 'n/a';
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}min`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)} days`;
}

/**
 * The name of the unit's MAIN PROCESS, which is what systemd prints in
 * `Main PID: 1234 (sshd)` — the executable's basename, not the unit's.
 *
 * It used to print the unit name, so `systemctl status ssh` claimed
 * `(ssh)` while `ps` on the same machine showed `/usr/sbin/sshd -D`: two
 * layers naming one process differently. Deriving it from the very
 * `ExecStart=` the process was spawned from is what keeps them agreeing.
 */
function mainProcessName(u: ServiceUnit): string {
  const exe = (u.execStart ?? '').trim().split(/\s+/)[0];
  const base = exe.split('/').filter(Boolean).pop();
  return base && base.length > 0 ? base : u.name;
}

/**
 * Les deux séquences que systemd emploie ici, telles que les définit
 * `basic/terminal-util.h` : `ANSI_HIGHLIGHT_RED` et `ANSI_HIGHLIGHT_GREEN`
 * — un `0` de remise à zéro AVANT le gras et la teinte, ce qui rend la
 * séquence indépendante de ce qui la précède. Le rouge est mesuré sur le
 * vrai binaire (son message « Failed to connect to bus » sort en
 * `\e[0;1;31m`) ; le vert est son jumeau dans la même famille de macros.
 */
const SD_RED = '[0;1;31m';
const SD_GREEN = '[0;1;32m';
const SD_NORMAL = '[0m';

/**
 * Ce que systemd appelle `active_on`/`active_off` : la couleur de l'état,
 * qui habille à la fois la pastille et le mot d'état. Rien d'autre que
 * `failed` et `active` n'est colorié — `activating` et `inactive` sortent
 * nus, ce qui est un fait de systemd et non un oubli ici.
 */
function unitStateColor(u: ServiceUnit, color: boolean): { on: string; off: string } {
  if (!color) return { on: '', off: '' };
  if (u.state === 'failed') return { on: SD_RED, off: SD_NORMAL };
  if (u.state === 'active') return { on: SD_GREEN, off: SD_NORMAL };
  return { on: '', off: '' };
}

/**
 * Render the multi-line `systemctl status NAME` block for one unit.
 *
 * `color` suit la règle de systemd lui-même : il ne colorie que si sa
 * sortie standard est un terminal, donc `systemctl status ssh | grep`
 * reçoit du texte nu — sans quoi les séquences entreraient dans le tube.
 */
function renderUnitStatus(u: ServiceUnit, color: boolean): string {
  const dot = u.state === 'active' ? '●' : u.state === 'failed' ? '×' : '○';
  const { on, off } = unitStateColor(u, color);
  const active = unitActiveParts(u);
  const loadedLine = `     Loaded: loaded (${u.loadedFrom}; ${u.enabled}; vendor preset: enabled)`;
  const lines = [
    `${on}${dot}${off} ${fullUnitName(u.name)} - ${u.description}`,
    loadedLine,
    `     Active: ${on}${active.head}${off}${active.tail}`,
  ];
  const processLine = u.state !== 'active' ? unitProcessLine(u) : null;
  if (processLine) lines.push(processLine);
  if (u.state === 'active' && u.mainPid !== undefined) {
    lines.push(`   Main PID: ${u.mainPid} (${mainProcessName(u)})`);
    lines.push(`      Tasks: 1`);
    lines.push(`     Memory: ${(2 + (u.mainPid % 40) / 10).toFixed(1)}M`);
    lines.push(`        CPU: ${10 + (u.mainPid % 500)}ms`);
    lines.push(`     CGroup: /system.slice/${u.name}.service`);
    lines.push(`             └─${u.mainPid} ${u.execStart}`);
  }
  return lines.join('\n');
}

/**
 * Validate a `systemctl set-property` assignment. Returns an error
 * string for an unknown key or malformed value, else null.
 */
function validateUnitProperty(key: string, val: string): string | null {
  const validators: Record<string, RegExp> = {
    CPUQuota: /^\d+%$/,
    CPUWeight: /^\d+$/,
    MemoryMax: /^(\d+[KMG]?|infinity)$/,
    MemoryHigh: /^(\d+[KMG]?|infinity)$/,
    MemoryLimit: /^(\d+[KMG]?|infinity)$/,
    TasksMax: /^(\d+|infinity)$/,
    IOWeight: /^\d+$/,
  };
  const rule = validators[key];
  if (!rule) {
    return `Cannot set property ${key}, or unknown property.`;
  }
  if (!rule.test(val)) {
    return `Failed to parse ${key}= setting "${val}".`;
  }
  return null;
}

/**
 * Package-name → daemon-unit-name aliases for units whose systemd file is
 * shipped under a different name than the apt package (matching real
 * Debian/Ubuntu: `apt install bind9` ships `named.service`, and
 * `bind9.service` is a compatibility alias for it).
 */
const UNIT_ALIASES: Record<string, string> = {
  bind9: 'named',
  // Debian nomme l'unite de chrony `chrony.service`, RHEL la nomme
  // `chronyd.service`, et le tutoriel NTP montre les DEUX (`systemctl
  // enable --now chronyd`). Un lecteur qui suit la colonne RHEL doit
  // trouver son service, pas un `Unit could not be found` qui ne lui
  // apprendrait rien sur NTP.
  chronyd: 'chrony',
  strongswan: 'strongswan-starter',
};

function resolveUnitAlias(name: string): string {
  return UNIT_ALIASES[name] ?? name;
}

export function cmdSystemctl(args: string[], sm: LinuxServiceManager, color = false): SysCtlResult {
  let sub = (args[0] || '').toLowerCase();
  // Bare option invocations (`systemctl --failed`, `--type=service`,
  // `-t service`) are listing requests in real systemd.
  if (sub.startsWith('-') && sub !== '--version') sub = 'list-units';
  // Les options se glissent avant le nom d'unité : `enable --now cron`
  // faisait chercher une unité nommée « --now ». Le nom est le premier
  // mot qui n'est pas une option.
  const operands = args.slice(1).filter((a) => !a.startsWith('-'));
  const withNow = args.slice(1).some((a) => a === '--now');
  const unit = resolveUnitAlias((operands[0] || '').replace(/\.service$/, ''));

  if (!sub) {
    return {
      output:
        'systemctl [OPTIONS...] COMMAND ...\n\n' +
        'Query or send control commands to the system manager.\n\n' +
        'Common commands: start stop restart reload status enable disable\n' +
        '                 is-active is-enabled list-units list-unit-files\n' +
        '                 daemon-reload',
      exitCode: 0,
    };
  }

  switch (sub) {
    case 'status': {
      if (!unit) {
        return {
          output: [
            '● localhost',
            '    State: running',
            '     Jobs: 0 queued',
            '   Failed: 0 units',
            `   Since: ${new Date().toUTCString()}`,
            '   CGroup: /',
          ].join('\n'),
          exitCode: 0,
        };
      }
      const u = sm.status(unit);
      if (!u) return { output: `Unit ${fullUnitName(unit)} could not be found.`, exitCode: 4 };
      return { output: renderUnitStatus(u, color), exitCode: u.state === 'active' ? 0 : 3 };
    }

    case 'start':
    case 'stop':
    case 'restart':
    case 'reload': {
      if (!unit) return { output: 'Too few arguments.', exitCode: 1 };
      const fn = sub === 'start' ? sm.start : sub === 'stop' ? sm.stop : sub === 'restart' ? sm.restart : sm.reload;
      const result = fn.call(sm, unit);
      if (!result.ok) {
        return {
          output: result.verbatim && result.error
            ? result.error
            : `Failed to ${sub} ${fullUnitName(unit)}: ${result.error ?? 'unknown error'}`,
          exitCode: 1,
        };
      }
      return { output: '', exitCode: 0 };
    }

    case 'isolate': {
      if (!unit) return { output: 'Too few arguments.', exitCode: 1 };
      const result = sm.isolate(unit);
      if (!result.ok) {
        return {
          output: `Failed to isolate ${fullUnitName(unit)}: ${result.error ?? 'unknown error'}`,
          exitCode: 1,
        };
      }
      return { output: '', exitCode: 0 };
    }

    case 'enable':
    case 'disable': {
      if (!unit) return { output: 'Too few arguments.', exitCode: 1 };
      const fn = sub === 'enable' ? sm.enable : sm.disable;
      const result = fn.call(sm, unit);
      if (!result.ok) {
        return { output: `Failed to ${sub} unit: ${result.error ?? 'unknown error'}`, exitCode: 1 };
      }
      // `--now` enchaîne l'action correspondante — c'est la forme la plus
      // courante pour poser un timer (`enable --now mon.timer`).
      if (withNow) {
        const act = sub === 'enable' ? sm.start(unit) : sm.stop(unit);
        if (!act.ok) {
          return { output: `Failed to ${sub === 'enable' ? 'start' : 'stop'} ${unit}: ${act.error ?? 'unknown error'}`, exitCode: 1 };
        }
      }
      const suffix = unitSuffix(unit) === 'service' ? `${unit}.service` : unit;
      if (sub === 'enable') {
        return {
          output: `Created symlink /etc/systemd/system/multi-user.target.wants/${suffix} → /usr/lib/systemd/system/${suffix}.`,
          exitCode: 0,
        };
      }
      return {
        output: `Removed /etc/systemd/system/multi-user.target.wants/${suffix}.`,
        exitCode: 0,
      };
    }

    case 'is-active': {
      const u = sm.status(unit);
      const state = u?.state ?? 'inactive';
      return { output: state, exitCode: state === 'active' ? 0 : 3 };
    }

    case 'is-enabled': {
      const u = sm.status(unit);
      const en = u?.enabled ?? 'disabled';
      return { output: en, exitCode: en === 'enabled' || en === 'static' ? 0 : 1 };
    }

    case 'list-units':
    case 'list-unit-files': {
      // Honour both the legacy `--failed` shortcut and `--state=<state>`.
      const stateArg = args.find((a) => a.startsWith('--state='));
      const stateFilter = args.includes('--failed')
        ? 'failed'
        : stateArg?.slice('--state='.length);
      const typeArg = args.find((a) => a.startsWith('--type='))?.slice('--type='.length)
        ?? (args.includes('-t') ? args[args.indexOf('-t') + 1] : undefined);
      const matchesType = (name: string): boolean => !typeArg || unitSuffix(name) === typeArg;
      const allUnits = (stateFilter
        ? sm.list({ state: stateFilter as ServiceState })
        : sm.list()).filter((u) => matchesType(u.name));
      const lines = ['  UNIT                          LOAD   ACTIVE SUB     DESCRIPTION'];
      for (const u of allUnits) {
        const active = u.state === 'active' ? 'active' : u.state === 'failed' ? 'failed' : 'inactive';
        const sub2 = u.state !== 'active' ? 'dead' : ACTIVE_SUBSTATE[unitSuffix(u.name)];
        lines.push(
          `  ${fullUnitName(u.name).padEnd(30)} loaded ${active.padEnd(8)} ${sub2.padEnd(8)} ${u.description}`,
        );
      }
      lines.push('');
      lines.push('LOAD   = Reflects whether the unit definition was properly loaded.');
      lines.push('ACTIVE = The high-level unit activation state, i.e. generalization of SUB.');
      lines.push('SUB    = The low-level unit activation state, values depend on unit type.');
      lines.push('');
      lines.push(`${allUnits.length} loaded units listed. Pass --all to see loaded but inactive units, too.`);
      lines.push("To show all installed unit files use 'systemctl list-unit-files'.");
      return { output: lines.join('\n'), exitCode: 0 };
    }

    case 'daemon-reload':
    case 'daemon-reexec':
      sm.daemonReload();
      return { output: '', exitCode: 0 };

    case '--version':
    case 'version':
      return {
        output: 'systemd 249 (249.11-0ubuntu3)\n+PAM +AUDIT +SELINUX +APPARMOR +SYSVINIT',
        exitCode: 0,
      };

    case 'get-default':
      return { output: sm.defaultTarget(), exitCode: 0 };

    case 'is-failed': {
      // `is-failed` prints the unit's ACTIVE STATE and exits 0 only when
      // it is `failed`. It used to print `active` for anything that was
      // not failed, so a stopped unit answered `inactive` to `is-active`
      // and `active` to `is-failed` — the same unit, the same instant,
      // two contradictory answers.
      const u = sm.status(unit);
      const state = u?.state ?? 'inactive';
      return { output: state, exitCode: state === 'failed' ? 0 : 1 };
    }

    case 'mask':
    case 'unmask': {
      if (!unit) return { output: 'Too few arguments.', exitCode: 1 };
      const r = sub === 'mask' ? sm.mask(unit) : sm.unmask(unit);
      if (!r.ok) return { output: `Failed to ${sub} unit: ${r.error}`, exitCode: 1 };
      const verb = sub === 'mask' ? 'Created' : 'Removed';
      return {
        output: `${verb} symlink /etc/systemd/system/${unit}.service${sub === 'mask' ? ' → /dev/null' : ''}.`,
        exitCode: 0,
      };
    }

    case 'reset-failed':
      sm.resetFailed(unit || undefined);
      return { output: '', exitCode: 0 };

    case 'show': {
      const props: string[] = [];
      let target = '';
      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === '-p' || a === '--property') {
          props.push(...(args[++i] ?? '').split(',').filter(Boolean));
        } else if (a.startsWith('--property=')) {
          props.push(...a.slice('--property='.length).split(',').filter(Boolean));
        } else if (a === '-a' || a === '--all') {
          /* show all: ignored, we print the default set */
        } else if (!a.startsWith('-')) {
          target = a.replace(/\.service$/, '');
        }
      }
      if (!target) {
        return {
          output: [
            `Version=249`,
            `Architecture=x86-64`,
            `NNames=1`,
            `DefaultTimeoutStartUSec=1min 30s`,
          ].join('\n'),
          exitCode: 0,
        };
      }
      const u = sm.status(target);
      if (!u) {
        // systemd prints empty values for unknown units, exit 0.
        return { output: props.map(p => `${p}=`).join('\n'), exitCode: 0 };
      }
      const keys = props.length > 0 ? props : LinuxService.DEFAULT_SHOW_KEYS;
      return {
        output: keys.map(k => `${k}=${u.effectiveProp(k)}`).join('\n'),
        exitCode: 0,
      };
    }

    case 'set-property': {
      if (!unit) return { output: 'Too few arguments.', exitCode: 1 };
      const u = sm.status(unit);
      if (!u) return { output: `Unit ${unit}.service not loaded.`, exitCode: 1 };
      const pairs = args.slice(2).filter(a => a.includes('='));
      if (pairs.length === 0) return { output: 'Too few arguments.', exitCode: 1 };
      for (const pair of pairs) {
        const eq = pair.indexOf('=');
        const key = pair.slice(0, eq);
        const val = pair.slice(eq + 1);
        const err = validateUnitProperty(key, val);
        if (err) return { output: err, exitCode: 1 };
        u.setProperty(key, val);
      }
      return { output: '', exitCode: 0 };
    }

    case 'list-timers': {
      const now = new Date();
      // `list-timers mon.timer` ne montre que celui-là — l'argument était
      // accepté puis ignoré, et la commande répondait toute la table.
      const wanted = operands.map((o) => (o.includes('.') ? o : `${o}.timer`));
      const timers = sm.timerEntries()
        .filter((t) => wanted.length === 0 || wanted.includes(t.unit));
      // La colonne UNIT se cale sur le plus long nom présent : à largeur
      // fixe, `systemd-tmpfiles-clean.timer` débordait sur ACTIVATES et
      // les deux se lisaient collés.
      const unitWidth = Math.max(20, ...timers.map((t) => t.unit.length + 1));
      const lines = [
        'NEXT'.padEnd(30) + 'LEFT'.padEnd(10) + 'LAST'.padEnd(30)
        + 'PASSED'.padEnd(10) + 'UNIT'.padEnd(unitWidth) + 'ACTIVATES',
      ];
      for (const t of timers) {
        lines.push([
          formatTimerDate(t.next).padEnd(30),
          formatTimerDelta(t.next, now).padEnd(10),
          formatTimerDate(t.last).padEnd(30),
          formatTimerDelta(now, t.last).padEnd(10),
          t.unit.padEnd(unitWidth),
          fullUnitName(t.activates),
        ].join(''));
      }
      lines.push('');
      lines.push(`${timers.length} timers listed.`);
      return { output: lines.join('\n'), exitCode: 0 };
    }

    case 'list-sockets': {
      const sockets = sm.socketEntries();
      const lines = ['LISTEN                UNIT                ACTIVATES'];
      for (const s of sockets) {
        lines.push(`${`0.0.0.0:${s.port}`.padEnd(22)}${s.unit.padEnd(20)}${fullUnitName(s.service)}`);
      }
      lines.push('');
      lines.push(`${sockets.length} sockets listed.`);
      return { output: lines.join('\n'), exitCode: 0 };
    }

    case 'list-dependencies': {
      const root = unit || sm.defaultTarget();
      if (!sm.status(root)) {
        return { output: `Failed to get dependencies: Unit ${fullUnitName(root)} not found.`, exitCode: 1 };
      }
      return { output: renderDependencyTree(root, sm.dependencyGraph()), exitCode: 0 };
    }

    case 'cat': {
      if (!unit) return { output: 'Too few arguments.', exitCode: 1 };
      const u = sm.status(unit);
      if (!u) return { output: `No files found for ${unit}.service.`, exitCode: 1 };
      // Caller resolves the file via VFS; for simplicity we render a synthesized view here.
      const lines = [
        `# ${u.loadedFrom}`,
        '[Unit]',
        `Description=${u.description}`,
        '',
        '[Service]',
        `Type=${u.type}`,
        `ExecStart=${u.execStart}`,
        ...(u.execReload ? [`ExecReload=${u.execReload}`] : []),
        `User=${u.user}`,
        '',
        '[Install]',
        'WantedBy=multi-user.target',
      ];
      return { output: lines.join('\n'), exitCode: 0 };
    }

    default:
      return { output: `Unknown command verb ${sub}.`, exitCode: 1 };
  }
}

// ─── service (SysV-style wrapper) ─────────────────────────────────────

export function cmdService(args: string[], sm: LinuxServiceManager): SysCtlResult {
  if (args[0] === '--status-all') {
    const units = sm.list();
    const lines = units.map(u => ` [ ${u.state === 'active' ? '+' : '-'} ]  ${u.name}`);
    return { output: lines.join('\n'), exitCode: 0 };
  }

  const name = resolveUnitAlias(args[0] || '');
  const action = (args[1] || '').toLowerCase();
  if (!name) {
    return { output: 'Usage: service <service> {start|stop|restart|status}', exitCode: 1 };
  }

  const u = sm.status(name);
  if (!u) return { output: `${name}: unrecognized service`, exitCode: 1 };

  switch (action) {
    case 'status':
      return {
        output: u.state === 'active'
          ? ` * ${u.name} is running\n   Active: active (running)`
          : ` * ${u.name} is not running\n   Active: inactive (dead)`,
        exitCode: u.state === 'active' ? 0 : 3,
      };
    case 'start': {
      const r = sm.start(name);
      return { output: r.ok ? '' : r.error ?? '', exitCode: r.ok ? 0 : 1 };
    }
    case 'stop': {
      const r = sm.stop(name);
      return { output: r.ok ? '' : r.error ?? '', exitCode: r.ok ? 0 : 1 };
    }
    case 'restart': {
      const r = sm.restart(name);
      return { output: r.ok ? '' : r.error ?? '', exitCode: r.ok ? 0 : 1 };
    }
    case 'reload': {
      const r = sm.reload(name);
      return { output: r.ok ? '' : r.error ?? '', exitCode: r.ok ? 0 : 1 };
    }
    default:
      return {
        output: `Usage: service ${name} {start|stop|restart|status}`,
        exitCode: 1,
      };
  }
}
