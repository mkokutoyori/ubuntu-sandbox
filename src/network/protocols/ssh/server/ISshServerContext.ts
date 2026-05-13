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
  recordAuthFailure?(user: string, fromIp: string, reason: string): void;
}

export const DEFAULT_SSH_SERVER_CONFIG: SshServerConfig = Object.freeze({
  listenPort: 22,
  maxAuthTries: 6,
  permitRootLogin: true,
  passwordAuthentication: true,
  pubkeyAuthentication: true,
});
