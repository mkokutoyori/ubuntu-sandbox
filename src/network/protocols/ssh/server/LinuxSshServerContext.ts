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

const AUTHORIZED_KEYS_PATH = (home: string): string =>
  `${home.replace(/\/$/, '')}/.ssh/authorized_keys`;

const LASTLOG_PATH = '/var/log/lastlog.json';

interface LastLoginEntry {
  user: string;
  ip: string;
  at: number;
}

export class LinuxSshServerContext implements ISshServerContext {
  readonly hostKey: SshHostKey;
  readonly config: Readonly<SshServerConfig>;
  readonly auth: ISshAuthContext;

  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly userManager: LinuxUserManager,
    private readonly hostname: string,
    config: Partial<SshServerConfig> = {},
  ) {
    this.hostKey = SshHostKey.generate(hostname);
    this.config = Object.freeze({ ...DEFAULT_SSH_SERVER_CONFIG, ...config });
    this.auth = this.buildAuthContext();
  }

  getFilesystem(userCtx: SshUserContext): ISftpFileSystem {
    return new LinuxSftpFSAdapter(this.vfs, userCtx.uid, userCtx.gid);
  }

  getShell(_userCtx: SshUserContext, _cwd: string): ILinuxShell {
    // Minimal placeholder shell. The real Linux command pipeline is async,
    // so we return a stub that the SSH layer can extend later by injecting
    // a proper LinuxShellSession wrapper.
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

  private buildAuthContext(): ISshAuthContext {
    let attemptsLeft = this.config.maxAuthTries;
    return {
      checkPassword: (user, password) => {
        attemptsLeft = Math.max(0, attemptsLeft - 1);
        if (!this.config.passwordAuthentication) return false;
        return this.userManager.checkPassword(user, password);
      },
      checkPublicKey: (user, publicKey) => {
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
}
