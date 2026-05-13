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
  readonly permitRootLogin: boolean;
  readonly passwordAuthentication: boolean;
  readonly pubkeyAuthentication: boolean;
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
}

export const DEFAULT_SSH_SERVER_CONFIG: SshServerConfig = Object.freeze({
  listenPort: 22,
  maxAuthTries: 6,
  permitRootLogin: true,
  passwordAuthentication: true,
  pubkeyAuthentication: true,
});
