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
import {
  DEFAULT_SSHD_CONFIG,
  parseSshdConfig,
  serializeSshdConfig,
  type SshdConfig,
} from './SshSshdConfig';

const DEFAULT_USER_UID = 1000;
const DEFAULT_USER_GID = 1000;
const ADMIN_UID = 0;
const ADMIN_GID = 0;

// OpenSSH-for-Windows path conventions.
const SSH_DIR = 'C:\\ProgramData\\ssh';
const SSHD_CONFIG_PATH = `${SSH_DIR}\\sshd_config`;
const HOST_KEY_PATH = `${SSH_DIR}\\ssh_host_ed25519_key`;
const HOST_KEY_PUB_PATH = `${SSH_DIR}\\ssh_host_ed25519_key.pub`;

export interface WindowsShellExecutor {
  executeCmdCommand(line: string): Promise<string>;
}

/**
 * Callback fired after every inbound SSH auth attempt — wired up by
 * WindowsPC so the Security event log records 4624 (logon success) /
 * 4625 (logon failure) at logon type 10 (RemoteInteractive), matching
 * what a real Windows host writes for an OpenSSH-for-Windows login.
 */
export type WindowsSshLogonReporter = (user: string, success: boolean) => void;

export class WindowsSshServerContext implements ISshServerContext {
  readonly hostKey: SshHostKey;
  readonly config: Readonly<SshServerConfig>;
  readonly auth: ISshAuthContext;
  readonly sshdConfig: SshdConfig;

  constructor(
    private readonly wfs: WindowsFileSystem,
    private readonly userManager: WindowsUserManager,
    private readonly hostname: string,
    config: Partial<SshServerConfig> = {},
    private readonly shellExecutor: WindowsShellExecutor | null = null,
    private readonly reportLogon: WindowsSshLogonReporter | null = null,
  ) {
    this.ensureSshDir();
    this.hostKey = this.loadOrGenerateHostKey();
    this.sshdConfig = this.loadOrGenerateSshdConfig();
    this.config = Object.freeze({
      ...DEFAULT_SSH_SERVER_CONFIG,
      ...this.sshdConfig,
      ...config,
    });
    this.auth = this.buildAuthContext();
  }

  reloadConfig(): WindowsSshServerContext {
    return new WindowsSshServerContext(this.wfs, this.userManager, this.hostname, {}, this.shellExecutor, this.reportLogon);
  }

  getBanner(): string | null {
    if (!this.sshdConfig.banner) return null;
    const result = this.wfs.readFile(this.sshdConfig.banner);
    return result.ok ? result.content ?? null : null;
  }

  getFilesystem(userCtx: SshUserContext): ISftpFileSystem {
    return new WindowsSftpFSAdapter(this.wfs, userCtx.uid, userCtx.gid);
  }

  getShell(_userCtx: SshUserContext, _cwd: string): ILinuxShell {
    const exec = this.shellExecutor;
    if (!exec) {
      return {
        async execute(line: string) {
          return {
            stdout: `${line}: shell execution not yet wired\n`,
            stderr: '',
            exitCode: 0,
          };
        },
      };
    }
    return {
      async execute(line: string) {
        const stdout = await exec.executeCmdCommand(line);
        const looksLikeError =
          /is not recognized|denied|Access is denied|Permission denied/i.test(stdout);
        return {
          stdout: stdout.endsWith('\n') ? stdout : stdout + '\n',
          stderr: '',
          exitCode: looksLikeError ? 1 : 0,
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

  private ensureSshDir(): void {
    if (!this.wfs.exists(SSH_DIR)) {
      this.wfs.mkdirp(SSH_DIR);
    }
  }

  private loadOrGenerateHostKey(): SshHostKey {
    const pubResult = this.wfs.readFile(HOST_KEY_PUB_PATH);
    const privResult = this.wfs.readFile(HOST_KEY_PATH);
    if (pubResult.ok && privResult.ok && pubResult.content && privResult.content) {
      const material = pubResult.content.trim().split(/\s+/)[1] ?? pubResult.content.trim();
      return SshHostKey.fromFiles(material, privResult.content.trim(), 'ssh-ed25519');
    }
    const generated = SshHostKey.generate(this.hostname);
    this.wfs.createFile(HOST_KEY_PUB_PATH, generated.publicKeyLine + '\n');
    this.wfs.createFile(
      HOST_KEY_PATH,
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${generated.publicKey}\n-----END OPENSSH PRIVATE KEY-----\n`,
    );
    return generated;
  }

  private loadOrGenerateSshdConfig(): SshdConfig {
    const result = this.wfs.readFile(SSHD_CONFIG_PATH);
    if (result.ok && result.content) return parseSshdConfig(result.content);
    this.wfs.createFile(SSHD_CONFIG_PATH, serializeSshdConfig(DEFAULT_SSHD_CONFIG));
    return DEFAULT_SSHD_CONFIG;
  }

  private userAllowed(user: string): boolean {
    const allow = this.sshdConfig.allowUsers;
    if (allow.length === 0) return true;
    return allow.some((pattern) => matchesUserPattern(pattern, user));
  }

  private buildAuthContext(): ISshAuthContext {
    let attemptsLeft = this.config.maxAuthTries;
    return {
      checkPassword: (user, password) => {
        attemptsLeft = Math.max(0, attemptsLeft - 1);
        if (!this.userAllowed(user)) { this.reportLogon?.(user, false); return false; }
        if (!this.config.passwordAuthentication) { this.reportLogon?.(user, false); return false; }
        const ok = this.userManager.checkPassword(user, password);
        this.reportLogon?.(user, ok);
        return ok;
      },
      // BRD SSH-03-R6: public-key authentication on Windows OpenSSH stores
      // authorized_keys per-user under C:\Users\<user>\.ssh\. Each line is
      // `<algorithm> <material> [<comment>]`. We accept a successful match
      // when both algorithm and material agree.
      checkPublicKey: (user, publicKey) => {
        const fail = () => { this.reportLogon?.(user, false); return false; };
        if (!this.userAllowed(user)) return fail();
        if (!this.config.pubkeyAuthentication) return fail();
        if (!this.userManager.getUser(user)) return fail();
        const path = `C:\\Users\\${user}\\.ssh\\authorized_keys`;
        const result = this.wfs.readFile(path);
        if (!result.ok || !result.content) return fail();
        const ok = result.content
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'))
          .some((line) => {
            const parts = line.split(/\s+/);
            return parts.length >= 2 && parts[1] === publicKey;
          });
        this.reportLogon?.(user, ok);
        return ok;
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
