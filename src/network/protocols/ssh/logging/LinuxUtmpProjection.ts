/**
 * LinuxUtmpProjection — reactive /var/log/{wtmp,btmp}.json producer.
 *
 * Real Linux keeps a binary `utmp` (currently-logged-in) and `wtmp`
 * (login history) under `/var/log/`, with `btmp` holding failed
 * logins. The simulator already has render-side code that turns a
 * JSON array into `last(1)` / `lastb(1)` output (see
 * LinuxUserManager.renderUtmpLog), but nothing was writing to those
 * files — so `lastb` always returned the synthetic header alone,
 * making brute-force triage impossible.
 *
 * This projection sits next to {@link SshSyslogger}: same event
 * stream, different sink. One JSON row per auth event.
 */

import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type {
  ISshServerEventBus,
  SshServerEvent,
} from '../server/SshServerEvent';

const WTMP_PATH = '/var/log/wtmp.json';
const BTMP_PATH = '/var/log/btmp.json';
const LOG_DIR = '/var/log';

interface WtmpRow {
  user: string;
  ip: string;
  at: number;
  type: 'login';
  tty?: string;
}

interface BtmpRow {
  user: string;
  ip: string;
  at: number;
  type: 'failed';
  reason: string;
  tty?: string;
}

export class LinuxUtmpProjection {
  private readonly unsubscribe: () => void;
  private ptsCounter = 0;

  constructor(
    private readonly vfs: VirtualFileSystem,
    bus: ISshServerEventBus,
  ) {
    this.unsubscribe = bus.on('*', (e) => this.handle(e));
  }

  /** Detach from the event bus — call before discarding the projection. */
  dispose(): void {
    this.unsubscribe();
  }

  // ─── private ───────────────────────────────────────────────────────

  private handle(event: SshServerEvent): void {
    switch (event.kind) {
      case 'auth_success':
        this.append<WtmpRow>(WTMP_PATH, {
          user: event.user,
          ip: event.ip,
          at: event.timestamp ?? Date.now(),
          type: 'login',
          tty: this.allocateTty(),
        });
        return;

      case 'auth_failure':
        this.append<BtmpRow>(BTMP_PATH, {
          user: event.user,
          ip: event.ip,
          at: event.timestamp ?? Date.now(),
          type: 'failed',
          reason: event.reason,
          tty: this.allocateTty(),
        });
        return;

      case 'auth_invalid_user':
        this.append<BtmpRow>(BTMP_PATH, {
          user: event.user,
          ip: event.ip,
          at: event.timestamp ?? Date.now(),
          type: 'failed',
          reason: 'invalid user',
          tty: this.allocateTty(),
        });
        return;

      default:
        return;
    }
  }

  private append<T>(path: string, row: T): void {
    if (!this.vfs.exists(LOG_DIR)) this.vfs.mkdirp(LOG_DIR, 0o755, 0, 0);
    let existing: T[] = [];
    const raw = this.vfs.readFile(path);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) existing = parsed as T[];
      } catch { /* corrupt log → start fresh, matches util-linux behaviour */ }
    }
    existing.push(row);
    this.vfs.writeFile(path, JSON.stringify(existing), 0, 0, 0o022);
  }

  private allocateTty(): string {
    return `pts/${this.ptsCounter++}`;
  }
}
