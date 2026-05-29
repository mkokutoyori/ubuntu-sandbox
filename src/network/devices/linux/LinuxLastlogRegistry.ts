/**
 * LinuxLastlogRegistry — per-machine record of "last successful login" per
 * user, mirroring what `/var/log/lastlog` backs on real Linux (consumed by
 * pam_lastlog.so on authentication and rendered by lastlog(8)).
 *
 * Semantics:
 *   - Each successful interactive login (local console, SSH, sftp) records
 *     `{ when, sourceHost, tty }`. The registry retains the MOST RECENT
 *     entry per user — exactly like the fixed-size struct lastlog keeps
 *     per UID — and the previous one (for the "Last login: …" banner).
 *   - When a {@link VirtualFileSystem} is attached, the registry is the
 *     single source of truth for `/var/log/lastlog`: every mutation is
 *     projected to that file (seeded 0644 root:root) so the filesystem
 *     layer stays coherent with the in-memory view, and a fresh registry
 *     re-hydrates from the file on attach.
 */

import type { VirtualFileSystem } from './VirtualFileSystem';

/** Canonical path lastlog(8) reads on a real system. */
export const LASTLOG_PATH = '/var/log/lastlog';
const LOG_DIR = '/var/log';

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

interface PersistedRow {
  user: string;
  when: number;
  sourceHost: string;
  tty: string;
}

export class LinuxLastlogRegistry {
  private readonly entries: Map<string, UserLastlog> = new Map();
  private vfs: VirtualFileSystem | null = null;

  /**
   * Bind a VFS so `/var/log/lastlog` becomes the persistent projection of
   * this registry. Re-hydrates from an existing file, or seeds an empty
   * one (0644 root:root) when absent. Idempotent.
   */
  attachVfs(vfs: VirtualFileSystem): void {
    this.vfs = vfs;
    if (vfs.exists(LASTLOG_PATH)) this.load();
    else this.persist();
  }

  /**
   * Record a successful login for `user`. Atomically rotates
   * previous ← current ; current ← new, and projects to disk.
   * Returns the entry that became `previous` (undefined on first login).
   */
  record(user: string, sourceHost: string, tty: string, when: number = Date.now()): LastlogEntry | undefined {
    const slot = this.entries.get(user) ?? {};
    const newEntry: LastlogEntry = { when, sourceHost, tty };
    const becamePrevious = slot.current;
    slot.previous = becamePrevious;
    slot.current = newEntry;
    this.entries.set(user, slot);
    this.persist();
    return becamePrevious;
  }

  /** Read the entry to display on next login (the "previous" slot). */
  getPrevious(user: string): LastlogEntry | undefined {
    return this.entries.get(user)?.previous;
  }

  /** Read the current (most recent) entry. */
  getCurrent(user: string): LastlogEntry | undefined {
    return this.entries.get(user)?.current;
  }

  /** Snapshot every user with a recorded login — drives the `lastlog` command. */
  listCurrent(): ReadonlyMap<string, LastlogEntry> {
    const out = new Map<string, LastlogEntry>();
    for (const [user, slot] of this.entries) {
      if (slot.current) out.set(user, slot.current);
    }
    return out;
  }

  /** Reset the registry (test utility) and clear the projected file. */
  reset(): void {
    this.entries.clear();
    this.persist();
  }

  /** Drop a single user's entry; used by `lastlog -C -u <user>`. */
  clearUser(user: string): void {
    this.entries.delete(user);
    this.persist();
  }

  /** Absolute path of the projected lastlog file. */
  filePath(): string {
    return LASTLOG_PATH;
  }

  // ─── persistence ───────────────────────────────────────────────────

  private load(): void {
    if (!this.vfs) return;
    const raw = this.vfs.readFile(LASTLOG_PATH);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      for (const r of parsed as PersistedRow[]) {
        if (!r || typeof r.user !== 'string') continue;
        this.entries.set(r.user, {
          current: { when: r.when, sourceHost: r.sourceHost, tty: r.tty },
        });
      }
    } catch {
      /* corrupt file → keep in-memory view, matches util-linux tolerance */
    }
  }

  private persist(): void {
    if (!this.vfs) return;
    if (!this.vfs.exists(LOG_DIR)) this.vfs.mkdirp(LOG_DIR, 0o755, 0, 0);
    const rows: PersistedRow[] = [];
    for (const [user, slot] of this.entries) {
      if (slot.current) {
        rows.push({ user, when: slot.current.when, sourceHost: slot.current.sourceHost, tty: slot.current.tty });
      }
    }
    this.vfs.writeFile(LASTLOG_PATH, JSON.stringify(rows), 0, 0, 0o022);
  }

  /**
   * Format an entry as the canonical OpenSSH "Last login: …" line.
   * Example: `Last login: Tue Jan 23 12:34:56 2024 from 10.0.0.1`
   */
  static format(entry: LastlogEntry): string {
    const d = new Date(entry.when);
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
