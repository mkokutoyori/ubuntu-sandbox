/**
 * WindowsSshServerContext — Adapter exposing a Windows machine to
 * SshServerHandler.
 *
 * Reference: DESIGN-SSH-SFTP.md section 8.
 */

import { guardedFileSystem, principalOf } from '@/network/devices/windows/WindowsFsAccess';
import { WINDOWS_OPENSSH_SSHD_CONFIG } from './WindowsSshdConfigFile';
import { simulationDate } from '@/network/core/SystemClock';

import { SSH_WINDOWS_IDENTIFICATION } from '../serverIdentification';
import type { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';
import type { WindowsUserManager } from '@/network/devices/windows/WindowsUserManager';
import type { AuthMethodType, ISshAuthContext } from '../auth/ISshAuthMethod';
import type { AgentPort } from '../agent/AgentService';
import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';
import { WindowsSftpFSAdapter } from '../sftp/WindowsSftpFSAdapter';
import { isInternalSftp, sftpProgramOf, type SftpLaunch, type SftpServicePlan } from './SftpServicePlan';
import { parseSftpServerArguments, SFTP_SERVER_USAGE, splitCommandWords } from '../sftp/server/SftpServerOptions';
import { SshHostKey } from '../SshHostKey';
import type { SshCertificate } from '../certificate/SshCertificate';
import { SshdCertificateService } from './SshdCertificateService';
import { certificateOfMaterial, plainKeyOfMaterial } from './UserCertificateAdmission';
import { SshUserContext } from '../SshUserContext';
import type { SshVtyShell } from './SshExecTarget';
import {
  DEFAULT_SSH_SERVER_CONFIG,
  SSHD_MAX_AUTH_TRIES_REASON,
  type HostCertificateBinding,
  type ILinuxShell,
  type ISshServerContext,
  type SshServerConfig,
  type SshTransportPolicy,
} from './ISshServerContext';
import { sshdAlgorithmPreferences } from './SshdAlgorithmDirectives';
import { SshdAccessPolicy } from './SshdAccessPolicy';
import { SshSyslogger } from '../logging/SshSyslogger';
import { SshServerEventBus, type ISshServerEventBus } from './SshServerEvent';
import { readSshdConfig } from './SshdConfigText';
import { findAdmittedKey, type AuthorizedKey, type KeySource } from '../SshPureUtils';
import type { AuthorizedKeyOptions } from '../SshPureUtils';
import { configuredHostKeyPaths, hostKeyFromFile, provisionHostKeyFiles, type HostKeyFileAccess } from './SshdHostKeyFiles';
import { handlerConfigOf, type SshdServerConfig } from './SshdServerConfig';

const DEFAULT_USER_UID = 1000;
const DEFAULT_USER_GID = 1000;
const ADMIN_UID = 0;
const ADMIN_GID = 0;

// OpenSSH-for-Windows path conventions.
const SSH_DIR = 'C:\\ProgramData\\ssh';
const SSHD_CONFIG_PATH = `${SSH_DIR}\\sshd_config`;
const HOST_KEY_PATH = `${SSH_DIR}\\ssh_host_ed25519_key`;
const DEFAULT_HOST_KEY_PATHS = ['rsa', 'ecdsa', 'ed25519'].map((type) => `${SSH_DIR}\\ssh_host_${type}_key`);
const HOST_KEY_PUB_PATH = `${SSH_DIR}\\ssh_host_ed25519_key.pub`;
const PROGRAM_DATA = 'C:\\ProgramData';

export function windowsPathOf(path: string): string {
  return path.replace(/__PROGRAMDATA__/g, PROGRAM_DATA).replace(/\//g, '\\');
}

export interface WindowsShellExecutor {
  executeCmdCommand(line: string): Promise<string>;
  /** Current cmd working directory — rendered as the `C:\…>` prompt. */
  getCwd?(): string;
  /**
   * A stacked CLI session for one SSH channel: cmd at the bottom, with
   * `powershell` and friends pushed on top server-side, so the client
   * only ever sees lines and a prompt
   * (docs/PRD-SSH-Unification.md §4bis B2).
   */
  createVtyShell?(user: string): SshVtyShell | null;
  shellBanner?(): string;
  runExecAs?(user: string, line: string, stdin?: string): Promise<{ output: string; exitCode: number }>;
  bindForwardedAgent?(user: string, agent: AgentPort): { readonly path: string; release(): void };
}

/**
 * Callback fired after every inbound SSH auth attempt — wired up by
 * WindowsPC so the Security event log records 4624 (logon success) /
 * 4625 (logon failure) at logon type 10 (RemoteInteractive), matching
 * what a real Windows host writes for an OpenSSH-for-Windows login.
 */
export type WindowsSshLogonReporter = (user: string, success: boolean) => void;

/**
 * Callback fired when an authenticated SSH session ends — paired with
 * the success branch of {@link WindowsSshLogonReporter}. Drives the
 * 4634 (Logoff) Security event so the audit trail mirrors what
 * `wevtutil qe Security` returns on a real Windows host once an SSH
 * client disconnects.
 */
export type WindowsSshLogoffReporter = (user: string) => void;

export class WindowsSshServerContext implements ISshServerContext {
  readonly hostKey: SshHostKey;
  readonly config: Readonly<SshServerConfig>;
  readonly auth: ISshAuthContext;
  readonly sshdConfig: SshdServerConfig;
  readonly maxAuthTriesDisconnect = SSHD_MAX_AUTH_TRIES_REASON;
  readonly rawConfig: string;
  private operationalSyslogger: SshSyslogger | null = null;
  readonly events: ISshServerEventBus = new SshServerEventBus();
  private readonly policy: SshdAccessPolicy;
  private readonly keyLogons = new Set<string>();

  constructor(
    private readonly wfs: WindowsFileSystem,
    private readonly userManager: WindowsUserManager,
    private readonly hostname: string,
    config: Partial<SshServerConfig> = {},
    private readonly shellExecutor: WindowsShellExecutor | null = null,
    private readonly reportLogon: WindowsSshLogonReporter | null = null,
    private readonly reportLogoff: WindowsSshLogoffReporter | null = null,
    private readonly legalNotice: (() => string) | null = null,
    private readonly operationalLog: ((message: string) => void) | null = null,
  ) {
    this.ensureSshDir();
    this.hostKey = this.loadOrGenerateHostKey();
    this.ensureSshdConfigFile();
    this.rawConfig = readSshdConfig({
      readFile: (path) => {
        const result = this.wfs.readFile(windowsPathOf(path));
        return result.ok ? result.content ?? '' : null;
      },
    }, SSHD_CONFIG_PATH);
    this.policy = SshdAccessPolicy.forText(
      this.rawConfig, (user) => this.userManager.getGroupsForUser(user).map((group) => group.name), true,
    );
    this.sshdConfig = this.policy.config;
    this.config = Object.freeze({
      ...DEFAULT_SSH_SERVER_CONFIG,
      ...handlerConfigOf(this.sshdConfig),
      ...config,
    });
    this.auth = this.buildAuthContext();
    if (this.operationalLog !== null) {
      const write = this.operationalLog;
      this.operationalSyslogger = new SshSyslogger(null, this.events, {
        hostname: this.hostname, port: this.sshdConfig.ports[0] ?? 22, logLevel: () => this.policy.config.logLevel,
        sink: (message) => write(message),
      });
    }
  }

  reloadConfig(): WindowsSshServerContext {
    return new WindowsSshServerContext(this.wfs, this.userManager, this.hostname, {}, this.shellExecutor, this.reportLogon, this.reportLogoff, this.legalNotice, this.operationalLog);
  }

  recordLogout(user: string, _fromIp: string): void {
    this.reportLogoff?.(user);
  }

  serverIdentification(): string {
    return SSH_WINDOWS_IDENTIFICATION;
  }

  transportPolicy(): SshTransportPolicy {
    const algorithms = sshdAlgorithmPreferences(this.wfs.readFile(SSHD_CONFIG_PATH).content ?? '');
    return Object.keys(algorithms).length === 0 ? {} : { algorithms };
  }

  getBanner(): string | null {
    if (!this.sshdConfig.bannerPath) return this.legalNotice?.() || null;
    const result = this.wfs.readFile(windowsPathOf(this.sshdConfig.bannerPath));
    return result.ok ? result.content ?? null : null;
  }

  bannerFor(user: string, clientIp: string): string | null {
    const path = this.policy.bannerPath(user, clientIp);
    if (path === null) return this.legalNotice?.() || null;
    const result = this.wfs.readFile(windowsPathOf(path));
    return result.ok ? result.content ?? null : null;
  }

  userPolicyRefusal(user: string, address: string): string | null {
    return this.policy.refusal(user, address);
  }

  maxAuthTriesFor(user: string, clientIp: string): number {
    return this.policy.maxAuthTries(user, clientIp);
  }

  authMethodEnabled(user: string, clientIp: string, method: 'password' | 'publickey' | 'keyboard-interactive'): boolean {
    return this.policy.methodEnabled(user, clientIp, method);
  }

  availableMethodsFor(user: string, clientIp: string): readonly AuthMethodType[] {
    return this.policy.availableMethods(user, clientIp, {
      publickey: this.config.pubkeyAuthentication, password: this.config.passwordAuthentication, keyboardInteractive: false,
    });
  }

  originalCommandLine(forced: string, asked: string): string {
    return asked === '' ? forced : `set "SSH_ORIGINAL_COMMAND=${asked}"&& ${forced}`;
  }

  forcedCommand(user: SshUserContext, clientIp: string, keyOptions: AuthorizedKeyOptions | null): string | null {
    return this.policy.forceCommand(user.username, clientIp) ?? keyOptions?.command ?? null;
  }

  sftpService(
    user: SshUserContext, clientIp: string, launch: SftpLaunch, keyOptions: AuthorizedKeyOptions | null,
  ): SftpServicePlan {
    const subsystems = this.policy.config.subsystems;
    const forced = this.forcedCommand(user, clientIp, keyOptions);
    let commandLine: string;
    if (forced !== null) {
      commandLine = forced;
    } else if (launch.kind === 'command') {
      commandLine = launch.command;
    } else {
      const configured = launch.name === 'sftp' ? subsystems.sftp : subsystems.extras.get(launch.name) ?? null;
      if (configured === null || launch.name !== 'sftp') return { kind: 'unavailable' };
      commandLine = configured;
    }
    const serve = (program: 'sftp-server' | 'internal-sftp'): SftpServicePlan => {
      const parsed = parseSftpServerArguments(splitCommandWords(commandLine).slice(1));
      if (parsed.kind === 'serve') return { kind: 'serve', program, options: parsed.options, diagnostics: parsed.diagnostics };
      if (parsed.kind === 'fatal') return { kind: 'exits', stdout: '', stderr: `${parsed.message}\n`, exitCode: 255 };
      return { kind: 'exits', stdout: '', stderr: `${SFTP_SERVER_USAGE}\n`, exitCode: 1 };
    };
    if (isInternalSftp(commandLine)) return serve('internal-sftp');
    const program = commandLine.trim().split(/\s+/)[0] ?? '';
    const bare = !/[\\/]/.test(program);
    const candidate = bare
      ? `C:\\Windows\\System32\\OpenSSH\\${/\.exe$/i.test(program) ? program : `${program}.exe`}`
      : windowsPathOf(program);
    if (!this.wfs.exists(candidate)) {
      return launch.kind === 'subsystem'
        ? { kind: 'unavailable' }
        : { kind: 'exits', stdout: '', stderr: `'${program}' is not recognized as an internal or external command,\noperable program or batch file.\n`, exitCode: 1 };
    }
    if (sftpProgramOf(program) === 'sftp-server') return serve('sftp-server');
    const exec = this.shellExecutor;
    if (exec === null) return { kind: 'unavailable' };
    return {
      kind: 'runs',
      run: async () => {
        const output = await exec.executeCmdCommand(commandLine);
        return { stdout: output, stderr: '', exitCode: 0 };
      },
    };
  }

  admittedKey(user: string, publicKey: string, source: KeySource): AuthorizedKey | null {
    if (this.policy.refusal(user, source.ip) !== null) return null;
    if (!this.config.pubkeyAuthentication || !this.policy.methodEnabled(user, source.ip, 'publickey')) return null;
    if (!this.userManager.getUser(user)) return null;
    const home = `C:\\Users\\${user}`;
    const certificate = certificateOfMaterial(publicKey);
    if (certificate !== null) return this.admittedCertificate(user, home, certificate, source);
    const plain = plainKeyOfMaterial(publicKey);
    if (plain !== null && this.certificates().revocationRefusal(user, plain, source) !== null) return null;
    for (const entry of this.policy.view(user, source.ip).authorizedKeysFile) {
      const path = this.authorizedKeysPath(entry, user, home);
      const result = this.wfs.readFile(path);
      if (!result.ok || !result.content) continue;
      const admitted = findAdmittedKey(result.content, publicKey, source);
      if (admitted !== null) {
        this.keyLogons.add(`${user}@${source.ip}`);
        return admitted;
      }
    }
    return null;
  }

  private certificateService: SshdCertificateService | null = null;

  private certificates(): SshdCertificateService {
    this.certificateService ??= new SshdCertificateService({
      config: () => this.policy.config,
      groupsOf: (user) => this.userManager.getGroupsForUser(user).map((group) => group.name),
      readFile: (path) => {
        const result = this.wfs.readFile(windowsPathOf(path));
        return result.ok ? result.content ?? '' : null;
      },
      emit: (event) => this.events.emit(event),
    });
    return this.certificateService;
  }

  private admittedCertificate(user: string, home: string, certificate: SshCertificate, source: KeySource): AuthorizedKey | null {
    let authorizedKeys: { path: string; text: string } | null = null;
    for (const entry of this.policy.view(user, source.ip).authorizedKeysFile) {
      const path = this.authorizedKeysPath(entry, user, home);
      const result = this.wfs.readFile(path);
      if (result.ok && result.content) { authorizedKeys = { path, text: result.content }; break; }
    }
    const admitted = this.certificates().admit(user, { uid: 0, home }, certificate, source, authorizedKeys);
    if (admitted !== null) this.keyLogons.add(`${user}@${source.ip}`);
    return admitted;
  }

  hostCertificates(): HostCertificateBinding[] {
    return this.certificates().hostCertificates([this.hostKey, ...this.additionalHostKeys()]);
  }

  private authorizedKeysPath(entry: string, user: string, home: string): string {
    const expanded = windowsPathOf(entry.replace(/%h/g, home).replace(/%u/g, user).replace(/%%/g, '%'));
    return /^[A-Za-z]:\\/.test(expanded) ? expanded : `${home}\\${expanded}`;
  }

  getFilesystem(userCtx: SshUserContext): ISftpFileSystem {
    return new WindowsSftpFSAdapter(
      guardedFileSystem(this.wfs, principalOf(this.userManager, userCtx.username)), userCtx.uid, userCtx.gid);
  }

  getShell(_userCtx: SshUserContext, _cwd: string, opts?: Parameters<ISshServerContext['getShell']>[2]): ILinuxShell {
    const exec = this.shellExecutor;
    const forwardedAgent = opts?.agent === undefined ? null : exec?.bindForwardedAgent?.(_userCtx.username, opts.agent) ?? null;

    if (opts?.exec !== undefined && exec?.runExecAs !== undefined) {
      const runExecAs = exec.runExecAs.bind(exec);
      return {
        async execute(line: string, _onProgress?: (text: string) => void, stdin?: string) {
          const result = await runExecAs(_userCtx.username, line, stdin);
          return {
            stdout: result.output === '' || result.output.endsWith('\n') ? result.output : `${result.output}\n`,
            stderr: '',
            exitCode: result.exitCode,
          };
        },
        posixShell: false,
        loginShellKind: 'cmd',
        ...(forwardedAgent === null ? {} : { dispose: () => forwardedAgent.release() }),
      };
    }

    const vty = exec?.createVtyShell?.(_userCtx.username);
    if (vty) {
      return {
        async execute(line: string) {
          const stdout = await vty.execute(line);
          return {
            stdout: stdout.endsWith('\n') || stdout === '' ? stdout : `${stdout}\n`,
            stderr: '',
            exitCode: vty.lastExitCode?.() ?? 0,
            clearScreen: vty.lastClearedScreen?.() ?? false,
            pendingInput: vty.lastPendingInput?.() ?? undefined,
            sessionEnded: vty.lastEndedSession?.() ?? false,
          };
        },
        provideInput: vty.handleInput
          ? async (value: string) => {
              const stdout = await vty.handleInput!(value);
              return {
                stdout: stdout.endsWith('\n') || stdout === '' ? stdout : `${stdout}\n`,
                stderr: '',
                exitCode: vty.lastExitCode?.() ?? 0,
                clearScreen: vty.lastClearedScreen?.() ?? false,
                pendingInput: vty.lastPendingInput?.() ?? undefined,
                sessionEnded: vty.lastEndedSession?.() ?? false,
              };
            }
          : undefined,
        getPrompt: () => vty.getPrompt(),
        getCompletions: vty.getCompletions ? (line: string) => vty.getCompletions!(line) : undefined,
        isNested: vty.isNested ? () => vty.isNested!() : undefined,
        // cmd.exe ignores Ctrl+D and has no `clear` — it has `cls`.
        posixShell: false,
        loginShellKind: 'cmd',
        ...(forwardedAgent === null ? {} : { dispose: () => forwardedAgent.release() }),
      };
    }

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
      getPrompt: exec.getCwd ? () => `${exec.getCwd!()}>` : undefined,
      ...(forwardedAgent === null ? {} : { dispose: () => forwardedAgent.release() }),
    };
  }

  agentForwardingPermitted(user: SshUserContext, clientIp: string, keyOptions: AuthorizedKeyOptions | null): boolean {
    if (keyOptions?.noAgentForwarding === true) return false;
    return this.policy.agentForwarding(user.username, clientIp);
  }

  ptyPermitted(user: SshUserContext, clientIp: string, keyOptions: AuthorizedKeyOptions | null): boolean {
    if (keyOptions?.noPty === true) return false;
    return this.policy.permitsTty(user.username, clientIp);
  }

  getMotd(): string {
    const banner = this.shellExecutor?.shellBanner?.();
    return banner !== undefined ? `${banner}\n` : `Welcome to ${this.hostname}\n`;
  }

  getLastLogin(user: string): string | null {
    const entry = this.userManager.getUser(user);
    if (!entry || !entry.lastLogon) return null;
    return `Last login: ${entry.lastLogon.toUTCString()}`;
  }

  recordLogin(user: string, fromIp: string): void {
    const entry = this.userManager.getUser(user);
    if (entry) entry.lastLogon = simulationDate();
    if (this.keyLogons.delete(`${user}@${fromIp}`)) this.reportLogon?.(user, true);
  }

  recordAuthFailure(user: string, _fromIp: string, reason: string): void {
    if (reason === 'publickey' || reason === 'wrong_key') this.reportLogon?.(user, false);
  }

  /** Build a SshUserContext from the Windows user database. */
  buildUserContext(username: string): SshUserContext | null {
    const user = this.userManager.getUser(username);
    if (!user) return null;
    const isAdmin = this.userManager.isAdmin(user.name);
    const uid = isAdmin ? ADMIN_UID : DEFAULT_USER_UID;
    const gid = isAdmin ? ADMIN_GID : DEFAULT_USER_GID;
    const home = `C:\\Users\\${user.name}`;
    // Built-in accounts (Administrator) and runtime-added users may not
    // have had their profile seeded by WindowsFileSystem.init(). Real
    // Windows materialises the profile on first interactive logon —
    // mirror that so the SSH'd user lands in a directory that exists.
    if (!this.wfs.exists(home)) {
      for (const sub of ['', '\\Desktop', '\\Documents', '\\Downloads']) {
        this.wfs.mkdirp(home + sub);
      }
      this.wfs.seedProfileAcl(user.name);
    }
    return new SshUserContext(user.name, uid, gid, [], home);
  }

  // ─── private ─────────────────────────────────────────────────────

  private ensureSshDir(): void {
    if (!this.wfs.exists(SSH_DIR)) {
      this.wfs.mkdirp(SSH_DIR);
    }
  }

  private hostKeyFiles(): HostKeyFileAccess {
    return {
      exists: (path) => this.wfs.exists(path),
      read: (path) => {
        const result = this.wfs.readFile(path);
        return result.ok ? result.content ?? null : null;
      },
      write: (path, content, secret) => {
        this.wfs.createFile(path, content);
        if (secret) this.wfs.restrictToSystemAndAdministrators(path);
      },
      writeDeferred: (path, produce, secret, declaredSize) => {
        this.wfs.createDeferredFile(path, produce, declaredSize);
        if (secret) this.wfs.restrictToSystemAndAdministrators(path);
      },
    };
  }

  additionalHostKeys(): SshHostKey[] {
    const rawConfig = this.wfs.readFile(SSHD_CONFIG_PATH).content ?? '';
    const paths = configuredHostKeyPaths(rawConfig, DEFAULT_HOST_KEY_PATHS).map((path) => path.replace(/\//g, '\\'));
    return paths
      .filter((path) => path.toLowerCase() !== HOST_KEY_PATH.toLowerCase())
      .flatMap((path) => hostKeyFromFile(this.hostKeyFiles(), path) ?? []);
  }

  private loadOrGenerateHostKey(): SshHostKey {
    provisionHostKeyFiles(this.hostKeyFiles(), SSH_DIR, '\\', this.hostname);
    const pub = this.wfs.readFile(HOST_KEY_PUB_PATH).content ?? '';
    const priv = this.wfs.readFile(HOST_KEY_PATH).content ?? '';
    return SshHostKey.fromFiles(pub.trim().split(/\s+/)[1] ?? pub.trim(), priv.trim(), 'ssh-ed25519');
  }

  private ensureSshdConfigFile(): void {
    const result = this.wfs.readFile(SSHD_CONFIG_PATH);
    if (!(result.ok && result.content)) this.wfs.createFile(SSHD_CONFIG_PATH, WINDOWS_OPENSSH_SSHD_CONFIG);
  }

  private userAllowed(user: string): boolean {
    return this.policy.refusal(user) === null;
  }

  private buildAuthContext(): ISshAuthContext {
    let attemptsLeft = this.config.maxAuthTries;
    return {
      checkPassword: (user, password) => {
        attemptsLeft = Math.max(0, attemptsLeft - 1);
        if (!this.userAllowed(user)) { this.reportLogon?.(user, false); return false; }
        if (!this.config.passwordAuthentication) { this.reportLogon?.(user, false); return false; }
        // logonType 10 (RemoteInteractive) — checkPassword itself now
        // publishes the one and only windows.account.logon for this
        // attempt (PRD-Winlogon.md §1.2 point 1); no separate
        // reportLogon call here, or SSH would double-publish 4624/4625.
        return this.userManager.checkPassword(user, password, 10);
      },
      // BRD SSH-03-R6: public-key authentication on Windows OpenSSH stores
      // authorized_keys per-user under C:\Users\<user>\.ssh\. Each line is
      // `<algorithm> <material> [<comment>]`. We accept a successful match
      // when both algorithm and material agree.
      checkPublicKey: (user, publicKey) => this.admittedKey(user, publicKey, { ip: '' }) !== null,
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
