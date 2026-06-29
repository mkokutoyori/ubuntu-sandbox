/**
 * ISshServerContext — contract every device implements to host an SSH server.
 *
 * The handler depends on this interface, not on concrete devices: Linux,
 * Windows or any future device only need to provide an adapter.
 *
 * Reference: DESIGN-SSH-SFTP.md section 8.
 */

import type { ISshAuthContext } from '../auth/ISshAuthMethod';
import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';
import type { SshHostKey } from '../SshHostKey';
import type { SshUserContext } from '../SshUserContext';
import type { ISshServerEventBus } from './SshServerEvent';
export type { SshUserContext };

export interface SshServerConfig {
  readonly listenPort: number;
  readonly maxAuthTries: number;
  readonly maxSessions?: number;
  readonly permitRootLogin: boolean;
  readonly passwordAuthentication: boolean;
  readonly pubkeyAuthentication: boolean;
  readonly clientAliveInterval?: number;
  readonly clientAliveCountMax?: number;
}

export interface ILinuxShell {
  execute(line: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export interface ISshServerContext {
  readonly hostKey: SshHostKey;
  readonly config: Readonly<SshServerConfig>;
  readonly auth: ISshAuthContext;
  getFilesystem(userCtx: SshUserContext): ISftpFileSystem;
  getShell(userCtx: SshUserContext, cwd: string): ILinuxShell;
  getMotd(): string;
  getLastLogin(user: string): string | null;
  recordLogin(user: string, fromIp: string): void;
  /**
   * Optional logout hook fired by SshServerHandler when an authenticated
   * session ends (channel close, client disconnect, or transport drop).
   * Implementations append to /var/log/wtmp.json on Linux and publish
   * `windows.account.logoff` on Windows so the Security event log
   * receives 4634 in addition to the 4624/4625 it already gets.
   */
  recordLogout?(user: string, fromIp: string): void;
  /**
   * Optional auth-failure hook used by SshServerHandler when the handshake or
   * password/pubkey check is rejected (analysis doc §1.4/§1.5). Implementations
   * append to /var/log/auth.log and /var/log/btmp.json.
   */
  recordAuthFailure?(user: string, fromIp: string, reason: string): void;
  /**
   * Build a fully-populated SshUserContext from /etc/passwd (real uid/gid/groups/home).
   * Returns null when the user does not exist on this system.
   */
  buildUserContext(username: string): SshUserContext | null;
  /**
   * Optional reactive event bus. When provided, SshServerHandler uses it
   * instead of allocating its own, so reactive subscribers attached to the
   * context (logger, throttler) see every event.
   */
  readonly events?: ISshServerEventBus;
  /**
   * Optional rate-limit gate. Returning true makes SshServerHandler refuse
   * authentication attempts from the given IP without consulting `auth`.
   */
  isClientBlocked?(ip: string): boolean;
  /**
   * Optional empty-password gate. Used by the handler before delegating to
   * `auth.checkPassword`. Defaults to "rejected" when not implemented.
   */
  permitEmptyPasswords?(): boolean;
  /**
   * Pre-auth banner text from sshd_config's `Banner` file directive.
   * The handler surfaces it in the protocol-hello reply so clients can
   * display it before prompting for credentials (real OpenSSH emits
   * SSH_MSG_USERAUTH_BANNER).
   */
  getBanner?(): string | null;
}

export const DEFAULT_SSH_SERVER_CONFIG: SshServerConfig = Object.freeze({
  listenPort: 22,
  maxAuthTries: 6,
  permitRootLogin: true,
  passwordAuthentication: true,
  pubkeyAuthentication: true,
});
