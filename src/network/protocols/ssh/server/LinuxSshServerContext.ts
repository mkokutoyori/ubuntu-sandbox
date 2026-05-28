/**
 * LinuxSshServerContext — Adapter exposing a Linux machine to SshServerHandler.
 *
 * Wires together: VirtualFileSystem (data), LinuxUserManager (auth + uid
 * lookup) and the host name (for the deterministic host key). Instantiated
 * by LinuxMachine when starting sshd.
 *
 * Reference: DESIGN-SSH-SFTP.md section 8.
 */

import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import type { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';
import type { AuthMethodType, ISshAuthContext } from '../auth/ISshAuthMethod';
import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';
import { LinuxSftpFSAdapter } from '../sftp/LinuxSftpFSAdapter';
import { SshHostKey } from '../SshHostKey';
import { SshUserContext } from '../SshUserContext';
import {
  DEFAULT_SSH_SERVER_CONFIG,
  type ILinuxShell,
  type ISshServerContext,
  type SshServerConfig,
} from './ISshServerContext';
import {
  DEFAULT_SSHD_CONFIG,
  parseSshdConfig,
  serializeSshdConfig,
  type SshdConfig,
} from './SshSshdConfig';
import {
  SshServerEventBus,
  type ISshServerEventBus,
} from './SshServerEvent';
import { SshSyslogger } from '../logging/SshSyslogger';
import { LinuxUtmpProjection } from '../logging/LinuxUtmpProjection';
import { SshAuthThrottler } from '../security/SshAuthThrottler';

const AUTHORIZED_KEYS_PATH = (home: string): string =>
  `${home.replace(/\/$/, '')}/.ssh/authorized_keys`;

const LASTLOG_PATH = '/var/log/lastlog.json';
// `wtmp` and `btmp` are binary in real Linux. We store JSON in the simulator
// (analysis doc §3.7) so `last` / `lastb` can render OpenSSH-style rows.
const WTMP_PATH = '/var/log/wtmp.json';
const BTMP_PATH = '/var/log/btmp.json';

const SSHD_CONFIG_PATH = '/etc/ssh/sshd_config';
const HOST_KEY_PATH = '/etc/ssh/ssh_host_ed25519_key';
const HOST_KEY_PUB_PATH = '/etc/ssh/ssh_host_ed25519_key.pub';
const ETC_SSH_DIR = '/etc/ssh';

interface LastLoginEntry {
  user: string;
  ip: string;
  at: number;
}

interface WtmpEntry {
  user: string;
  ip: string;
  at: number;
  type: 'login' | 'logout' | 'reboot';
  tty: string;
}

interface BtmpEntry {
  user: string;
  ip: string;
  at: number;
  reason: string;
  tty: string;
}

function appendJsonLog(
  vfs: VirtualFileSystem,
  path: string,
  entry: unknown,
  mode: number,
): void {
  const raw = vfs.readFile(path);
  let arr: unknown[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      arr = [];
    }
  }
  arr.push(entry);
  vfs.writeFile(path, JSON.stringify(arr), 0, 0, 0o022);
  vfs.chmod(path, mode);
}

function matchesUserPattern(pattern: string, user: string): boolean {
  if (pattern === user || pattern === '*') return true;
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return re.test(user);
}

export interface LinuxSshServerContextOptions {
  /** Pre-wired event bus. If omitted a fresh one is created. */
  bus?: ISshServerEventBus;
  /** Enable /var/log/auth.log production. Default: true. */
  enableSyslog?: boolean;
  /** Enable fail2ban-style auth throttling. Default: true. */
  enableThrottler?: boolean;
  /** Throttler tuning — only consulted when enableThrottler is true. */
  throttlerThreshold?: number;
  throttlerWindowMs?: number;
  throttlerBlockMs?: number;
}

