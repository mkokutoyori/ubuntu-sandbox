/**
 * ShellContext — the per-shell execution state a real shell process
 * carries with it.
 *
 * On a real Linux box, this is the per-process state the kernel hangs
 * off the `task_struct`: cwd, environment, real/effective uid/gid, file
 * descriptors, the controlling tty, command history, the umask, the
 * resource limits. The simulator does not model all of these yet, but
 * the class exposes them so that future enhancements (job control with
 * tty signals, `ulimit`, fine-grained credential changes, COW environs
 * across `fork`) can simply read & mutate the fields that are already
 * here — no surprise refactors when we eventually wire them.
 *
 * On Windows the analogues are different on paper (per-drive cwds,
 * env-vars in the PEB block, no umask) but the *shape* of the state a
 * shell carries is the same; this class is OS-neutral.
 *
 * Design pattern: **State holder** — pure data + small invariants. No
 * dispatch here; dispatch lives in the Shell that owns the context.
 */

export interface ShellCredentials {
  readonly user: string;
  readonly uid: number;
  readonly gid: number;
  /** Supplementary group IDs the user belongs to (POSIX). */
  readonly groups: readonly number[];
  /** Effective uid — differs from `uid` after `seteuid`/`su -p`. */
  readonly euid: number;
  /** Effective gid — differs from `gid` after `setegid`. */
  readonly egid: number;
  /** Login name as recorded by `getlogin(3)` (immutable across `su`). */
  readonly loginUser: string;
}

/**
 * One frame of the su-stack — pushed when the user types `su <other>`
 * inside this shell, popped on `exit`. The simulator's existing
 * LinuxShellSession.suStack uses the same shape, so the new shell
 * abstraction stays interoperable with that legacy field.
 */
export interface SuFrame {
  readonly user: string;
  readonly uid: number;
  readonly gid: number;
  readonly cwd: string;
  readonly umask: number;
}

export class ShellContext {
  /** Working directory at the next prompt. */
  cwd: string;
  /** Process-style environment variables. */
  readonly env: Map<string, string>;
  /** Login + effective credentials. Mutable to support `su` / `seteuid`. */
  credentials: ShellCredentials;
  /** Bash-style history ring — bounded by `historyLimit`. */
  readonly history: string[] = [];
  /** Max history entries kept (HISTSIZE on Linux). */
  historyLimit: number = 1000;
  /** POSIX file-creation mask. */
  umask: number = 0o022;
  /** su frames — top of stack is the deepest `su` shell. */
  readonly suStack: SuFrame[] = [];
  /** Per-drive cwd map used by Windows shells (`A:` `B:` `C:` …). */
  readonly driveCwd: Map<string, string> = new Map();
  /** The terminal's TTY name (e.g. `pts/0`) — used by `tty`, `who`, `w`. */
  tty: string;

  constructor(
    public readonly hostname: string,
    creds: ShellCredentials,
    cwd: string,
    initialEnv: Record<string, string> = {},
    tty: string = 'pts/0',
  ) {
    this.credentials = creds;
    this.cwd = cwd;
    this.env = new Map(Object.entries(initialEnv));
    this.tty = tty;
  }

  /** Push one line onto the history, trimming the ring when full. */
  pushHistory(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (this.history[this.history.length - 1] === trimmed) return;
    this.history.push(trimmed);
    while (this.history.length > this.historyLimit) this.history.shift();
  }

  /** Whether this shell is currently inside one or more `su` frames. */
  get insideSu(): boolean { return this.suStack.length > 0; }

  /** A fresh `ShellCredentials` for the standard root identity. */
  static rootCredentials(loginUser: string = 'root'): ShellCredentials {
    return {
      user: 'root', uid: 0, gid: 0, groups: [0],
      euid: 0, egid: 0, loginUser,
    };
  }

  /** A fresh `ShellCredentials` for an unprivileged user. */
  static userCredentials(user: string, uid: number = 1000, gid: number = 1000): ShellCredentials {
    return {
      user, uid, gid, groups: [gid],
      euid: uid, egid: gid, loginUser: user,
    };
  }
}
