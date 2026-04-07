/**
 * LinuxProcessManager — Realistic process table for the Linux sandbox.
 *
 * Models a Linux process table with PIDs, parent/child relationships,
 * states, signals, and per-process metadata. Backs the ps/top/kill/pgrep
 * commands and lets the service manager track daemon PIDs.
 *
 * Not a real scheduler — processes do not consume CPU time on their own.
 * State transitions are driven by explicit calls (spawn, kill, setState).
 */

/** Linux process states as reported by ps. */
export type ProcessState =
  | 'R' // Running
  | 'S' // Sleeping (interruptible)
  | 'D' // Uninterruptible sleep (disk wait)
  | 'Z' // Zombie
  | 'T' // Stopped (by signal)
  | 'I'; // Idle kernel thread

/** Standard POSIX signals supported by the simulator. */
export type Signal =
  | 'SIGHUP'
  | 'SIGINT'
  | 'SIGQUIT'
  | 'SIGKILL'
  | 'SIGTERM'
  | 'SIGSTOP'
  | 'SIGCONT'
  | 'SIGUSR1'
  | 'SIGUSR2'
  | 'SIGPIPE'
  | 'SIGALRM'
  | 'SIGCHLD';

/** Map signal name → POSIX number, used by `kill -l` style listings. */
export const SIGNAL_NUMBERS: Record<Signal, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
  SIGSTOP: 19,
  SIGCONT: 18,
  SIGUSR1: 10,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGCHLD: 17,
};

/** Snapshot of a single process in the simulated table. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  uid: number;
  gid: number;
  user: string;
  /** Full command line as it would appear in /proc/<pid>/cmdline. */
  command: string;
  /** Short command name (basename of argv[0]), as in /proc/<pid>/comm. */
  comm: string;
  args: string[];
  state: ProcessState;
  startTime: Date;
  /** CPU time consumed in milliseconds. */
  cpuTime: number;
  /** Virtual memory size in KB. */
  vsize: number;
  /** Resident set size in KB. */
  rss: number;
  tty: string;
  nice: number;
  priority: number;
  cwd: string;
  exe: string;
  /** Service unit that owns this process, if any. */
  serviceName?: string;
}

/** Options for spawning a new process. */
export interface SpawnOptions {
  /** Full command line, e.g. "/usr/sbin/sshd -D". */
  command: string;
  user: string;
  uid: number;
  gid: number;
  ppid?: number;
  tty?: string;
  cwd?: string;
  nice?: number;
  /** Override comm; default is basename of argv[0]. */
  comm?: string;
  /** Service unit name (if spawned by systemd). */
  serviceName?: string;
  /** Initial virtual memory in KB. */
  vsize?: number;
  /** Initial resident memory in KB. */
  rss?: number;
}

/** Filter criteria for `list()`. */
export interface ProcessFilter {
  user?: string;
  uid?: number;
  ppid?: number;
  state?: ProcessState;
  comm?: string;
  serviceName?: string;
}

/** PID 1 — init/systemd is special and cannot be killed. */
const INIT_PID = 1;

/** Linux PID_MAX_DEFAULT (32768) — wraparound boundary for PID allocation. */
const PID_MAX = 32768;

export class LinuxProcessManager {
  private processes = new Map<number, ProcessInfo>();
  private nextPid = 2;

  constructor() {
    this.bootstrapInit();
  }

  /** Reset to initial state (only PID 1 running). Used by tests / reboot. */
  reset(): void {
    this.processes.clear();
    this.nextPid = 2;
    this.bootstrapInit();
  }

  /** Spawn a new process and return its info. */
  spawn(opts: SpawnOptions): ProcessInfo {
    const pid = this.allocPid();
    const tokens = tokenize(opts.command);
    const argv0 = tokens[0] || opts.command;
    const comm = opts.comm ?? basename(argv0);
    const args = tokens.slice(1);
    const ppid = opts.ppid ?? INIT_PID;
    const parent = this.processes.get(ppid);

    const proc: ProcessInfo = {
      pid,
      ppid,
      pgid: parent?.pgid ?? pid,
      sid: parent?.sid ?? pid,
      uid: opts.uid,
      gid: opts.gid,
      user: opts.user,
      command: opts.command,
      comm,
      args,
      state: 'S',
      startTime: new Date(),
      cpuTime: 0,
      vsize: opts.vsize ?? 10240,
      rss: opts.rss ?? 4096,
      tty: opts.tty ?? '?',
      nice: opts.nice ?? 0,
      priority: 20 + (opts.nice ?? 0),
      cwd: opts.cwd ?? '/',
      exe: argv0,
      serviceName: opts.serviceName,
    };
    this.processes.set(pid, proc);
    return proc;
  }

  /** Look up a process by PID. */
  get(pid: number): ProcessInfo | undefined {
    return this.processes.get(pid);
  }

