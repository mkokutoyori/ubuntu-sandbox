/**
 * LinuxShellSession — One interactive shell (one terminal window).
 *
 * Real Linux: each pty/login spawns a fresh `-bash` process. That process has
 * its own current working directory, its own environment vector, its own
 * `setuid`/`su` stack, its own job table, its own `HISTFILE`. None of these
 * are shared between sessions on the same machine; only the kernel-level
 * filesystem, the user database and the network stack are.
 *
 * Our simulator originally collapsed all of that onto a single
 * `LinuxCommandExecutor`, which leaks state between concurrent terminals on
 * the same device (cf. terminal_gap.md §2). This class re-introduces the
 * missing per-shell state container.
 *
 * The class is **data-only** by design: the executor still owns the heavy
 * machinery (VFS, user manager, bash interpreter). On each command the
 * executor swaps its fields with those of the active session, runs, captures
 * the mutations back and restores its baseline state — see
 * `LinuxCommandExecutor.executeInSession()`.
 */

import { LinuxJobTable } from '../jobs/LinuxJobTable';

export interface SuFrame {
  user: string;
  uid: number;
  gid: number;
  cwd: string;
  umask: number;
}

let nextSessionSeq = 1;

/**
 * Allocator for pseudo-tty slots. Mirrors `openpty(3)` semantics: each
 * allocated slot is unique for the lifetime of the session; on release the
 * slot is returned to the free pool. Per-device singleton.
 */
export class TtyAllocator {
  private allocated = new Set<number>();
  private next = 0;

  allocate(): string {
    // Reuse the lowest free slot, like Linux pty(7).
    let n = 0;
    while (this.allocated.has(n)) n++;
    this.allocated.add(n);
    if (n >= this.next) this.next = n + 1;
    return `pts/${n}`;
  }

  release(tty: string): void {
    const m = /^pts\/(\d+)$/.exec(tty);
    if (!m) return;
    this.allocated.delete(parseInt(m[1], 10));
  }

  reset(): void {
    this.allocated.clear();
    this.next = 0;
  }
}

export interface LinuxShellSessionInit {
  user: string;
  uid: number;
  gid: number;
  cwd: string;
  umask?: number;
  /** Initial environment (copied — the session owns its map). */
  env: Map<string, string>;
  tty: string;
  /** PID of the -bash process for this session (allocated by the device). */
  shellPid: number;
  /** Parent PID — typically sshd's PID when SSH, init (1) for console logins. */
  shellPpid: number;
}

/**
 * Per-terminal shell state. The owning Linux device creates one per terminal
 * via `LinuxMachine.openShellSession()` and reclaims it via
 * `closeShellSession()`.
 *
 * Equipped attributes mirror what a real `-bash` process holds, even when
 * the simulator does not yet exploit all of them — e.g. `lastBgPid`, `ppid`,
 * `comm`, `pgid`. Keeping them here means future enhancements
 * (`$!`, `wait`, process group signalling, `disown`) plug in without
 * reshaping the data model.
 */
export class LinuxShellSession {
  readonly id: string;

  // ── Process identity ────────────────────────────────────────────
  readonly tty: string;
  readonly shellPid: number;
  readonly shellPpid: number;
  readonly comm: string = '-bash';
  /** Process group id — equal to shellPid for a session-leader bash. */
  readonly pgid: number;
  /** Session id — same as pgid for the session leader. */
  readonly sid: number;

  // ── Mutable shell state ─────────────────────────────────────────
  cwd: string;
  user: string;
  uid: number;
  gid: number;
  umask: number;
  env: Map<string, string>;
  suStack: SuFrame[] = [];
  commandHistory: string[] = [];
  lastExitCode: number = 0;
  /** PID of the most recent background job — backs `$!`. */
  lastBgPid: number = 0;
  /** Per-session job control table (real bash has one per shell). */
  readonly jobTable: LinuxJobTable;
  /** When the shell was opened — backs `$SECONDS`. */
  readonly startTime: number = Date.now();
  /** Whether the session has been disposed. */
  disposed: boolean = false;

  constructor(init: LinuxShellSessionInit) {
    this.id = `lshell-${nextSessionSeq++}`;
    this.tty = init.tty;
    this.shellPid = init.shellPid;
    this.shellPpid = init.shellPpid;
    this.pgid = init.shellPid;
    this.sid = init.shellPid;
    this.cwd = init.cwd;
    this.user = init.user;
    this.uid = init.uid;
    this.gid = init.gid;
    this.umask = init.umask ?? 0o022;
    // Defensive copy so the caller cannot mutate the session externally.
    this.env = new Map(init.env);
    this.jobTable = new LinuxJobTable();
  }

  // ── Convenience accessors ───────────────────────────────────────

  /** True iff the session is currently inside a `su` (or `sudo -s`) frame. */
  get isInsideSu(): boolean { return this.suStack.length > 0; }

  /** Top-of-stack user — useful for the prompt or `whoami`. */
  get effectiveUser(): string { return this.user; }

  /** Push a su frame (the executor calls this when handling `su`/`sudo -s`). */
  pushSu(frame: SuFrame): void {
    this.suStack.push(frame);
  }

  /** Pop a su frame (called on `exit` / `logout` inside su). */
  popSu(): SuFrame | undefined {
    return this.suStack.pop();
  }

  /** Append a command to the history. Bounded like bash's HISTSIZE=2000. */
  pushHistory(cmd: string): void {
    if (!cmd) return;
    this.commandHistory.push(cmd);
    if (this.commandHistory.length > 2000) {
      this.commandHistory.splice(0, this.commandHistory.length - 2000);
    }
  }

  /** Mark the session disposed; further executeInSession calls are no-ops. */
  dispose(): void { this.disposed = true; }
}
