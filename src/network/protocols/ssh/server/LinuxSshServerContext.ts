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
import { LinuxMachine } from '@/network/devices/LinuxMachine';
import type { AuthMethodType, ISshAuthContext } from '../auth/ISshAuthMethod';
import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';
import { LinuxSftpFSAdapter } from '../sftp/LinuxSftpFSAdapter';
import { ChrootedSftpFileSystem } from '../sftp/ChrootedSftpFileSystem';
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
import { SshdServerConfig } from './SshdServerConfig';
import { LinuxUtmpProjection } from '../logging/LinuxUtmpProjection';
import { SshAuthThrottler } from '../security/SshAuthThrottler';
import { Fail2banAgent } from '../security/Fail2banAgent';
import { SshInteractiveShell } from './SshInteractiveShell';
import { SubShellStack } from '@/shell/SubShellStack';
import type { Equipment } from '@/network/equipment/Equipment';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';
import { parseEditorLaunch } from '@/network/devices/linux/editors/editorLaunch';
import { createEditorSession } from '@/network/devices/linux/editors/EditorView';
import { installDefaultEditors } from '@/network/devices/linux/editors/registerEditors';

const AUTHORIZED_KEYS_PATH = (home: string): string =>
  `${home.replace(/\/$/, '')}/.ssh/authorized_keys`;

const LASTLOG_PATH = '/var/log/lastlog.json';
// `wtmp` and `btmp` are binary in real Linux. We store JSON in the simulator
// (analysis doc §3.7) so `last` / `lastb` can render OpenSSH-style rows.
const WTMP_PATH = '/var/log/wtmp.json';
const BTMP_PATH = '/var/log/btmp.json';

const SSHD_CONFIG_PATH = '/etc/ssh/sshd_config';
const FAIL2BAN_JAIL_LOCAL_PATH = '/etc/fail2ban/jail.local';
const DEFAULT_FAIL2BAN_JAIL_LOCAL =
  '[sshd]\nenabled = true\nmaxretry = 5\nbantime = 300\nfindtime = 60\n';
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

/** Render a sub-shell's output lines the way the wire expects stdout. */
function joinLines(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n';
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
  /**
   * The LinuxMachine this context serves. Passed through to
   * `createInteractiveShell()` so SshServerHandler can offer real-time
   * streaming (`ping`) over an interactive shell channel. Omitted by tests
   * that construct a bare context without a full device — those simply
   * don't get streaming (createInteractiveShell returns null).
   */
  device?: unknown;
}

export class LinuxSshServerContext implements ISshServerContext {
  readonly hostKey: SshHostKey;
  readonly config: Readonly<SshServerConfig>;
  readonly auth: ISshAuthContext;
  readonly sshdConfig: SshdConfig;
  readonly events: ISshServerEventBus;
  private readonly throttler: SshAuthThrottler | null;
  readonly fail2ban: Fail2banAgent | null;
  private readonly syslogger: SshSyslogger | null;
  private readonly utmpProjection: LinuxUtmpProjection | null;
  readonly rawConfig: string;
  private cachedEffective: SshdServerConfig | null = null;
  private readonly device: unknown;

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
    this.device = opts.device ?? null;

    // Reactive subsystems: each one is independent and only needs the bus.
    this.syslogger = (opts.enableSyslog ?? true)
      ? new SshSyslogger(this.vfs, this.events, {
          hostname: this.hostname,
          port: this.sshdConfig.listenPort,
          // The pid of the REAL sshd in this machine's process table, not
          // a fresh random one: `ps`, `sshd[<pid>]` in auth.log and
          // `journalctl -u ssh` describe one daemon and must name it the
          // same way. Falls back to the random default only when no sshd
          // process exists to point at.
          sshdPid: this.executor?.processMgr?.list({ comm: 'sshd' })[0]?.pid,
          // Hand the device's journal in so SSH events surface in
          // `journalctl -u sshd`, not just in /var/log/auth.log.
          logMgr: this.executor?.logMgr,
        })
      : null;
    const userMgr = this.executor?.userMgr;
    if (userMgr) {
      this.syslogger?.setUidLookup((u) => userMgr.getUser(u)?.uid ?? 1000);
    }

