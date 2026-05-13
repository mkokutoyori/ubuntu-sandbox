/**
 * SshSyslogger — reactive /var/log/auth.log producer.
 *
 * Subscribes to an SshServerEventBus and translates each event into an
 * OpenSSH-compatible syslog line, appended to /var/log/auth.log in the
 * given VirtualFileSystem.
 *
 * The format mirrors a real Ubuntu sshd:
 *   <Mon DD HH:MM:SS> <hostname> sshd[<pid>]: <message>
 *
 * Reactive design: the SSH transport layer (SshServerHandler) emits events
 * unaware of any logger; this class is the only one that knows the wire
 * format. Adding new events later requires only extending {@link format}.
 *
 * Reference: man 5 sshd_config — LogLevel, SyslogFacility.
 */

import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type {
  ISshServerEventBus,
  SshServerEvent,
} from '../server/SshServerEvent';

const AUTH_LOG_PATH = '/var/log/auth.log';
const LOG_DIR = '/var/log';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export interface SshSysloggerOptions {
  readonly hostname: string;
  /** PID printed inside `sshd[<pid>]`. Defaults to a random high value. */
  readonly sshdPid?: number;
  /** SSH listening port shown in `port <n> ssh2`. Defaults to 22. */
  readonly port?: number;
  /** Optional clock override for deterministic tests. */
  readonly clock?: () => Date;
}

/**
 * Subscribes to bus and writes one line per event to /var/log/auth.log.
 *
 * Use {@link dispose} to detach when the server shuts down.
 */
export class SshSyslogger {
  private readonly hostname: string;
  private readonly sshdPid: number;
  private readonly port: number;
  private readonly clock: () => Date;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly vfs: VirtualFileSystem,
    bus: ISshServerEventBus,
    opts: SshSysloggerOptions,
  ) {
    this.hostname = opts.hostname;
    this.sshdPid = opts.sshdPid ?? 1000 + Math.floor(Math.random() * 9000);
    this.port = opts.port ?? 22;
    this.clock = opts.clock ?? (() => new Date());
    this.unsubscribe = bus.on('*', (e) => this.handle(e));
  }

  /** Detach from the event bus. After dispose() no further lines are written. */
  dispose(): void {
    this.unsubscribe();
  }

  // ─── private ───────────────────────────────────────────────────────

  private handle(event: SshServerEvent): void {
    const message = this.format(event);
    if (!message) return;
    this.append(message);
  }

  /**
   * Translate a structured event into an OpenSSH-style message body.
   * Returns null for events that should not be logged.
   */
  private format(event: SshServerEvent): string | null {
    switch (event.kind) {
      case 'client_connected':
        return `Connection from ${event.ip} port ${event.port ?? this.port} on ${this.hostname} port ${this.port}`;

      case 'auth_success':
        if (event.method === 'publickey' && event.keyFingerprint) {
          return `Accepted publickey for ${event.user} from ${event.ip} port ${event.port ?? this.port} ssh2: ED25519 ${event.keyFingerprint}`;
        }
        return `Accepted ${event.method} for ${event.user} from ${event.ip} port ${event.port ?? this.port} ssh2`;

      case 'auth_failure': {
        const method = event.method ?? 'unknown';
        return `Failed ${method} for ${event.user} from ${event.ip} port ${event.port ?? this.port} ssh2`;
      }

      case 'auth_invalid_user':
        return `Invalid user ${event.user} from ${event.ip} port ${event.port ?? this.port}`;

      case 'auth_throttled':
        return `Refusing connection from ${event.ip}: ${event.failuresInWindow} authentication failures in ${event.windowSeconds}s window`;

      case 'client_disconnected': {
        const user = event.user || 'unknown user';
        const reason = event.reason ?? 'client_disconnect';
        const prefix = event.user ? 'authenticating user ' : '';
        return `Connection closed by ${prefix}${user} ${event.ip} [${reason}]`;
      }

      case 'channel_opened':
        return `pam_unix(sshd:session): session opened for user ${event.user} (channel ${event.channelType})`;

      case 'channel_closed':
        return `pam_unix(sshd:session): session closed for user ${event.user} (channel ${event.channelType}, duration=${event.durationMs}ms)`;

      default:
        return null;
    }
  }

  private append(message: string): void {
    if (!this.vfs.exists(LOG_DIR)) this.vfs.mkdirp(LOG_DIR, 0o755, 0, 0);
    const line = `${this.timestamp()} ${this.hostname} sshd[${this.sshdPid}]: ${message}\n`;
    const existing = this.vfs.readFile(AUTH_LOG_PATH) ?? '';
    this.vfs.writeFile(AUTH_LOG_PATH, existing + line, 0, 0, 0o022);
  }

  /** `Mon DD HH:MM:SS` — RFC3164-style, single-digit day padded with space. */
  private timestamp(): string {
    const now = this.clock();
    const mon = MONTHS[now.getUTCMonth()];
    const day = String(now.getUTCDate()).padStart(2, ' ');
    const hh = String(now.getUTCHours()).padStart(2, '0');
    const mm = String(now.getUTCMinutes()).padStart(2, '0');
    const ss = String(now.getUTCSeconds()).padStart(2, '0');
    return `${mon} ${day} ${hh}:${mm}:${ss}`;
  }
}
