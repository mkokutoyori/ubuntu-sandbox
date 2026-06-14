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
import { LinuxService } from './service/LinuxService';

/** Parameters describing the calling shell, used to render `ps` output. */
export interface ProcessCmdContext {
  pm: LinuxProcessManager;
  currentUser: string;
  currentUid: number;
  /** TTY of the current shell session, e.g. "pts/0". */
  tty: string;
  /** PID of the interactive `-bash`, so `ps -p $$` resolves. */
  shellPid?: number;
  /** Optional per-shell job table — needed for `kill %N` jobspec resolution. */
  jobs?: LinuxJobTable;
  /** Seconds since boot, for `top`'s header. Same source as `uptime`. */
  uptimeSeconds?: number;
  /** Host memory model — same source as `free` / `/proc/meminfo`. */
  memory?: import('../host/hardware').MemoryProfile;
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
  lines.push(`top - ${timeStr} up  ${upClause},  1 user,  load average: 0.08, 0.03, 0.01`);
  lines.push(
    `Tasks: ${procs.length} total,  ${running} running, ${sleeping} sleeping,  ${stopped} stopped,  ${zombie} zombie`,
  );
  lines.push('%Cpu(s):  1.2 us,  0.5 sy,  0.0 ni, 98.2 id,  0.1 wa,  0.0 hi,  0.0 si,  0.0 st');
  lines.push(`MiB Mem :  ${totalMem}.0 total,  ${freeMem}.0 free,  ${usedMem}.0 used,  ${bufCache}.0 buff/cache`);
  lines.push('MiB Swap:  2048.0 total,  2048.0 free,      0.0 used.  2519.0 avail Mem');
  lines.push('');
  lines.push('    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND');

  for (const p of procs) {
    const cpu = '0.0';
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
        cpu.padStart(5),
        mem.padStart(5),
        '0:00.10'.padStart(9),
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
  const TERMINATING_SIGS = new Set<Signal>([
    'SIGTERM', 'SIGINT', 'SIGQUIT', 'SIGKILL', 'SIGHUP', 'SIGPIPE', 'SIGABRT', 'SIGSEGV',
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
  // pgrep [-l] [-u user] pattern
  let listLong = false;
  let user: string | null = null;
  const patterns: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-l') listLong = true;
    else if (a === '-u') user = args[++i];
    else patterns.push(a);
  }
  if (patterns.length === 0) {
    return { output: 'pgrep: no matching criteria specified', exitCode: 2 };
  }
  const pattern = patterns[0];
  const pids = ctx.pm.pgrep(pattern);
  const filtered = pids
    .map(pid => ctx.pm.get(pid)!)
    .filter(p => (user ? p.user === user : true));
  if (filtered.length === 0) return { output: '', exitCode: 1 };
  const lines = filtered.map(p => (listLong ? `${p.pid} ${p.comm}` : String(p.pid)));
  return { output: lines.join('\n'), exitCode: 0 };
}

export function cmdPkill(args: string[], ctx: ProcessCmdContext): KillResult {
  let signal: Signal = 'SIGTERM';
  const positional: string[] = [];
  for (const a of args) {
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
  const count = ctx.pm.pkill(positional[0], signal);
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

/** Render the multi-line `systemctl status NAME` block for one unit. */
function renderUnitStatus(u: ServiceUnit): string {
  const dot = u.state === 'active' ? '●' : u.state === 'failed' ? '×' : '○';
  const sub = u.state === 'active' ? 'running' : 'dead';
  const loadedLine = `     Loaded: loaded (${u.loadedFrom}; ${u.enabled}; vendor preset: enabled)`;
  const activeStr =
    u.state === 'active'
      ? `active (${sub}) since ${u.activeSince?.toUTCString() ?? new Date().toUTCString()}`
      : `inactive (dead)`;
  const lines = [
    `${dot} ${u.name}.service - ${u.description}`,
    loadedLine,
    `     Active: ${activeStr}`,
  ];
  if (u.mainPid !== undefined) {
    lines.push(`   Main PID: ${u.mainPid} (${u.name})`);
    lines.push(`      Tasks: 1`);
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

export function cmdSystemctl(args: string[], sm: LinuxServiceManager): SysCtlResult {
  let sub = (args[0] || '').toLowerCase();
  // Bare option invocations (`systemctl --failed`, `--type=service`,
  // `-t service`) are listing requests in real systemd.
  if (sub.startsWith('-') && sub !== '--version') sub = 'list-units';
  const unit = (args[1] || '').replace(/\.service$/, '');

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
      if (!u) return { output: `Unit ${unit}.service could not be found.`, exitCode: 4 };
      return { output: renderUnitStatus(u), exitCode: u.state === 'active' ? 0 : 3 };
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
          output: `Failed to ${sub} ${unit}.service: ${result.error ?? 'unknown error'}`,
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
      if (sub === 'enable') {
        return {
          output: `Created symlink /etc/systemd/system/multi-user.target.wants/${unit}.service → /usr/lib/systemd/system/${unit}.service.`,
          exitCode: 0,
        };
      }
      return {
        output: `Removed /etc/systemd/system/multi-user.target.wants/${unit}.service.`,
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
      return { output: en, exitCode: en === 'enabled' ? 0 : 1 };
    }

    case 'list-units':
    case 'list-unit-files': {
      // Honour both the legacy `--failed` shortcut and `--state=<state>`.
      const stateArg = args.find((a) => a.startsWith('--state='));
      const stateFilter = args.includes('--failed')
        ? 'failed'
        : stateArg?.slice('--state='.length);
      const allUnits = stateFilter
        ? sm.list({ state: stateFilter as ServiceState })
        : sm.list();
      const lines = ['  UNIT                          LOAD   ACTIVE SUB     DESCRIPTION'];
      for (const u of allUnits) {
        const active = u.state === 'active' ? 'active' : u.state === 'failed' ? 'failed' : 'inactive';
        const sub2 = u.state === 'active' ? 'running' : 'dead';
        lines.push(
          `  ${(u.name + '.service').padEnd(30)} loaded ${active.padEnd(8)} ${sub2.padEnd(8)} ${u.description}`,
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
      const u = sm.status(unit);
      const failed = u?.state === 'failed';
      return { output: failed ? 'failed' : 'active', exitCode: failed ? 0 : 1 };
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

    case 'list-timers':
      return { output: 'NEXT LEFT LAST PASSED UNIT ACTIVATES\n\n0 timers listed.', exitCode: 0 };

    case 'list-sockets':
      return { output: 'LISTEN UNIT ACTIVATES\n\n0 sockets listed.', exitCode: 0 };

    case 'list-dependencies': {
      const u = unit ? sm.status(unit) : null;
      if (unit && !u) return { output: `Failed to get dependencies: Unit ${unit}.service not found.`, exitCode: 1 };
      const head = unit ? `${unit}.service` : sm.defaultTarget();
      const deps = u ? u.after : [];
      return { output: [head, ...deps.map(d => `● └─${d}`)].join('\n'), exitCode: 0 };
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

  const name = args[0];
  const action = (args[1] || '').toLowerCase();
  if (!name) {
    return { output: 'Usage: service <service> {start|stop|restart|status}', exitCode: 1 };
  }

  const u = sm.status(name);
  if (!u) return { output: `${name}: unrecognized service`, exitCode: 1 };

  switch (action) {
    case 'status':
      return {
        output: ` * ${u.name} ${u.state === 'active' ? 'is running' : 'is not running'}`,
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