    // Fail2ban jail (sshd) — constructed before the throttler so its
    // `auth_failure` subscription (the "Found <ip>" line) observes each
    // attempt before the throttler's own handler synchronously re-emits
    // `auth_throttled` on the attempt that crosses the threshold — real
    // fail2ban.log always shows every `Found` line before the `Ban`
    // line it triggers, never after.
    this.fail2ban = this.executor
      ? new Fail2banAgent(
          this.events,
          {
            execute: (args) => ({ exitCode: this.executor!.iptables.execute(args).exitCode }),
            hasChain: (name) => this.executor!.iptables.hasChain('filter', name),
          },
          {
            appendLog: (line) => {
              const prev = this.vfs.readFile('/var/log/fail2ban.log') ?? '';
              this.vfs.writeFile('/var/log/fail2ban.log', prev + line + '\n', 0, 0, 0o022);
            },
          },
          {
            journal: {
              log: (action) => this.executor!.logMgr.logDaemon('fail2ban-server', action, undefined, 'fail2ban'),
            },
          },
        )
      : null;

    const jail = this.loadFail2banJailConfig();
    this.throttler = (opts.enableThrottler ?? true)
      ? new SshAuthThrottler(this.events, {
          threshold: opts.throttlerThreshold ?? jail.maxretry,
          windowMs: opts.throttlerWindowMs ?? jail.findtimeSeconds * 1000,
          blockMs: opts.throttlerBlockMs ?? jail.bantimeSeconds * 1000,
        })
      : null;


    // utmp / btmp are owned by recordLogin / recordAuthFailure on
    // this same context — the projection exists for tests that drive
    // SshServerEventBus directly without instantiating a full
    // LinuxSshServerContext, so we deliberately do NOT subscribe a
    // second writer here (it would double every row).
    this.utmpProjection = null;

