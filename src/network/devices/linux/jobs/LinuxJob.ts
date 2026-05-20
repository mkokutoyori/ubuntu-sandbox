/**
 * LinuxJob — a bash background job entity.
 *
 * The job table used to store plain `{id, pid, command, state}` records;
 * this class makes a job a first-class object with all attributes a
 * real bash job-control state would carry, even ones the simulator does
 * not yet consume — exit status, suspended-on signal, foreground/back-
 * ground flag, controlling terminal, environment snapshot, file
 * descriptors, etc. Future features hook in without breaking the
 * existing job-table API.
 *
 * Behaviour is limited to state queries + transitions. The {@link
 * LinuxJobTable} remains the aggregate root that publishes events;
 * the entity must never emit on its own.
 */

export type JobState =
  | 'Running'
  | 'Stopped'   // user sent SIGSTOP / SIGTSTP
  | 'Done'      // exited successfully
  | 'Exit'      // exited with non-zero status
  | 'Killed'    // terminated by a signal
  | 'Continued'; // briefly after SIGCONT

export type JobMode = 'foreground' | 'background';

export interface LinuxJobInit {
  id: number;
  pid: number;
  command: string;
  // Optional with sensible defaults:
  state?: JobState;
  mode?: JobMode;
  pgid?: number;
  startTime?: Date;
  controllingTty?: string;
  user?: string;
  cwd?: string;
  /** Environment captured at job creation (for reuse on fg/bg). */
  environSnapshot?: Record<string, string>;
  /** Whether this job is detached from the shell (nohup / disown -h). */
  nohup?: boolean;
}

export class LinuxJob {
  // ─── identity ───────────────────────────────────────────────────────
  id: number;
  pid: number;
  pgid: number;
  command: string;

  // ─── lifecycle ─────────────────────────────────────────────────────
  state: JobState;
  mode: JobMode;
  startTime: Date;
  endTime?: Date;
  /** Numeric exit status (0–255 for normal exits, set on Done/Exit). */
  exitCode?: number;
  /** Signal that suspended (`Stopped`) or terminated (`Killed`) the job. */
  signal?: string;

  // ─── controlling terminal / session ────────────────────────────────
  controllingTty: string;
  user: string;
  cwd: string;
  environSnapshot: Record<string, string>;

  // ─── detachment / disposition ──────────────────────────────────────
  /** nohup or `disown -h`: HUP is masked, parent reparents to init. */
  nohup: boolean;
  /** True after a `disown`, so SIGHUP from shell exit doesn't reach it. */
  disowned = false;
  /** Notified flag (bash `jobs -n` semantics — print only changed jobs). */
  notified = false;

  // ─── stats (filled in by the orchestrator if desired) ──────────────
  cpuTimeMs = 0;
  wallTimeMs = 0;

  constructor(init: LinuxJobInit) {
    this.id = init.id;
    this.pid = init.pid;
    this.pgid = init.pgid ?? init.pid;
    this.command = init.command;
    this.state = init.state ?? 'Running';
    this.mode = init.mode ?? 'background';
    this.startTime = init.startTime ?? new Date();
    this.controllingTty = init.controllingTty ?? 'pts/0';
    this.user = init.user ?? 'user';
    this.cwd = init.cwd ?? '/';
    this.environSnapshot = init.environSnapshot ?? {};
    this.nohup = init.nohup ?? false;
  }

  // ─── queries ───────────────────────────────────────────────────────

  isRunning(): boolean { return this.state === 'Running' || this.state === 'Continued'; }
  isStopped(): boolean { return this.state === 'Stopped'; }
  isFinished(): boolean {
    return this.state === 'Done' || this.state === 'Exit' || this.state === 'Killed';
  }
  isBackground(): boolean { return this.mode === 'background'; }

  /** Bash terminology: a job is "current" elsewhere; here we expose what we know. */
  describe(): string {
    return `[${this.id}] ${this.state.padEnd(22)}${this.command}`;
  }

  // ─── mutations ─────────────────────────────────────────────────────

  toForeground(): void { this.mode = 'foreground'; }
  toBackground(): void { this.mode = 'background'; }

  suspend(signal: string = 'SIGSTOP'): void {
    this.state = 'Stopped';
    this.signal = signal;
  }

  resume(): void {
    if (this.state === 'Stopped') {
      this.state = 'Continued';
      this.signal = undefined;
    }
  }

  /** Mark this job as completed by signal or exit. */
  complete(opts: { exitCode?: number; signal?: string }): void {
    this.endTime = new Date();
    if (opts.signal) {
      this.state = 'Killed';
      this.signal = opts.signal;
    } else if (opts.exitCode === 0 || opts.exitCode === undefined) {
      this.state = 'Done';
      this.exitCode = 0;
    } else {
      this.state = 'Exit';
      this.exitCode = opts.exitCode;
    }
  }

  /** Detach from the shell: no SIGHUP on shell exit, reparent to init. */
  disown(keepRunning = true): void {
    this.disowned = true;
    if (keepRunning) this.nohup = true;
  }

  /** Plain-object snapshot — no methods, JSON-safe. */
  snapshot(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this)) {
      if (typeof v === 'function') continue;
      out[k] = v;
    }
    return out;
  }
}
