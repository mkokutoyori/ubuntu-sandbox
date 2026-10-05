/**
 * RouterSshServerContext — Adapter exposing a Cisco IOS / Huawei VRP
 * router (or any future {@link Router}) to the shared
 * {@link SshServerHandler}.
 *
 * Why this exists: SSH from a Linux / Windows client to a router used to
 * travel through the synchronous bypass bridge ({@link
 * SshExecTarget.runSshCommandSync}) because routers had no TCP server
 * machinery. With the v2 {@link TcpStack} now wired into {@link Router},
 * we can host a real SSH daemon on port 22 and let the same packets
 * traverse the simulated wire as for any Linux box.
 *
 * Design:
 *   - `auth` consults the device's {@link NetworkOsCredentialStore}
 *     (the same store backing `username admin secret …` and the
 *     existing cross-vendor host's gate).
 *   - `getShell` prefers `target.createVtyShell()` — a real per-channel
 *     CLI session (PRD-SSH-Unification.md Phase A2) whose mode
 *     transitions (`enable`, `configure terminal`) and prompt genuinely
 *     persist across lines, with tab-completion/`?` help riding the same
 *     channel (Phase B1). It falls back to
 *     {@link SshExecTarget.runSshCommandSync} — a stateless one-shot
 *     line dispatch with no mode/prompt persistence — only for a target
 *     that doesn't implement `createVtyShell`.
 *   - `getFilesystem` returns the vendor's {@link RouterSftpFileSystem}
 *     view (running-config / startup-config), keeping the SFTP subsystem
 *     coherent with what `copy running-config tftp:` would expose.
 *
 * The handler treats every authenticated session uniformly — Linux,
 * Windows, Cisco, Huawei — so the rich event surface (auth_success,
 * channel_opened, …) lights up regardless of vendor.
 */

import { SSH_SERVER_IDENTIFICATION } from '../serverIdentification';
import type { AuthMethodType, ISshAuthContext } from '../auth/ISshAuthMethod';
import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';
import { RouterSftpFileSystem, type RouterSftpSource } from '../sftp/RouterSftpFileSystem';
import type { SshHostKey } from '../SshHostKey';
import { SshUserContext } from '../SshUserContext';
import {
  DEFAULT_SSH_SERVER_CONFIG,
  type ILinuxShell,
  type ISshServerContext,
  type SshServerConfig,
  type SshTransportPolicy,
} from './ISshServerContext';
import type { NegotiatedAlgorithms } from '../transport/SshKexInit';
import type { ISshServerEventBus } from './SshServerEvent';
import type { SshExecTarget } from './SshExecTarget';

export interface NetworkOsCredentialAuthority {
  authenticate(name: string, password: string): boolean;
  has?(name: string): boolean;
  get?(name: string): { name: string; privilege: number; secret: string } | undefined;
}

export interface RouterSshServerDeps {
  /** Hostname surfaced in banners / motd. */
  hostname(): string;
  /** Cached or freshly-generated SSH host key. */
  hostKey(): SshHostKey;
  /** Authority backing username / password validation. */
  credentials(): NetworkOsCredentialAuthority;
  /** Optional AAA method-list authentication chain (RADIUS/TACACS+/local/enable/none). */
  aaaAuthenticate?(username: string, password: string): Promise<boolean>;
  /** Router-style execution backend (IOS / VRP / cmd.exe line dispatch). */
  execTarget(): SshExecTarget;
  /** `exec-timeout` of the VTY line an incoming session lands on, in ms. */
  execIdleTimeoutMs?(): number | null;
  /** Optional sftp source (running-config, startup-config). */
  sftpSource?(): RouterSftpSource | null;
  /** Optional reactive event bus from the SSH event subsystem. */
  events?: ISshServerEventBus;
  /** Optional banner text printed before authentication. */
  banner?(): string | null;
  identification?(): string;
  transportPolicy?(): SshTransportPolicy;
  transportEstablished?(clientIp: string, algorithms: NegotiatedAlgorithms): void;
  /** Optional motd text printed after authentication. */
  motd?(): string;
  /** Optional record-login callback when a session is established. */
  recordLogin?(user: string, fromIp: string): void;
  /** Optional record-logout callback when the last channel of a session closes. */
  recordLogout?(user: string, fromIp: string): void;
  /** Optional rate-limit gate. */
  isClientBlocked?(ip: string, user?: string): boolean;
  /** Optional auth-failure hook for the audit log. */
  recordAuthFailure?(user: string, fromIp: string, reason: string): void;
  forcedCommand?(user: string): string | null;
  publicKeyAdmitted?(user: string, offeredKeyMaterial: string): boolean;
}

export class RouterSshServerContext implements ISshServerContext {
  readonly hostKey: SshHostKey;
  readonly config: Readonly<SshServerConfig>;
  readonly auth: ISshAuthContext;
  readonly events?: ISshServerEventBus;

  constructor(
    private readonly deps: RouterSshServerDeps,
    overrides: Partial<SshServerConfig> = {},
  ) {
    this.hostKey = deps.hostKey();
    this.config = Object.freeze({ ...DEFAULT_SSH_SERVER_CONFIG, ...overrides });
    this.events = deps.events;
    this.auth = this.buildAuthContext();
  }

