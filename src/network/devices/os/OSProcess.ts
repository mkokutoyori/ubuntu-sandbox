/**
 * OSProcess — OS-agnostic rich process record.
 *
 * Linux/Windows/Mac process models extend this class. It carries every
 * attribute a real OS would expose for a process (procfs / Task Manager
 * equivalents), even ones the current simulator does not yet consume —
 * future features (cgroups, namespaces, file descriptors, I/O counters)
 * can hook in without touching every call site.
 *
 * Behavior on this base class is deliberately limited to manipulations
 * that make sense for any OS: state checks, niceness, fd table, and a
 * plain-object snapshot. OS-specific quirks (procfs paths, Windows
 * handle counts, security descriptors) belong in subclasses.
 */

export type ProcessState =
  | 'R'  // running
  | 'S'  // sleeping (interruptible)
  | 'D'  // uninterruptible sleep (disk)
  | 'T'  // stopped
  | 'Z'  // zombie
  | 'X'  // dead
  | 'I'; // idle kernel thread

export type FileMode = 'r' | 'w' | 'rw' | 'a';

/** A real OS file descriptor on a process. */
export interface OSFileHandle {
  fd: number;
  path: string;
  mode: FileMode;
  offset: number;
  /** Inode-like identity; OS adapters fill this in. */
  inodeId?: string;
}

/** A real socket endpoint owned by a process. */
export interface OSSocketHandle {
  fd: number;
  family: 'AF_INET' | 'AF_INET6' | 'AF_UNIX';
  type: 'SOCK_STREAM' | 'SOCK_DGRAM' | 'SOCK_RAW';
  localAddr?: string;
  localPort?: number;
  remoteAddr?: string;
  remotePort?: number;
  state?: 'LISTEN' | 'ESTABLISHED' | 'CLOSE_WAIT' | 'TIME_WAIT';
}

/** Per-resource rlimit pair (soft, hard). */
export interface Rlimit { soft: number; hard: number }

/** Minimal init payload — only what's intrinsically required. */
export interface OSProcessInit {
  pid: number;
  ppid: number;
  uid: number;
  gid: number;
  user: string;
  command: string;
  comm: string;
  args: string[];
  exe: string;
  // Optional overrides for any field that has a sensible default.
  pgid?: number;
  sid?: number;
  state?: ProcessState;
  startTime?: Date;
  cwd?: string;
  tty?: string;
  nice?: number;
  vsize?: number;
  rss?: number;
  numThreads?: number;
  environ?: Record<string, string>;
  serviceName?: string;
  schedPolicy?: string;
  rtPriority?: number;
  ioClass?: string;
  ioClassData?: number;
  cpuAffinity?: number[];
  euid?: number;
  egid?: number;
  suid?: number;
  sgid?: number;
}

/**
 * Default rlimits matching a typical Ubuntu desktop / server. Values are
 * deliberately the real kernel defaults so scripts that parse them keep
 * working.
 */
export const DEFAULT_RLIMITS: Readonly<Record<string, Rlimit>> = Object.freeze({
  AS:         { soft: -1, hard: -1 },        // address space (unlimited)
  CORE:       { soft: 0, hard: -1 },         // core file size
  CPU:        { soft: -1, hard: -1 },        // cpu time
  DATA:       { soft: -1, hard: -1 },        // data segment
  FSIZE:      { soft: -1, hard: -1 },        // file size
  LOCKS:      { soft: -1, hard: -1 },        // file locks
  MEMLOCK:    { soft: 67_108_864, hard: 67_108_864 },
  MSGQUEUE:   { soft: 819_200, hard: 819_200 },
  NICE:       { soft: 0, hard: 0 },
  NOFILE:     { soft: 1024, hard: 1_048_576 },
  NPROC:      { soft: 31_886, hard: 31_886 },
  RSS:        { soft: -1, hard: -1 },
  RTPRIO:     { soft: 0, hard: 0 },
  RTTIME:     { soft: -1, hard: -1 },
  SIGPENDING: { soft: 31_886, hard: 31_886 },
  STACK:      { soft: 8_388_608, hard: -1 },
});

export class OSProcess {
  // ─── identity ───────────────────────────────────────────────────────
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  /** Terminal process group (for foreground job detection). */
  tpgid = -1;

  // ─── credentials ───────────────────────────────────────────────────
  uid: number;
  gid: number;
  /** Effective / saved / fs IDs — Linux. Windows mirrors uid/gid. */
  euid: number;
  egid: number;
  suid: number;
  sgid: number;
  fsuid: number;
  fsgid: number;
  user: string;
  supplementaryGroups: number[] = [];

  // ─── command / image ───────────────────────────────────────────────
  command: string;
  comm: string;
  args: string[];
  exe: string;
  cwd: string;
  root = '/';
  environ: Record<string, string>;

  // ─── runtime state ─────────────────────────────────────────────────
  state: ProcessState;
  startTime: Date;
  cpuTime = 0;
  /** user-mode jiffies (utime). */
  utime = 0;
  /** kernel-mode jiffies (stime). */
  stime = 0;
  wchan = '0';
  numThreads: number;
  exitCode?: number;
  exitSignal?: string;

