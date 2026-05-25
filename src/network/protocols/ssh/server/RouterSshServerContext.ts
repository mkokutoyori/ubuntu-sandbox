/**
 * RouterSshServerContext — Adapter exposing a Cisco IOS / Huawei VRP
 * router (or any future {@link Router}) to the shared
 * {@link SshServerHandler}.
 *
 * Why this exists: SSH from a Linux / Windows client to a router used to
 * travel through the synchronous bypass bridge ({@link
 * SshExecTarget.runSshCommandSync}) because routers had no TCP server
 * machinery. With {@link TcpServerStack} now wired into {@link Router},
 * we can host a real SSH daemon on port 22 and let the same packets
 * traverse the simulated wire as for any Linux box.
 *
 * Design:
 *   - `auth` consults the device's {@link NetworkOsCredentialStore}
 *     (the same store backing `username admin secret …` and the
 *     existing cross-vendor host's gate).
 *   - `getShell` delegates each line to the router's
 *     {@link SshExecTarget.runSshCommandSync}, which already speaks IOS
 *     / VRP / cmd.exe semantics for the line-mode commands the cross-
 *     vendor test suite exercises.
 *   - `getFilesystem` returns the vendor's {@link RouterSftpFileSystem}
 *     view (running-config / startup-config), keeping the SFTP subsystem
 *     coherent with what `copy running-config tftp:` would expose.
 *
 * The handler treats every authenticated session uniformly — Linux,
 * Windows, Cisco, Huawei — so the rich event surface (auth_success,
 * channel_opened, …) lights up regardless of vendor.
 */

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
} from './ISshServerContext';
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
  /** Router-style execution backend (IOS / VRP / cmd.exe line dispatch). */
  execTarget(): SshExecTarget;
  /** Optional sftp source (running-config, startup-config). */
  sftpSource?(): RouterSftpSource | null;
  /** Optional reactive event bus from the SSH event subsystem. */
  events?: ISshServerEventBus;
  /** Optional banner text printed before authentication. */
  banner?(): string | null;
  /** Optional motd text printed after authentication. */
  motd?(): string;
  /** Optional record-login callback when a session is established. */
  recordLogin?(user: string, fromIp: string): void;
  /** Optional rate-limit gate. */
  isClientBlocked?(ip: string): boolean;
  /** Optional auth-failure hook for the audit log. */
  recordAuthFailure?(user: string, fromIp: string, reason: string): void;
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

  getShell(userCtx: SshUserContext, _cwd: string): ILinuxShell {
    const target = this.deps.execTarget();
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

  getMotd(): string {
    return this.deps.motd?.() ?? `Welcome to ${this.deps.hostname()}\n`;
  }

  getLastLogin(_user: string): string | null { return null; }

  recordLogin(user: string, fromIp: string): void {
    this.deps.recordLogin?.(user, fromIp);
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

  isClientBlocked(ip: string): boolean {
    return this.deps.isClientBlocked?.(ip) ?? false;
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
      // Public-key auth on routers is plumbed but always rejects until
      // `ip ssh pubkey-chain` / `ssh user authentication-type rsa` is
      // wired into NetworkOsCredentialStore — placeholder so the handler
      // surfaces the right "no key" message in the meantime.
      checkPublicKey: (_user, _publicKey) => false,
      getAttemptsRemaining: () => attemptsLeft,
      getAvailableMethods: (): readonly AuthMethodType[] => {
        const methods: AuthMethodType[] = [];
        if (this.config.passwordAuthentication) methods.push('password');
        return methods;
      },
    };
  }
}