export class LinuxSshServerContext implements ISshServerContext {
  readonly hostKey: SshHostKey;
  readonly config: Readonly<SshServerConfig>;
  readonly auth: ISshAuthContext;
  readonly sshdConfig: SshdConfig;
  readonly events: ISshServerEventBus;
  private readonly throttler: SshAuthThrottler | null;
  private readonly syslogger: SshSyslogger | null;
  private readonly utmpProjection: LinuxUtmpProjection | null;

  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly userManager: LinuxUserManager,
    private readonly hostname: string,
    config: Partial<SshServerConfig> = {},
    private readonly executor: LinuxCommandExecutor | null = null,
    /**
     * Optional callback running through the device's full command pipeline
     * (network / service / bash). Used by LinuxMachine to route remote
     * shells through `executeCommand`, which covers `ip`, `arp`, `ping`
     * and the systemctl family in addition to the bash interpreter.
     */
    private readonly fullExecutor:
      | ((line: string) => Promise<string>)
      | null = null,
    opts: LinuxSshServerContextOptions = {},
  ) {
    this.ensureEtcSshFiles();
    this.hostKey = this.loadOrGenerateHostKey();
    this.sshdConfig = this.loadOrGenerateSshdConfig();
    this.config = Object.freeze({
      ...DEFAULT_SSH_SERVER_CONFIG,
      ...this.sshdConfig,
      ...config,
    });
    this.auth = this.buildAuthContext();
    this.events = opts.bus ?? new SshServerEventBus();

    // Reactive subsystems: each one is independent and only needs the bus.
    this.syslogger = (opts.enableSyslog ?? true)
      ? new SshSyslogger(this.vfs, this.events, {
          hostname: this.hostname,
          port: this.sshdConfig.listenPort,
          // Hand the device's journal in so SSH events surface in
          // `journalctl -u sshd`, not just in /var/log/auth.log.
          logMgr: this.executor?.logMgr,
        })
      : null;

    this.throttler = (opts.enableThrottler ?? true)
      ? new SshAuthThrottler(this.events, {
          threshold: opts.throttlerThreshold,
          windowMs: opts.throttlerWindowMs,
          blockMs: opts.throttlerBlockMs,
        })
      : null;

    // utmp / btmp are owned by recordLogin / recordAuthFailure on
    // this same context — the projection exists for tests that drive
    // SshServerEventBus directly without instantiating a full
    // LinuxSshServerContext, so we deliberately do NOT subscribe a
    // second writer here (it would double every row).
    this.utmpProjection = null;
  }

  /** Tell SshServerHandler whether the source IP is currently rate-limited. */
  isClientBlocked(ip: string): boolean {
    return this.throttler?.isBlocked(ip) ?? false;
  }

  /** Currently-banned IPs (fail2ban-client status backend). */
  bannedIps(): string[] {
    return this.throttler?.bannedIps() ?? [];
  }

  /** Total recorded auth failures across the throttler's lifetime. */
  totalAuthFailures(): number {
    return this.throttler?.totalFailures() ?? 0;
  }

  /** PermitEmptyPasswords gate consulted by SshServerHandler. */
  permitEmptyPasswords(): boolean {
    return this.sshdConfig.permitEmptyPasswords;
  }

  /** Detach reactive subscribers (logger, throttler) from the bus. */
  shutdown(): void {
    this.syslogger?.dispose();
    this.throttler?.dispose();
  }

  /** Re-read /etc/ssh/sshd_config and return a fresh context (SSH-07-R6). */
  reloadConfig(): LinuxSshServerContext {
    return new LinuxSshServerContext(this.vfs, this.userManager, this.hostname);
  }

  /** Banner text shown before authentication (SSH-07-R8). */
  getBanner(): string | null {
    if (!this.sshdConfig.banner) return null;
    return this.vfs.readFile(this.sshdConfig.banner);
  }

  getFilesystem(userCtx: SshUserContext): ISftpFileSystem {
    return new LinuxSftpFSAdapter(this.vfs, userCtx.uid, userCtx.gid);
  }

  getShell(_userCtx: SshUserContext, _cwd: string): ILinuxShell {
    // BRD SSH-05/SSH-04: prefer the device-wide pipeline (`fullExecutor`)
    // when available, since it covers network commands (ip, arp, ping)
    // and systemctl in addition to the bash interpreter. Fall back to the
    // executor's bash-only path, then to an informative stub.
    const executor = this.executor;
    const full = this.fullExecutor;
    if (full) {
      return {
        execute: async (line: string) => {
          const stdout = await full(line);
          const exitCode = /command not found|Permission denied/.test(stdout)
            ? 1
            : 0;
          return { stdout, stderr: '', exitCode };
        },
      };
    }
    if (executor) {
      return {
        execute: async (line: string) => {
          const stdout = executor.execute(line);
          const exitCode = /command not found|Permission denied/.test(stdout)
            ? 1
            : 0;
          return { stdout, stderr: '', exitCode };
        },
      };
    }
    return {
      execute: async (line: string) => ({
        stdout: `${line}: shell execution not wired (no executor)\n`,
        stderr: '',
        exitCode: 0,
      }),
    };
  }

  getMotd(): string {
    const motd = this.vfs.readFile('/etc/motd');
    return motd ?? `Welcome to ${this.hostname}\n`;
  }

  getLastLogin(user: string): string | null {
    const raw = this.vfs.readFile(LASTLOG_PATH);
    if (!raw) return null;
    try {
      const entries = JSON.parse(raw) as LastLoginEntry[];
      let last: LastLoginEntry | undefined;
      for (const entry of entries) {
        if (entry.user === user) last = entry;
      }
      if (!last) return null;
      const date = new Date(last.at).toUTCString();
      return `Last login: ${date} from ${last.ip}`;
    } catch {
      return null;
    }
  }

  recordLogin(user: string, fromIp: string): void {
    const entry: LastLoginEntry = { user, ip: fromIp, at: Date.now() };
    let entries: LastLoginEntry[] = [];
    const raw = this.vfs.readFile(LASTLOG_PATH);
    if (raw) {
      try {
        entries = JSON.parse(raw) as LastLoginEntry[];
      } catch {
        entries = [];
      }
    }
    entries.push(entry);
    this.vfs.writeFile(
      LASTLOG_PATH,
      JSON.stringify(entries),
      0,
      0,
      0o022,
    );
    // /var/log/auth.log is produced reactively by SshSyslogger subscribed to
    // the event bus (post-merge). We only own the lastlog + wtmp side here.
    this.appendWtmp({
      user,
      ip: fromIp,
      at: entry.at,
      type: 'login',
      tty: 'pts/0',
    });
    // Mirror the login into the in-memory lastlog registry so the SSH
    // client side (which lives in the same process) can pick up the
    // canonical ctime-formatted "Last login: …" line without re-parsing
    // the JSON file. The registry rotates current ↔ previous, keeping
    // PAM-like semantics.
    this.executor?.lastlog.record(user, fromIp, 'pts/0');
  }

  /**
   * Pair with {@link recordLogin}: append a DEAD_PROCESS-style row when
   * the SSH session ends, so `last` can show LOGOUT times instead of
   * just "still logged in". Real wtmp pairs USER_PROCESS / DEAD_PROCESS
   * by tty; we keep the same `tty: 'pts/0'` simplification as the login
   * side and tag the row `type: 'logout'`.
   */
  recordLogout(user: string, fromIp: string): void {
    this.appendWtmp({
      user,
      ip: fromIp,
      at: Date.now(),
      type: 'logout',
      tty: 'pts/0',
    });
  }

  /**
   * Mirror an authentication failure into /var/log/btmp.json (mode 0o600).
   * The matching /var/log/auth.log line is emitted by SshSyslogger via the
   * `auth_failure` event.
   */
  recordAuthFailure(user: string, fromIp: string, reason: string): void {
    this.appendBtmp({
      user: user || 'invalid user',
      ip: fromIp,
      at: Date.now(),
      reason,
      tty: 'ssh:notty',
    });
  }

  private appendWtmp(entry: WtmpEntry): void {
    appendJsonLog(this.vfs, WTMP_PATH, entry, 0o644);
  }

  private appendBtmp(entry: BtmpEntry): void {
    appendJsonLog(this.vfs, BTMP_PATH, entry, 0o600);
  }

  /** Build an SshUserContext for the authenticated user from /etc/passwd. */
  buildUserContext(username: string): SshUserContext | null {
    const user = this.userManager.getUser(username);
    if (!user) return null;
    const groups = this.userManager
      .getUserGroups(username)
      .map((g) => g.gid);
    return new SshUserContext(
      user.username,
      user.uid,
      user.gid,
      groups,
      user.home,
    );
  }

  // ─── private ─────────────────────────────────────────────────────

  private ensureEtcSshFiles(): void {
    if (!this.vfs.exists(ETC_SSH_DIR)) {
      this.vfs.mkdirp(ETC_SSH_DIR, 0o755, 0, 0);
    }
  }

  private loadOrGenerateHostKey(): SshHostKey {
    const pub = this.vfs.readFile(HOST_KEY_PUB_PATH);
    const priv = this.vfs.readFile(HOST_KEY_PATH);
    if (pub && priv) {
      const material = pub.trim().split(/\s+/)[1] ?? pub.trim();
      return SshHostKey.fromFiles(material, priv.trim(), 'ssh-ed25519');
    }
    const generated = SshHostKey.generate(this.hostname);
    this.vfs.writeFile(
      HOST_KEY_PUB_PATH,
      generated.publicKeyLine + '\n',
      0,
      0,
      0o022,
    );
    this.vfs.chmod(HOST_KEY_PUB_PATH, 0o644);
    // Persist a stable opaque private key blob (no real crypto — see C-02).
    this.vfs.writeFile(
      HOST_KEY_PATH,
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${generated.publicKey}\n-----END OPENSSH PRIVATE KEY-----\n`,
      0,
      0,
      0o022,
    );
    this.vfs.chmod(HOST_KEY_PATH, 0o600);
    return generated;
  }

  private loadOrGenerateSshdConfig(): SshdConfig {
    const existing = this.vfs.readFile(SSHD_CONFIG_PATH);
    if (existing) return parseSshdConfig(existing);
    this.vfs.writeFile(
      SSHD_CONFIG_PATH,
      serializeSshdConfig(DEFAULT_SSHD_CONFIG),
      0,
      0,
      0o022,
    );
    this.vfs.chmod(SSHD_CONFIG_PATH, 0o644);
    return DEFAULT_SSHD_CONFIG;
  }

  private buildAuthContext(): ISshAuthContext {
    let attemptsLeft = this.config.maxAuthTries;
    return {
      checkPassword: (user, password) => {
        attemptsLeft = Math.max(0, attemptsLeft - 1);
        if (!this.userAllowed(user)) return false;
        if (!this.config.passwordAuthentication) return false;
        return this.userManager.checkPassword(user, password);
      },
      checkPublicKey: (user, publicKey) => {
        if (!this.userAllowed(user)) return false;
        if (!this.config.pubkeyAuthentication) return false;
        const userEntry = this.userManager.getUser(user);
        if (!userEntry) return false;
        const path = AUTHORIZED_KEYS_PATH(userEntry.home);
        const content = this.vfs.readFile(path);
        if (!content) return false;
        return content
          .split('\n')
          .some((line) => line.trim().split(/\s+/)[1] === publicKey);
      },
      getAttemptsRemaining: () => attemptsLeft,
      getAvailableMethods: (): readonly AuthMethodType[] => {
        const methods: AuthMethodType[] = [];
        if (this.config.pubkeyAuthentication) methods.push('publickey');
        if (this.config.passwordAuthentication) methods.push('password');
        return methods;
      },
    };
  }

  /**
   * Enforce sshd_config user-acceptance rules. Order mirrors real OpenSSH:
   *   1. DenyUsers  — explicit reject wins.
   *   2. AllowUsers — when set, only listed patterns may log in.
   *   3. DenyGroups — reject if any of user's groups match.
   *   4. AllowGroups — when set, at least one group must match.
   *   5. PermitRootLogin — root is gated last.
   */
  private userAllowed(user: string): boolean {
    if (user === 'root' && !this.config.permitRootLogin) return false;

    const { allowUsers, denyUsers, allowGroups, denyGroups } = this.sshdConfig;
    if (denyUsers.some((p) => matchesUserPattern(p, user))) return false;
    if (allowUsers.length > 0 && !allowUsers.some((p) => matchesUserPattern(p, user))) {
      return false;
    }

    if (denyGroups.length > 0 || allowGroups.length > 0) {
      const userGroups = this.userManager
        .getUserGroups(user)
        .map((g) => g.name);
      if (denyGroups.some((p) => userGroups.some((g) => matchesUserPattern(p, g)))) {
        return false;
      }
      if (
        allowGroups.length > 0 &&
        !allowGroups.some((p) => userGroups.some((g) => matchesUserPattern(p, g)))
      ) {
        return false;
      }
    }
    return true;
  }
}
