/**
 * LinuxProcessCommands — ps, top, kill, pidof, pgrep, pkill, systemctl, service.
 *
 * These commands wrap LinuxProcessManager and LinuxServiceManager and format
 * their output to match real Ubuntu/Debian binaries closely enough that
 * scripts that parse the output keep working.
 */

import type { LinuxProcessManager, ProcessInfo, Signal } from './LinuxProcessManager';
import { SIGNAL_NUMBERS } from './LinuxProcessManager';
import type { LinuxServiceManager, ServiceUnit } from './LinuxServiceManager';

/** Parameters describing the calling shell, used to render `ps` output. */
export interface ProcessCmdContext {
  pm: LinuxProcessManager;
  currentUser: string;
  currentUid: number;
  /** TTY of the current shell session, e.g. "pts/0". */
  tty: string;
}

// ─── ps ───────────────────────────────────────────────────────────────

/** Format a duration in milliseconds as HH:MM:SS for ps STIME. */
function formatStartTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Format CPU time in milliseconds as MM:SS.cs for ps TIME. */
function formatCpuTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Render the long BSD-style ps aux line for one process. */
function renderAuxLine(p: ProcessInfo): string {
  const cpu = '0.0';
  const mem = ((p.rss / 4_000_000) * 100).toFixed(1);
  return [
    p.user.padEnd(8),
    String(p.pid).padStart(5),
    cpu.padStart(4),
    mem.padStart(4),
    String(p.vsize).padStart(7),
    String(p.rss).padStart(6),
    p.tty.padEnd(8),
    `${p.state}s`.padEnd(4),
    formatStartTime(p.startTime).padStart(5),
    formatCpuTime(p.cpuTime).padStart(6),
    p.command,
  ].join(' ');
}

/** Render the short SysV-style "ps" line. */
function renderShortLine(p: ProcessInfo): string {
  return [
    String(p.pid).padStart(5),
    p.tty.padEnd(8),
    formatCpuTime(p.cpuTime).padStart(8),
    p.comm,
  ].join(' ');
}

export function cmdPs(args: string[], ctx: ProcessCmdContext): string {
  // Argument parsing — accept both BSD (no dash) and POSIX styles.
  const joined = args.join(' ');
  const isAux = /\b(aux|axu)\b/.test(joined) || args.includes('-aux');
  const isEf = args.includes('-ef') || (args.includes('-e') && args.includes('-f'));
  const isE = args.includes('-e') || args.includes('-A');
  const longFormat = isAux || isEf;

  let processes = ctx.pm.list();

  // Without -e/-A/aux, ps shows only the calling user's processes on this tty.
  if (!isE && !isAux && !isEf) {
    processes = processes.filter(
      p => p.user === ctx.currentUser && (p.tty === ctx.tty || p.tty === '?'),
    );
  }

  const lines: string[] = [];
  if (longFormat) {
    lines.push('USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND');
    for (const p of processes) lines.push(renderAuxLine(p));
  } else {
    lines.push('  PID TTY          TIME CMD');
    for (const p of processes) lines.push(renderShortLine(p));
  }
  return lines.join('\n');
}

// ─── top ──────────────────────────────────────────────────────────────

export function cmdTop(args: string[], ctx: ProcessCmdContext): string {
  // We always print one snapshot — the simulator has no interactive top.
  const procs = ctx.pm.list();
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false });
  const totalMem = 3981;
  const usedMem = 1258;
  const freeMem = 1468;
  const bufCache = 1254;

  const sleeping = procs.filter(p => p.state === 'S').length;
  const running = procs.filter(p => p.state === 'R').length;
  const stopped = procs.filter(p => p.state === 'T').length;
  const zombie = procs.filter(p => p.state === 'Z').length;

  const lines: string[] = [];
  lines.push(`top - ${timeStr} up  0:05,  1 user,  load average: 0.08, 0.03, 0.01`);
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
    const mem = ((p.rss / 4_000_000) * 100).toFixed(1);
    lines.push(
      [
        String(p.pid).padStart(7),
        p.user.padEnd(9),
        String(p.priority).padStart(3),
        String(p.nice).padStart(4),
        `${Math.floor(p.vsize / 1024)}M`.padStart(7),
        `${Math.floor(p.rss / 1024)}M`.padStart(6),
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

  const errors: string[] = [];
  let exitCode = 0;
  for (const pidStr of pidArgs) {
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) {
      errors.push(`kill: ${pidStr}: arguments must be process or job IDs`);
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

export function cmdSystemctl(args: string[], sm: LinuxServiceManager): SysCtlResult {
  const sub = (args[0] || '').toLowerCase();
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
      const showFailed = args.includes('--failed');
      const allUnits = showFailed ? sm.list({ state: 'failed' }) : sm.list();
      const lines = ['  UNIT                          LOAD   ACTIVE SUB     DESCRIPTION'];
      for (const u of allUnits) {
        const active = u.state === 'active' ? 'active' : u.state === 'failed' ? 'failed' : 'inactive';
        const sub2 = u.state === 'active' ? 'running' : 'dead';
        lines.push(
          `  ${(u.name + '.service').padEnd(30)} loaded ${active.padEnd(8)} ${sub2.padEnd(8)} ${u.description}`,
        );
      }
      lines.push('');
      lines.push(`${allUnits.length} loaded units listed.`);
      return { output: lines.join('\n'), exitCode: 0 };
    }

    case 'daemon-reload':
      sm.daemonReload();
      return { output: '', exitCode: 0 };

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