  getFilesystem(_userCtx: SshUserContext): ISftpFileSystem {
    const src = this.deps.sftpSource?.();
    if (!src) {
      // Empty FS surface — routers without `ip scp server enable` simply
      // refuse SFTP. We return an adapter that rejects every op so the
      // SshServerHandler logs the failure for free.
      return new RouterSftpFileSystem({ read: () => null, list: () => [] });
    }
    return new RouterSftpFileSystem(src);
  }

  execIdleTimeoutMs(): number | null {
    return this.deps.execIdleTimeoutMs?.() ?? null;
  }

  getShell(userCtx: SshUserContext, _cwd: string): ILinuxShell {
    const target = this.deps.execTarget();

    // A real per-channel CLI session when the target can mint one: mode
    // transitions (`enable`, `configure terminal`) then persist across
    // lines, which the one-shot path below cannot express.
    const vty = target.createVtyShell?.(userCtx.username);
    if (vty) {
      return {
        execute: async (line: string) => {
          const stdout = await vty.execute(line);
          return {
            stdout: stdout.endsWith('\n') || stdout === '' ? stdout : `${stdout}\n`,
            stderr: '',
            exitCode: 0,
            sessionEnded: vty.lastEndedSession?.() ?? false,
          };
        },
        getPrompt: () => vty.getPrompt(),
        getCompletions: vty.getCompletions ? (line: string) => vty.getCompletions!(line) : undefined,
        subscribeAsyncOutput: vty.subscribeAsyncOutput
          ? (sink: (line: string) => void) => vty.subscribeAsyncOutput!(sink)
          : undefined,
        dispose: vty.dispose ? () => vty.dispose!() : undefined,
        supportsInlineHelp: true,
        // `?` is a help key here, and `clear counters` is a real command
        // — neither behaves the POSIX way.
        posixShell: false,
      };
    }

    return {
      execute: async (line: string) => {
        const result = target.runSshCommandSync(userCtx.username, line);
        if (!result) {
          return {
            stdout: '',
            stderr: `${line}: command not recognised on this device\n`,
            exitCode: 1,
          };
        }
        return {
          stdout: result.output,
          stderr: '',
          exitCode: result.exitCode,
        };
      },
    };
  }

  serverIdentification(): string {
    return this.deps.identification?.() ?? SSH_SERVER_IDENTIFICATION;
  }

  transportPolicy(): SshTransportPolicy {
    return this.deps.transportPolicy?.() ?? {};
  }

  transportEstablished(clientIp: string, algorithms: NegotiatedAlgorithms): void {
    this.deps.transportEstablished?.(clientIp, algorithms);
  }

  getBanner(): string | null {
    return this.deps.banner?.() ?? null;
  }

  getMotd(): string {
    return this.deps.motd?.() ?? `Welcome to ${this.deps.hostname()}\n`;
  }

  getLastLogin(_user: string): string | null { return null; }

  recordLogin(user: string, fromIp: string): void {
    this.deps.recordLogin?.(user, fromIp);
  }

  recordLogout(user: string, fromIp: string): void {
    this.deps.recordLogout?.(user, fromIp);
  }

  recordAuthFailure(user: string, fromIp: string, reason: string): void {
    this.deps.recordAuthFailure?.(user, fromIp, reason);
  }

  buildUserContext(username: string): SshUserContext | null {
    const cred = this.deps.credentials();
    const present = cred.has?.(username) ?? cred.get?.(username) !== undefined;
    if (!present) return null;
    return new SshUserContext(username, 0, 0, [], `/`);
  }

  forcedCommand(userCtx: SshUserContext): string | null {
    return this.deps.forcedCommand?.(userCtx.username) ?? null;
  }

  isClientBlocked(ip: string, user?: string): boolean {
    return this.deps.isClientBlocked?.(ip, user) ?? false;
  }

  permitEmptyPasswords(): boolean { return false; }

  // ── private ───────────────────────────────────────────────────────

  private buildAuthContext(): ISshAuthContext {
    let attemptsLeft = this.config.maxAuthTries;
    return {
      checkPassword: (user, password) => {
        attemptsLeft = Math.max(0, attemptsLeft - 1);
        if (!this.config.passwordAuthentication) return false;
        return this.deps.credentials().authenticate(user, password);
      },
      checkPasswordAsync: this.deps.aaaAuthenticate
        ? async (user, password) => {
            attemptsLeft = Math.max(0, attemptsLeft - 1);
            if (!this.config.passwordAuthentication) return false;
            return this.deps.aaaAuthenticate!(user, password);
          }
        : undefined,
      checkPublicKey: (user, publicKey) => {
        attemptsLeft = Math.max(0, attemptsLeft - 1);
        return this.deps.publicKeyAdmitted?.(user, publicKey) ?? false;
      },
      getAttemptsRemaining: () => attemptsLeft,
      getAvailableMethods: (): readonly AuthMethodType[] => {
        const methods: AuthMethodType[] = [];
        if (this.config.pubkeyAuthentication && this.deps.publicKeyAdmitted) methods.push('publickey');
        if (this.config.passwordAuthentication) methods.push('password');
        return methods;
      },
    };
  }
}
