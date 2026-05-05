/**
 * WindowsSshServerContext — Adapter exposing a Windows machine to
 * SshServerHandler.
 *
 * Reference: DESIGN-SSH-SFTP.md section 8.
 */

import type { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';
import type { WindowsUserManager } from '@/network/devices/windows/WindowsUserManager';
import type { AuthMethodType, ISshAuthContext } from '../auth/ISshAuthMethod';
import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';
import { WindowsSftpFSAdapter } from '../sftp/WindowsSftpFSAdapter';
import { SshHostKey } from '../SshHostKey';
import { SshUserContext } from '../SshUserContext';
import {
  DEFAULT_SSH_SERVER_CONFIG,
  type ILinuxShell,
  type ISshServerContext,
  type SshServerConfig,
} from './ISshServerContext';

const DEFAULT_USER_UID = 1000;
const DEFAULT_USER_GID = 1000;
const ADMIN_UID = 0;
const ADMIN_GID = 0;

export class WindowsSshServerContext implements ISshServerContext {
  readonly hostKey: SshHostKey;
  readonly config: Readonly<SshServerConfig>;
  readonly auth: ISshAuthContext;

  constructor(
    private readonly wfs: WindowsFileSystem,
    private readonly userManager: WindowsUserManager,
    private readonly hostname: string,
    config: Partial<SshServerConfig> = {},
  ) {
    this.hostKey = SshHostKey.generate(hostname);
    this.config = Object.freeze({ ...DEFAULT_SSH_SERVER_CONFIG, ...config });
    this.auth = this.buildAuthContext();
  }

  getFilesystem(userCtx: SshUserContext): ISftpFileSystem {
    return new WindowsSftpFSAdapter(this.wfs, userCtx.uid, userCtx.gid);
  }

  getShell(_userCtx: SshUserContext, _cwd: string): ILinuxShell {
    return {
      execute(line: string) {
        return {
          stdout: `${line}: shell execution not yet wired\n`,
          stderr: '',
          exitCode: 0,
        };
      },
    };
  }

  getMotd(): string {
    return `Welcome to ${this.hostname}\n`;
  }

  getLastLogin(user: string): string | null {
    const entry = this.userManager.getUser(user);
    if (!entry || !entry.lastLogon) return null;
    return `Last login: ${entry.lastLogon.toUTCString()}`;
  }

  recordLogin(user: string, _fromIp: string): void {
    const entry = this.userManager.getUser(user);
    if (entry) entry.lastLogon = new Date();
  }

  /** Build a SshUserContext from the Windows user database. */
  buildUserContext(username: string): SshUserContext | null {
    const user = this.userManager.getUser(username);
    if (!user) return null;
    const isAdmin = this.userManager.setCurrentUser(username)
      ? this.userManager.isCurrentUserAdmin()
      : false;
    const uid = isAdmin ? ADMIN_UID : DEFAULT_USER_UID;
    const gid = isAdmin ? ADMIN_GID : DEFAULT_USER_GID;
    const home = `C:\\Users\\${user.name}`;
    return new SshUserContext(user.name, uid, gid, [], home);
  }

  // ─── private ─────────────────────────────────────────────────────

  private buildAuthContext(): ISshAuthContext {
    let attemptsLeft = this.config.maxAuthTries;
    return {
      checkPassword: (user, password) => {
        attemptsLeft = Math.max(0, attemptsLeft - 1);
        if (!this.config.passwordAuthentication) return false;
        return this.userManager.checkPassword(user, password);
      },
      // Public-key auth on Windows simulator: not modeled by WindowsUserManager
      // yet, so deny by default. Adding support is OCP: implement here.
      checkPublicKey: () => false,
      getAttemptsRemaining: () => attemptsLeft,
      getAvailableMethods: (): readonly AuthMethodType[] => {
        return this.config.passwordAuthentication ? ['password'] : [];
      },
    };
  }
}
