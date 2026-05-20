/**
 * LinuxLastlogRegistry — per-machine record of "last successful login" per
 * user, mirroring what `/var/log/lastlog` (binary) backs on real Linux
 * (consumed by pam_lastlog.so on OpenSSH authentication).
 *
 * Semantics:
 *   - Each successful interactive login (local console, SSH, sftp) records
 *     `{ when, sourceHost, tty }`. The registry only retains the MOST
 *     RECENT entry per user — exactly like the binary lastlog file (which
 *     keeps one fixed-size struct per UID).
 *   - On a new login, the *previous* entry is what gets surfaced as
 *     "Last login: …". Before the first login, no line is emitted —
 *     matches OpenSSH semantics.
 *   - The registry honours `~/.hushlogin`: when the user's home contains a
 *     `.hushlogin` file, no banner / lastlog line is shown for that user.
 *
 * The class is data-only and event-bus-free: only the SSH server (and
 * future console-login flows) write to it, and only the SSH client reads.
 */

export interface LastlogEntry {
  /** UNIX timestamp in milliseconds. */
  readonly when: number;
  /** Source hostname or IP that initiated the login. */
  readonly sourceHost: string;
  /** pty/console identifier (e.g. "pts/0", "tty1"). */
  readonly tty: string;
}

interface UserLastlog {
  current?: LastlogEntry;
  previous?: LastlogEntry;
}

export class LinuxLastlogRegistry {
  /**
   * username → { current, previous }. We retain the second-most-recent
   * entry on purpose: OpenSSH displays it as the post-login banner. Without
   * the rotation we'd display the CURRENT login (just registered) instead
   * of the actual previous one — factually wrong.
   */
  private readonly entries: Map<string, UserLastlog> = new Map();

  /**
   * Record a successful login for `user`. Atomically rotates:
   *   previous ← current ;  current ← new
   * Returns the entry that USED TO BE current and is now `previous` —
   * useful for callers wanting to surface a "Last login: …" line on the
   * very same call. Returns undefined on the user's first login.
   */
  record(user: string, sourceHost: string, tty: string): LastlogEntry | undefined {
    const slot = this.entries.get(user) ?? {};
    const newEntry: LastlogEntry = { when: Date.now(), sourceHost, tty };
    const becamePrevious = slot.current;
    slot.previous = becamePrevious;
    slot.current = newEntry;
    this.entries.set(user, slot);
    return becamePrevious;
  }

  /** Read the entry to display on next login (the "previous" slot). */
  getPrevious(user: string): LastlogEntry | undefined {
    return this.entries.get(user)?.previous;
  }

  /** Read the current (most recent) entry. Mostly useful for tests / who(1). */
  getCurrent(user: string): LastlogEntry | undefined {
    return this.entries.get(user)?.current;
  }

  /** Reset the registry (test utility). */
  reset(): void {
    this.entries.clear();
  }

  /**
   * Format an entry as the canonical OpenSSH "Last login: …" line.
   * Example: `Last login: Tue Jan 23 12:34:56 2024 from 10.0.0.1`
   */
  static format(entry: LastlogEntry): string {
    const d = new Date(entry.when);
    // OpenSSH/PAM uses ctime(3) format: "Tue Jan 23 12:34:56 2024".
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n: number) => String(n).padStart(2, '0');
    const ctime =
      `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ` +
      `${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:` +
      `${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ` +
      `${d.getUTCFullYear()}`;
    return `Last login: ${ctime} from ${entry.sourceHost}`;
  }
}