    this.rawConfig = this.vfs.readFile('/etc/ssh/sshd_config') ?? '';
  }

  /** Tell SshServerHandler whether the source IP is currently rate-limited. */
  isClientBlocked(ip: string): boolean {
    return this.throttler?.isBlocked(ip) ?? false;
  }

  /** Currently-banned IPs (fail2ban-client status backend). */
  bannedIps(): string[] {
    return this.throttler?.bannedIps() ?? [];
  }

  /**
   * `fail2ban-client set <jail> unbanip <ip>` — lift the ban immediately,
   * both at the iptables layer (Fail2banAgent) and the SSH-protocol
   * layer (the throttler's own block), regardless of remaining time.
   * Returns false when the IP was not actually banned.
   */
  unbanIp(ip: string): boolean {
    const wasBanned = this.fail2ban?.forceUnban(ip) ?? false;
    this.throttler?.unblock(ip);
    return wasBanned;
  }

  /** `fail2ban-client get <jail> bantime` — configured ban duration, in seconds. */
  bantimeSeconds(): number {
    return this.fail2ban?.bantimeSeconds() ?? 0;
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
    return new LinuxSshServerContext(
      this.vfs, this.userManager, this.hostname, {}, this.executor, this.fullExecutor,
      { device: this.device },
    );
  }

  /**
   * Real-time job runtime for one shell channel (streaming `ping`, Ctrl+C
   * interrupt). Returns null when this context was built without a device
   * reference (bare unit-test contexts) — SshServerHandler falls back to
   * the plain one-shot `getShell()` round trip in that case.
   */
  createInteractiveShell(_userCtx: SshUserContext): SshInteractiveShell | null {
    if (!this.device) return null;
    return new SshInteractiveShell(this.device);
  }

  /**
   * Modern (Match-block aware) view of sshd_config, captured at the
   * moment this context was constructed. Callers SHOULD use this rather
   * than re-parsing /etc/ssh/sshd_config every login, so changes to the
   * on-disk file are only honoured after `systemctl reload ssh` (the
   * real sshd behaviour). The text snapshot lives in {@link rawConfig}.
   */
  effectiveSshdServerConfig(): SshdServerConfig {
    if (!this.cachedEffective) this.cachedEffective = SshdServerConfig.parse(this.rawConfig);
    return this.cachedEffective;
  }

  /** Banner text shown before authentication (SSH-07-R8). */
  getBanner(): string | null {
    if (!this.sshdConfig.banner) return null;
    return this.vfs.readFile(this.sshdConfig.banner);
  }

  getFilesystem(userCtx: SshUserContext): ISftpFileSystem {
    const fs = new LinuxSftpFSAdapter(this.vfs, userCtx.uid, userCtx.gid);
    const chroot = this.chrootDirectoryFor(userCtx.username);
    return chroot ? new ChrootedSftpFileSystem(fs, chroot) : fs;
  }

  /**
   * `ChrootDirectory` for this account, global or from the first matching
   * `Match` block. A real sshd confines the session itself; here it was
   * applied only by a client that resolved the remote VFS in memory, so
   * the same account escaped its chroot the moment the transfer went
   * over the wire.
   */
  private chrootDirectoryFor(user: string): string | null {
    const cfg = this.effectiveSshdServerConfig();
    const groups = (this.userManager.getUserGroups?.(user) ?? []).map((g: { name: string }) => g.name);
    for (const block of cfg.matchBlocks) {
      const applies = block.criteria.every((c: { keyword: string; value: string }) => {
        if (c.keyword === 'User') return c.value === user || c.value === '*';
        if (c.keyword === 'Group') return groups.includes(c.value);
        return true;
      });
      if (!applies) continue;
      const cd = (block.overrides as { chrootDirectory?: string }).chrootDirectory;
      if (cd) return cd;
    }
    return cfg.chrootDirectory;
  }

  getShell(userCtx: SshUserContext, cwd: string, opts?: { interactive?: boolean }): ILinuxShell {
    // Real per-session isolation: a dedicated LinuxShellSession (its own
    // cwd/env/su-stack, exactly like a real pty) so commands run as the
    // AUTHENTICATED user, not whatever user the device's single shared
    // ambient LinuxCommandExecutor happens to be sitting in. Without
    // this, `ssh alice@host` then `whoami` would print the device's
    // ambient console user instead of "alice" — SshServerHandler calls
    // getShell() once per shell channel and reuses the returned object
    // (see `shell_open`), so this session persists correctly across the
    // channel's lifetime and is torn down via ILinuxShell.dispose().
    if (this.device instanceof LinuxMachine) {
      const device = this.device;
      const interactive = opts?.interactive ?? false;
      // An account can exist in /etc/passwd with no home on disk
      // (`useradd` without -m). Real sshd reports "Could not chdir to home
      // directory" and starts the session in `/` rather than in a
      // directory that isn't there.
      const startCwd = this.vfs.exists(cwd) ? cwd : '/';
      const session = device.openShellSession({ user: userCtx.username, cwd: startCwd });
      // `sqlplus` / `rman` typed over SSH must push their REPL on this
      // side of the wire — the client only exchanges lines and a prompt,
      // so a client-side sub-shell stack would never see them.
      const subShells = new SubShellStack({
        device: device as unknown as Equipment,
        user: userCtx.username,
        primaryKind: 'bash',
      });
      return {
        execute: async (line: string) => {
          if (subShells.active) {
            const routed = await subShells.process(line);
            return { stdout: joinLines(routed.output), stderr: '', exitCode: routed.exitCode };
          }
          const launched = subShells.launch(line);
          if (launched) return { stdout: joinLines(launched), stderr: '', exitCode: 0 };
          const stdout = await device.executeCommandInSession(line, session, { color: interactive });
          // The shell session's own `$?`, captured by the command pipeline.
          // Guessing it from the output text used to report success for
          // anything the pattern missed — `false`, a failing grep, a
          // missing file.
          return { stdout, stderr: '', exitCode: session.lastExitCode };
        },
        // Completion runs inside this channel's own session, so paths
        // resolve against its cwd rather than the device-wide one.
        getCompletions: (line: string) =>
          [...(subShells.getCompletions(line) ?? device.getCompletionsForSession(line, session))],
        isNested: () => subShells.active,
        // The engine runs here, on this channel's own session: the file
        // it opens, the permissions it obeys and the swap file it drops
        // are the remote's, not the client's.
        openEditor: (commandLine: string) => {
          installDefaultEditors();
          const launch = parseEditorLaunch(commandLine);
          if (!launch) return null;
          const fs = new LinuxEditorFsContext(device, session);
          const content = launch.filePath === '' ? null : fs.readFile(launch.filePath);
          return createEditorSession(launch.editor, {
            fs,
            filePath: launch.filePath === '' ? '' : fs.resolvePath(launch.filePath),
            content: content ?? '',
            isNewFile: content === null,
            owner: userCtx.username,
            readOnly: launch.readOnly,
            showPosition: launch.showPosition,
            showLineNumbers: launch.showLineNumbers,
            initialCursorLine: launch.initialCursorLine,
            initialCursorCol: launch.initialCursorCol,
          });
        },
        getPrompt: () => {
          const nested = subShells.getPrompt();
          if (nested !== null) return nested;
          // The authenticated user's real home from /etc/passwd — never a
          // guessed `/home/<name>`, which would be wrong for root (/root)
          // and for any account with a custom home.
          const home = userCtx.homeDirectory;
          const shortCwd = session.cwd === home ? '~'
            : session.cwd.startsWith(`${home}/`) ? `~${session.cwd.slice(home.length)}`
            : session.cwd;
          return `${userCtx.username}@${device.getSshHostname()}:${shortCwd}${userCtx.isRoot() ? '#' : '$'} `;
        },
        // A persistent shell channel ends by hanging up (real terminal
        // close); a one-shot exec ran its single command to completion,
        // so its shell exits normally instead.
        dispose: () => {
          subShells.dispose();
          device.closeShellSession(session, { graceful: !interactive });
        },
      };
    }

    // BRD SSH-05/SSH-04: bare test contexts built without a resolvable
    // device fall back to the shared ambient pipeline (`fullExecutor`)
    // when available, since it covers network commands (ip, arp, ping)
    // and systemctl in addition to the bash interpreter. Fall back to the
    // executor's bash-only path, then to an informative stub. No real
    // device (LinuxMachine.getSshServerContext()) ever takes this path.
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

  /**
   * Read the sshd jail's `maxretry`/`bantime`/`findtime` from
   * `/etc/fail2ban/jail.local`, seeding it with fail2ban's real stock
   * defaults on first access. Consulted once at construction, matching
   * real fail2ban which only re-reads its jail config on service
   * restart, not on every connection.
   */
  private loadFail2banJailConfig(): { maxretry: number; bantimeSeconds: number; findtimeSeconds: number } {
    const defaults = { maxretry: 5, bantimeSeconds: 300, findtimeSeconds: 60 };
    let raw = this.vfs.readFile(FAIL2BAN_JAIL_LOCAL_PATH);
    if (raw === null) {
      if (!this.vfs.exists('/etc/fail2ban')) this.vfs.mkdirp('/etc/fail2ban', 0o755, 0, 0);
      this.vfs.writeFile(FAIL2BAN_JAIL_LOCAL_PATH, DEFAULT_FAIL2BAN_JAIL_LOCAL, 0, 0, 0o022);
      raw = DEFAULT_FAIL2BAN_JAIL_LOCAL;
    }

    let inSshdSection = false;
    const values: Partial<typeof defaults> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
      const section = /^\[(\w+)\]$/.exec(trimmed);
      if (section) { inSshdSection = section[1] === 'sshd'; continue; }
      if (!inSshdSection) continue;
      const kv = /^(\w+)\s*=\s*(\S+)$/.exec(trimmed);
      if (!kv) continue;
      const value = parseInt(kv[2], 10);
      if (!Number.isFinite(value)) continue;
      if (kv[1] === 'maxretry') values.maxretry = value;
      else if (kv[1] === 'bantime') values.bantimeSeconds = value;
      else if (kv[1] === 'findtime') values.findtimeSeconds = value;
    }
    return { ...defaults, ...values };
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
        if (this.sshdConfig.strictModes && this.firstStrictModesViolation(userEntry.uid, userEntry.home) !== null) {
          return false;
        }
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
      checkAccountLifecycle: (user) => this.userManager.accountLifecycleGate(user),
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

  /**
   * StrictModes (`man 5 sshd_config`): refuse a pubkey login when $HOME or
   * ~/.ssh are group/world-writable, or authorized_keys has any group/other
   * access at all — mirrors OpenSSH's stock check (0o022 mask on
   * $HOME/~/.ssh) plus the stricter, universally-taught "must be 0600" rule
   * on authorized_keys (0o077 mask). Returns the first offending path, or
   * null when nothing fails.
   */
  private firstStrictModesViolation(userUid: number, home: string): string | null {
    for (const path of [home, `${home}/.ssh`]) {
      const inode = this.vfs.resolveInode(path, true);
      if (!inode) continue;
      if (inode.uid !== userUid && inode.uid !== 0) return path;
      if ((inode.permissions & 0o022) !== 0) return path;
    }
    const akPath = AUTHORIZED_KEYS_PATH(home);
    const ak = this.vfs.resolveInode(akPath, true);
    if (ak) {
      if (ak.uid !== userUid && ak.uid !== 0) return akPath;
      if ((ak.permissions & 0o077) !== 0) return akPath;
    }
    return null;
  }
}