  // ─── memory ────────────────────────────────────────────────────────
  vsize: number;
  rss: number;
  shrss = 0;
  rsslim = -1;
  tty: string;

  // ─── scheduling ────────────────────────────────────────────────────
  nice: number;
  priority: number;
  schedPolicy: string;
  rtPriority: number;
  ioClass: string;
  ioClassData: number;
  cpuAffinity: number[];

  // ─── isolation / limits ────────────────────────────────────────────
  rlimits: Record<string, Rlimit>;
  oomScore = 0;
  oomScoreAdj = 0;
  /** cgroup path (Linux); not used on Windows. */
  cgroup = '/';
  /** Namespace identity (pid/net/mnt/uts/ipc/user). */
  namespaces: Record<string, string> = {
    pid: 'pid:[4026531836]', net: 'net:[4026531992]', mnt: 'mnt:[4026531840]',
    uts: 'uts:[4026531838]', ipc: 'ipc:[4026531839]', user: 'user:[4026531837]',
  };

  // ─── I/O counters ──────────────────────────────────────────────────
  ioRead = 0;
  ioWrite = 0;
  ioReadBytes = 0;
  ioWriteBytes = 0;

  // ─── file descriptors / sockets ────────────────────────────────────
  openFiles: OSFileHandle[];
  sockets: OSSocketHandle[] = [];
  private nextFd = 3;  // 0/1/2 reserved for stdin/stdout/stderr

  // ─── service / session linkage ─────────────────────────────────────
  serviceName?: string;
  sessionId?: string;

  constructor(init: OSProcessInit) {
    this.pid = init.pid;
    this.ppid = init.ppid;
    this.pgid = init.pgid ?? init.pid;
    this.sid = init.sid ?? init.pid;
    this.uid = init.uid;
    this.gid = init.gid;
    this.euid = init.euid ?? init.uid;
    this.egid = init.egid ?? init.gid;
    this.suid = init.suid ?? init.uid;
    this.sgid = init.sgid ?? init.gid;
    this.fsuid = init.uid;
    this.fsgid = init.gid;
    this.user = init.user;
    this.command = init.command;
    this.comm = init.comm;
    this.args = init.args;
    this.exe = init.exe;
    this.cwd = init.cwd ?? '/';
    this.environ = init.environ ?? {};
    this.state = init.state ?? 'S';
    this.startTime = init.startTime ?? new Date();
    this.numThreads = init.numThreads ?? 1;
    this.vsize = init.vsize ?? 10240;
    this.rss = init.rss ?? 4096;
    this.tty = init.tty ?? '?';
    this.nice = init.nice ?? 0;
    this.priority = 20 + this.nice;
    this.schedPolicy = init.schedPolicy ?? 'SCHED_OTHER';
    this.rtPriority = init.rtPriority ?? 0;
    this.ioClass = init.ioClass ?? 'best-effort';
    this.ioClassData = init.ioClassData ?? 4;
    this.cpuAffinity = init.cpuAffinity ?? [0];
    this.rlimits = { ...DEFAULT_RLIMITS };
    this.openFiles = [];
    this.serviceName = init.serviceName;
  }

  // ─── queries ───────────────────────────────────────────────────────

  /** Alive = not zombie / not dead. */
  isAlive(): boolean {
    return this.state !== 'Z' && this.state !== 'X';
  }

  /** Exact comm match (use {@link matchesPattern} for substring). */
  matches(comm: string): boolean {
    return this.comm === comm;
  }

  matchesPattern(pattern: string): boolean {
    return this.comm.includes(pattern) || this.command.includes(pattern);
  }

  ownedBy(uid: number): boolean { return this.uid === uid; }

  /** Whether this process is part of a service (matches mainPid linkage). */
  isServiceProcess(): boolean { return this.serviceName !== undefined; }

  // ─── mutations ─────────────────────────────────────────────────────

  /** Set nice, derive priority, clamp to the kernel range. */
  applyNice(nice: number): void {
    const clamped = Math.max(-20, Math.min(19, nice));
    this.nice = clamped;
    this.priority = 20 + clamped;
  }

  /** Allocate the next fd and register an open file. */
  addOpenFile(path: string, mode: FileMode): number {
    const fd = this.nextFd++;
    this.openFiles.push({ fd, path, mode, offset: 0 });
    return fd;
  }

  closeOpenFile(fd: number): boolean {
    const before = this.openFiles.length;
    this.openFiles = this.openFiles.filter(f => f.fd !== fd);
    return this.openFiles.length < before;
  }

  /** Register a socket (net/unix). Returns the allocated fd. */
  addSocket(sock: Omit<OSSocketHandle, 'fd'>): number {
    const fd = this.nextFd++;
    this.sockets.push({ ...sock, fd });
    return fd;
  }

  // ─── snapshots ─────────────────────────────────────────────────────

  /** Plain-object copy without methods — safe for telemetry / JSON. */
  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this)) {
      if (typeof v === 'function') continue;
      out[k] = v;
    }
    return out;
  }
}
