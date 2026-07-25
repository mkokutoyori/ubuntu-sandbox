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
import type { SshInteractiveShell } from './SshInteractiveShell';
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
  readonly loginGraceTime?: number;
  readonly maxStartups?: { readonly start: number; readonly rate: number; readonly full: number };
}

export interface ILinuxShell {
  execute(line: string): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /**
   * Tab-completion candidates for a partial line, answered in this
   * shell's own context (its cwd, its CLI mode). Absent means the
   * remote offers no completion (docs/PRD-SSH-Unification.md §4bis B1).
   */
  getCompletions?(line: string): string[];
  /**
   * True when `?` is a help key on this remote rather than an ordinary
   * character — a network CLI, not a POSIX shell where `?` is a glob.
   * Lets a client offer inline help without breaking `ls ?.txt`.
   */
  readonly supportsInlineHelp?: boolean;
  /**
   * The remote's own prompt as it stands right now. Read after each line,
   * since the command may have changed it (`cd`, `enable`,
   * `configure terminal`). Optional: a context that omits it leaves the
   * client rendering its own prompt exactly as before
   * (docs/PRD-SSH-Unification.md §3.1).
   */
  getPrompt?(): string;
  /** Release any per-session resources (e.g. a real LinuxShellSession's `-bash` process table entry). */
  dispose?(): void;
}

export interface ISshServerContext {
  readonly hostKey: SshHostKey;
  readonly config: Readonly<SshServerConfig>;
  readonly auth: ISshAuthContext;
  getFilesystem(userCtx: SshUserContext): ISftpFileSystem;
  /**
   * @param opts.interactive True for a persistent `shell_open`/`shell_input`
   * channel (a real pty — colorized output, hung-up on close); false/omitted
   * for a one-shot `exec` (no pty — no color, exits gracefully). Only
   * Linux's implementation currently distinguishes the two.
   */
  getShell(userCtx: SshUserContext, cwd: string, opts?: { interactive?: boolean }): ILinuxShell;
  /**
   * Optional per-channel real-time job runtime (streaming `ping`, Ctrl+C
   * interrupt). SshServerHandler constructs one per `shell_open` and tries
   * it before falling back to `getShell().execute()` for every line. Only
   * Linux implements this; Cisco/Huawei/Windows remote shells are
   * unaffected and always use the plain one-shot `getShell()` path.
   */
  createInteractiveShell?(userCtx: SshUserContext): SshInteractiveShell | null;
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