  /** List processes matching the filter (default: all). */
  list(filter: ProcessFilter = {}): ProcessInfo[] {
    const out: ProcessInfo[] = [];
    for (const p of this.processes.values()) {
      if (filter.user !== undefined && p.user !== filter.user) continue;
      if (filter.uid !== undefined && p.uid !== filter.uid) continue;
      if (filter.ppid !== undefined && p.ppid !== filter.ppid) continue;
      if (filter.state !== undefined && p.state !== filter.state) continue;
      if (filter.comm !== undefined && p.comm !== filter.comm) continue;
      if (filter.serviceName !== undefined && p.serviceName !== filter.serviceName) continue;
      out.push(p);
    }
    return out.sort((a, b) => a.pid - b.pid);
  }

  /** Manually transition a process to a new state. */
  setState(pid: number, state: ProcessState): boolean {
    const p = this.processes.get(pid);
    if (!p) return false;
    p.state = state;
    return true;
  }

  /**
   * Send a signal to a process. Returns true on success.
   *
   * Termination signals (TERM, KILL, INT, QUIT, HUP) remove the process.
   * STOP transitions to T; CONT resumes to S. PID 1 is protected.
   */
  kill(pid: number, signal: Signal): boolean {
    const p = this.processes.get(pid);
    if (!p) return false;
    if (pid === INIT_PID) return false;

    switch (signal) {
      case 'SIGSTOP':
        p.state = 'T';
        return true;
      case 'SIGCONT':
        if (p.state === 'T') p.state = 'S';
        return true;
      case 'SIGCHLD':
      case 'SIGUSR1':
      case 'SIGUSR2':
      case 'SIGALRM':
      case 'SIGPIPE':
        // Default disposition for these is ignore or core, but our simulator
        // simply delivers them and lets the process keep running.
        return true;
      case 'SIGHUP':
      case 'SIGINT':
      case 'SIGQUIT':
      case 'SIGTERM':
      case 'SIGKILL':
        this.terminate(pid);
        return true;
    }
  }

  /** Reap a zombie process (remove from table). Returns true on success. */
  reap(pid: number): boolean {
    const p = this.processes.get(pid);
    if (!p || p.state !== 'Z') return false;
    this.processes.delete(pid);
    return true;
  }

  /** Return PIDs of all processes whose comm matches `name` exactly. */
  pidof(name: string): number[] {
    const out: number[] = [];
    for (const p of this.processes.values()) {
      if (p.comm === name) out.push(p.pid);
    }
    return out;
  }

  /** Return PIDs of processes whose comm contains `pattern`. */
  pgrep(pattern: string): number[] {
    const out: number[] = [];
    for (const p of this.processes.values()) {
      if (p.comm.includes(pattern) || p.command.includes(pattern)) out.push(p.pid);
    }
    return out;
  }

  /** Send `signal` to all processes whose comm contains `pattern`.
   *  Returns the number of processes signalled. */
  pkill(pattern: string, signal: Signal = 'SIGTERM'): number {
    const pids = this.pgrep(pattern);
    let count = 0;
    for (const pid of pids) {
      if (this.kill(pid, signal)) count++;
    }
    return count;
  }

  // ─── private helpers ────────────────────────────────────────────────

  private bootstrapInit(): void {
    const init: ProcessInfo = {
      pid: INIT_PID,
      ppid: 0,
      pgid: 1,
      sid: 1,
      uid: 0,
      gid: 0,
      user: 'root',
      command: '/sbin/init',
      comm: 'systemd',
      args: [],
      state: 'S',
      startTime: new Date(),
      cpuTime: 0,
      vsize: 169000,
      rss: 13000,
      tty: '?',
      nice: 0,
      priority: 20,
      cwd: '/',
      exe: '/lib/systemd/systemd',
    };
    this.processes.set(INIT_PID, init);
  }

  /** Allocate the next free PID, wrapping at PID_MAX. */
  private allocPid(): number {
    const start = this.nextPid;
    let candidate = start;
    do {
      if (!this.processes.has(candidate)) {
        this.nextPid = candidate + 1 > PID_MAX ? 2 : candidate + 1;
        return candidate;
      }
      candidate++;
      if (candidate > PID_MAX) candidate = 2;
    } while (candidate !== start);
    throw new Error('No free PIDs available');
  }

  /** Terminate a process and reparent its children to init. */
  private terminate(pid: number): void {
    // Reparent children to PID 1 before removing.
    for (const child of this.processes.values()) {
      if (child.ppid === pid) child.ppid = INIT_PID;
    }
    this.processes.delete(pid);
  }
}

// ─── tokenization helpers ─────────────────────────────────────────────

/** Split a command line into tokens, honoring single and double quotes. */
function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/** Return the basename of a file path. */
function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}
