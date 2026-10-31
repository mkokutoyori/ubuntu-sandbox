/**
 * LinuxSshServerContext — Adapter exposing a Linux machine to SshServerHandler.
 *
 * Wires together: VirtualFileSystem (data), LinuxUserManager (auth + uid
 * lookup) and the host name (for the deterministic host key). Instantiated
 * by LinuxMachine when starting sshd.
 *
 * Reference: DESIGN-SSH-SFTP.md section 8.
 */


import { simulationNowMs } from '@/network/core/SystemClock';
import { readSshdConfig } from './SshdConfigText';
import { UBUNTU_2204_SSHD_CONFIG } from './UbuntuSshdConfigFile';
import { hostnameOf, type HostnameSource } from '@/network/devices/linux/KernelHostname';
import { bashPromptParts, formatBashPrompt } from '@/network/devices/linux/shell/BashPrompt';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import type { LinuxUserManager } from '@/network/devices/linux/LinuxUserManager';
import type { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';
import { LinuxMachine } from '@/network/devices/LinuxMachine';
import type { AuthMethodType, ISshAuthContext, SshPeer } from '../auth/ISshAuthMethod';
import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';
import { LinuxSftpFSAdapter } from '../sftp/LinuxSftpFSAdapter';
import type { SftpAccountNames } from '../sftp/SftpWireSession';
import { ChrootedSftpFileSystem } from '../sftp/ChrootedSftpFileSystem';
import { SshHostKey } from '../SshHostKey';
import { certificateOfMaterial, plainKeyOfMaterial } from './UserCertificateAdmission';
import { SshdCertificateService } from './SshdCertificateService';
import { SshUserContext } from '../SshUserContext';
import {
  DEFAULT_SSH_SERVER_CONFIG,
  SSHD_MAX_AUTH_TRIES_REASON,
  type ILinuxShell,
  type ISshServerContext,
  type SshServerConfig,
} from './ISshServerContext';
import {
  SshServerEventBus,
  type ISshServerEventBus,
} from './SshServerEvent';
import { SshSyslogger } from '../logging/SshSyslogger';
import { SshdPam } from './SshdPam';
import { SshdServerConfig, handlerConfigOf } from './SshdServerConfig';
import type {
  DirectTcpipOutcome, DirectTcpipRequest, HostCertificateBinding, RemoteForwardOutcome, RemoteForwardRequest, SshTransportPolicy,
} from './ISshServerContext';
import { parseRekeyLimit } from '../transport/RekeyLimit';
import { sshdAlgorithmPreferences } from './SshdAlgorithmDirectives';
import { configuredHostKeyPaths, hostKeyFromFile, provisionHostKeyFiles, type HostKeyFileAccess } from './SshdHostKeyFiles';
import {
  findAdmittedKey, permitOpenAllows, sshWildcardMatches,
  type AuthorizedKey, type AuthorizedKeyOptions, type KeySource,
} from '../SshPureUtils';
import { parseDialAddress, socketStream } from '@/network/tcp/dial';
import { isDialFailure } from '@/network/tcp/types';
import { PortNumber } from '@/network/core/ports/PortNumber';
import { Fail2banAgent } from '../security/Fail2banAgent';
import { SshdAccessPolicy } from './SshdAccessPolicy';
import { isInternalSftp, sftpProgramOf, type SftpLaunch, type SftpServicePlan } from './SftpServicePlan';
import { parseSftpServerArguments, SFTP_SERVER_USAGE, splitCommandWords } from '../sftp/server/SftpServerOptions';
import { SshInteractiveShell } from './SshInteractiveShell';
import { SubShellStack, type SubShellStackStep } from '@/shell/SubShellStack';
import { NestedSshLogin, type NestedSshLaunch } from '@/shell/NestedSshLogin';
import { firstConfiguredIp } from '@/network/protocols/ssh/sessionLiveness';
import type { Equipment } from '@/network/equipment/Equipment';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';
import { openFullScreenProgram } from '@/network/devices/linux/editors/FullScreenPrograms';
import { installDefaultEditors } from '@/network/devices/linux/editors/registerEditors';
import { SSHD_LISTEN_BACKLOG } from '@/network/devices/linux/ports/ListenBacklogs';
import { formatLoginDate } from '../loginBanner';

const AUTHORIZED_KEYS_PATH = (home: string): string =>
  `${home.replace(/\/$/, '')}/.ssh/authorized_keys`;


const SSHD_CONFIG_PATH = '/etc/ssh/sshd_config';
const FAIL2BAN_JAIL_LOCAL_PATH = '/etc/fail2ban/jail.local';
const DEFAULT_FAIL2BAN_JAIL_LOCAL =
  '[sshd]\nenabled = true\nmaxretry = 5\nbantime = 300\nfindtime = 60\n';
const HOST_KEY_PATH = '/etc/ssh/ssh_host_ed25519_key';
const HOST_KEY_PUB_PATH = '/etc/ssh/ssh_host_ed25519_key.pub';
const DEFAULT_HOST_KEY_PATHS = [
  '/etc/ssh/ssh_host_rsa_key', '/etc/ssh/ssh_host_ecdsa_key', '/etc/ssh/ssh_host_ed25519_key',
];
const ETC_SSH_DIR = '/etc/ssh';
const SSHD_CONFIG_DROP_IN_DIR = '/etc/ssh/sshd_config.d';

/** Render a sub-shell's output lines the way the wire expects stdout. */
function joinLines(lines: readonly string[]): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n';
}


export interface LinuxSshServerContextOptions {
  /** Pre-wired event bus. If omitted a fresh one is created. */
  bus?: ISshServerEventBus;
  /** Enable /var/log/auth.log production. Default: true. */
  enableSyslog?: boolean;
  fail2ban?: Fail2banAgent | null;
  /**
   * The LinuxMachine this context serves. Passed through to
   * `createInteractiveShell()` so SshServerHandler can offer real-time
   * streaming (`ping`) over an interactive shell channel. Omitted by tests
   * that construct a bare context without a full device — those simply
   * don't get streaming (createInteractiveShell returns null).
   */
  device?: unknown;
}

export class LinuxSshServerContext implements ISshServerContext {
  readonly hostKey: SshHostKey;
  readonly config: Readonly<SshServerConfig>;
  readonly auth: ISshAuthContext;
  readonly sshdConfig: SshdServerConfig;
  readonly events: ISshServerEventBus;
  readonly fail2ban: Fail2banAgent | null;
  private readonly syslogger: SshSyslogger | null;
  readonly rawConfig: string;
  readonly maxAuthTriesDisconnect = SSHD_MAX_AUTH_TRIES_REASON;
  private cachedEffective: SshdServerConfig | null = null;
  private cachedPolicy: SshdAccessPolicy | null = null;
  private readonly device: unknown;
  private readonly rootLoginOverride: boolean | undefined;

  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly userManager: LinuxUserManager,
    private readonly hostnameSource: HostnameSource,
    config: Partial<SshServerConfig> = {},
    private readonly executor: LinuxCommandExecutor | null = null,
    /**
     * Optional callback running through the device's full command pipeline
     * (network / service / bash). Used by LinuxMachine to route remote
     * shells through `executeCommand`, which covers `ip`, `arp`, `ping`
     * and the systemctl family in addition to the bash interpreter.
     */
    private readonly fullExecutor:
      | ((line: string) => Promise<string>)
      | null = null,
    opts: LinuxSshServerContextOptions = {},
  ) {
    this.ensureEtcSshFiles();
    this.hostKey = this.loadOrGenerateHostKey();
    this.sshdConfig = this.loadOrGenerateSshdConfig();
    this.config = Object.freeze({
      ...DEFAULT_SSH_SERVER_CONFIG,
      ...handlerConfigOf(this.sshdConfig),
      ...config,
    });
    this.auth = this.buildAuthContext();
    this.events = opts.bus ?? new SshServerEventBus();
    this.events.on('auth_success', (event) => {
      if (event.kind === 'auth_success' && this.device instanceof LinuxMachine) {
        this.device.sshConnectionAuthenticated(event.ip, event.port, event.user);
      }
    });
    this.device = opts.device ?? null;
    this.rootLoginOverride = config.permitRootLogin;

    // Reactive subsystems: each one is independent and only needs the bus.
    this.syslogger = (opts.enableSyslog ?? true)
      ? new SshSyslogger(this.vfs, this.events, {
          hostname: this.hostnameSource,
          port: this.sshdConfig.ports[0] ?? 22,
          // The pid of the REAL sshd in this machine's process table, not
          // a fresh random one: `ps`, `sshd[<pid>]` in auth.log and
          // `journalctl -u ssh` describe one daemon and must name it the
          // same way. Falls back to the random default only when no sshd
          // process exists to point at.
          sshdPid: this.executor?.processMgr?.list({ comm: 'sshd' })[0]?.pid,
          // Hand the device's journal in so SSH events surface in
          // `journalctl -u sshd`, not just in /var/log/auth.log.
          logMgr: this.executor?.logMgr,
          logLevel: () => this.effectiveSshdServerConfig().logLevel,
          pidFor: (ip, port) => this.connectionPid(ip, port),
        })
      : null;

    const jailHost = this.executor;
    if (opts.fail2ban !== undefined) {
      this.fail2ban = opts.fail2ban;
      this.fail2ban?.attach(this.events);
    } else {
      this.fail2ban = jailHost
        ? new Fail2banAgent(
            this.events,
            {
              execute: (args) => ({ exitCode: jailHost.iptables.execute(args).exitCode }),
              hasChain: (name) => jailHost.iptables.hasChain('filter', name),
            },
            {
              appendLog: (line) => {
                const prev = this.vfs.readFile('/var/log/fail2ban.log') ?? '';
                this.vfs.writeFile('/var/log/fail2ban.log', prev + line + '\n', 0, 0, 0o022);
              },
            },
            {
              jail: this.loadFail2banJailConfig(),
              isActive: () => jailHost.serviceMgr.isActive('fail2ban'),
              journal: {
                log: (action) => jailHost.logMgr.logDaemon('fail2ban-server', action, undefined, 'fail2ban'),
              },
            },
          )
        : null;
    }

    this.rawConfig = readSshdConfig(this.vfs);
  }

  bannedIps(): string[] {
    return [...(this.fail2ban?.bannedIps() ?? [])];
  }

  unbanIp(ip: string): boolean {
    return this.fail2ban?.forceUnban(ip) ?? false;
  }

  rereadFail2banJail(): void {
    this.fail2ban?.reconfigure(this.loadFail2banJailConfig());
  }

  bantimeSeconds(): number {
    return this.fail2ban?.bantimeSeconds() ?? 0;
  }

  totalAuthFailures(): number {
    return this.fail2ban?.totalFailed() ?? 0;
  }

  /** PermitEmptyPasswords gate consulted by SshServerHandler. */
  permitEmptyPasswords(): boolean {
    return this.sshdConfig.permitEmptyPasswords;
  }

  shutdown(): void {
    this.syslogger?.dispose();
  }

  /** Re-read /etc/ssh/sshd_config and return a fresh context (SSH-07-R6). */
  reloadConfig(): LinuxSshServerContext {
    return new LinuxSshServerContext(
      this.vfs, this.userManager, this.hostnameSource, {}, this.executor, this.fullExecutor,
      { device: this.device, fail2ban: this.fail2ban },
    );
  }

  /**
   * Real-time job runtime for one shell channel (streaming `ping`, Ctrl+C
   * interrupt). Returns null when this context was built without a device
   * reference (bare unit-test contexts) — SshServerHandler falls back to
   * the plain one-shot `getShell()` round trip in that case.
   */
  createInteractiveShell(_userCtx: SshUserContext): SshInteractiveShell | null {
    if (!this.device) return null;
    return new SshInteractiveShell(this.device);
  }

  /**
   * Modern (Match-block aware) view of sshd_config, captured at the
   * moment this context was constructed. Callers SHOULD use this rather
   * than re-parsing /etc/ssh/sshd_config every login, so changes to the
   * on-disk file are only honoured after `systemctl reload ssh` (the
   * real sshd behaviour). The text snapshot lives in {@link rawConfig}.
   */
  effectiveSshdServerConfig(): SshdServerConfig {
    if (!this.cachedEffective) this.cachedEffective = SshdServerConfig.parse(this.rawConfig);
    return this.cachedEffective;
  }

  private accessPolicy(): SshdAccessPolicy {
    this.cachedPolicy ??= SshdAccessPolicy.over(
      this.effectiveSshdServerConfig(), (user) => this.userManager.getUserGroups(user).map((g) => g.name),
    );
    return this.cachedPolicy;
  }

  async openDirectTcpip(request: DirectTcpipRequest): Promise<DirectTcpipOutcome> {
    const groups = this.userManager.getUserGroups(request.user.username).map((g) => g.name);
    const policy = this.effectiveSshdServerConfig();
    const permitted = policy.permitsLocalForward(
      { user: request.user.username, groups, address: request.clientIp },
      request.host, request.port,
    );
    const keyOptions = request.keyOptions;
    const keyRefuses = keyOptions?.noPortForwarding === true
      || (keyOptions?.permitOpen !== undefined
        && !permitOpenAllows(keyOptions.permitOpen, request.host, request.port));
    if (!permitted || keyRefuses) return { kind: 'prohibited' };
    if (!(this.device instanceof LinuxMachine)) return { kind: 'prohibited' };
    const address = parseDialAddress(request.host)
      ?? parseDialAddress(this.executor?.resolveHostIpv4(request.host) ?? '');
    if (!address) return { kind: 'connect-failed', reason: 'Name or service not known' };
    if (!PortNumber.isValid(request.port)) return { kind: 'connect-failed', reason: 'Invalid argument' };
    const dialed = await this.device.tcpDial(address, PortNumber.of(request.port));
    if (!isDialFailure(dialed)) return { kind: 'open', stream: socketStream(dialed) };
    const reasons = { refused: 'Connection refused', timeout: 'Connection timed out', unreachable: 'No route to host' };
    return { kind: 'connect-failed', reason: reasons[dialed.dialFailed] };
  }

  transportPolicy(): SshTransportPolicy {
    const rekeyLimit = parseRekeyLimit(this.sshdConfig.rekeyLimit);
    const algorithms = {
      ...sshdAlgorithmPreferences(this.rawConfig),
      ...(rekeyLimit === null ? {} : { rekeyLimit }),
    };
    return Object.keys(algorithms).length === 0 ? {} : { algorithms };
  }

  accountNames(): SftpAccountNames {
    return {
      user: (uid) => this.userManager.uidToName(uid),
      group: (gid) => this.userManager.gidToName(gid),
    };
  }

  openRemoteForward(request: RemoteForwardRequest): RemoteForwardOutcome {
    const groups = this.userManager.getUserGroups(request.user.username).map((g) => g.name);
    const subject = { user: request.user.username, groups, address: request.clientIp };
    const policy = this.effectiveSshdServerConfig();
    if (!policy.permitsRemoteForward(subject) || request.keyOptions?.noPortForwarding === true) {
      return { kind: 'prohibited' };
    }
    if (!(this.device instanceof LinuxMachine)) return { kind: 'prohibited' };
    const stack = this.device.getTcpStack();
    try {
      const listener = stack.listen(request.port, {
        backlog: SSHD_LISTEN_BACKLOG,
        onAccept: (socket) => request.onConnection(socketStream(socket)),
        ownerUid: request.user.uid,
        identity: { pid: this.device.sshdPid(), processName: 'sshd' },
      }, policy.remoteForwardBindAddress(subject, request.bindAddress));
      return {
        kind: 'listening', port: listener.localPort,
        stop: () => stack.closeListener(listener.localPort, listener.localIp),
      };
    } catch {
      return { kind: 'bind-failed' };
    }
  }

  admittedKey(user: string, publicKey: string, source: KeySource): AuthorizedKey | null {
    if (!this.userAllowed(user, 'publickey', source.ip)) return null;
    if (!this.config.pubkeyAuthentication) return null;
    const userEntry = this.userManager.getUser(user);
    if (!userEntry) return null;
    const violation = this.sshdConfig.strictModes
      ? this.firstStrictModesViolation(userEntry.uid, userEntry.home)
      : null;
    if (violation !== null && source.ip !== '') {
      this.events.emit({
        kind: 'auth_strict_modes_refused', user, ip: source.ip, path: violation,
        subject: violation === AUTHORIZED_KEYS_PATH(userEntry.home) ? 'file' : 'directory', port: this.clientPort(source.ip),
      });
    }
    const content = violation === null ? this.vfs.readFile(AUTHORIZED_KEYS_PATH(userEntry.home)) : null;
    const certificate = certificateOfMaterial(publicKey);
    if (certificate !== null) {
      return this.certificates().admit(user, userEntry, certificate, source,
        content === null ? null : { path: AUTHORIZED_KEYS_PATH(userEntry.home), text: content });
    }
    const plain = plainKeyOfMaterial(publicKey);
    if (plain !== null && this.certificates().revocationRefusal(user, plain, source) !== null) return null;
    return content ? findAdmittedKey(content, publicKey, source) : null;
  }

  nowMs(): number {
    return this.executor === null ? simulationNowMs() : this.executor.simulatedDate().getTime();
  }

  private certificateService: SshdCertificateService | null = null;

  private certificates(): SshdCertificateService {
    this.certificateService ??= new SshdCertificateService({
      config: () => this.effectiveSshdServerConfig(),
      groupsOf: (user) => this.userManager.getUserGroups(user).map((group) => group.name),
      readFile: (path) => this.vfs.readFile(path),
      emit: (event) => this.events.emit(event),
      nowMs: () => this.nowMs(),
    });
    return this.certificateService;
  }

  forcedCommand(user: SshUserContext, clientIp: string, keyOptions: AuthorizedKeyOptions | null): string | null {
    return this.accessPolicy().forceCommand(user.username, clientIp) ?? keyOptions?.command ?? null;
  }

  sftpSessionRoot(user: SshUserContext): string {
    const fs = this.getFilesystem(user);
    return fs.getEntryType(user.homeDirectory) === 'directory' ? user.homeDirectory : '/';
  }

  sftpService(
    user: SshUserContext, clientIp: string, launch: SftpLaunch, keyOptions: AuthorizedKeyOptions | null,
  ): SftpServicePlan {
    const subsystems = this.effectiveSshdServerConfig().subsystems;
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
    const chroot = this.chrootDirectoryFor(user.username);
    if (chroot !== null) {
      const violation = this.chrootViolation(chroot);
      if (violation !== null) {
        this.events.emit({ kind: 'session_fatal', user: user.username, text: violation });
        return { kind: 'exits', stdout: '', stderr: '', exitCode: 255 };
      }
    }
    if (isInternalSftp(commandLine)) return this.servePlan('internal-sftp', commandLine);
    const refusal = this.loginShellRefusal(user);
    if (refusal !== null) return { kind: 'exits', stdout: refusal.output, stderr: '', exitCode: refusal.exitCode };
    const program = commandLine.trim().split(/\s+/)[0] ?? '';
    const insideRoot = chroot === null ? program : `${chroot.replace(/\/$/, '')}${program}`;
    const shell = (this.userManager.getUser(user.username)?.shell ?? '/bin/bash');
    const shellName = shell.slice(shell.lastIndexOf('/') + 1);
    const absent = this.vfs.resolveInode(insideRoot, true) === null;
    if (absent || (this.vfs.resolveInode(insideRoot, true)!.permissions & 0o111) === 0) {
      const reason = absent ? 'No such file or directory' : 'Permission denied';
      const dash = shellName === 'sh' || shellName === 'dash';
      const stderr = dash
        ? `${shellName}: 1: ${program}: ${absent ? 'not found' : 'Permission denied'}\n`
        : `${shellName}: line 1: ${program}: ${reason}\n`;
      return { kind: 'exits', stdout: '', stderr, exitCode: absent ? 127 : 126 };
    }
    if (sftpProgramOf(program) === 'sftp-server') return this.servePlan('sftp-server', commandLine);
    return {
      kind: 'runs',
      run: async () => {
        const result = await this.getShell(user, user.homeDirectory).execute(commandLine);
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
      },
    };
  }

  private servePlan(program: 'sftp-server' | 'internal-sftp', commandLine: string): SftpServicePlan {
    const parsed = parseSftpServerArguments(splitCommandWords(commandLine).slice(1));
    if (parsed.kind === 'serve') return { kind: 'serve', program, options: parsed.options, diagnostics: parsed.diagnostics };
    if (parsed.kind === 'fatal') return { kind: 'exits', stdout: '', stderr: `${parsed.message}\n`, exitCode: 255 };
    return { kind: 'exits', stdout: '', stderr: `${SFTP_SERVER_USAGE}\n`, exitCode: 1 };
  }

  private chrootViolation(chroot: string): string | null {
    const parts = chroot.split('/').filter((part) => part !== '');
    let path = '';
    for (const part of ['', ...parts]) {
      path = part === '' ? '/' : `${path === '/' ? '' : path}/${part}`;
      const inode = this.vfs.resolveInode(path, true);
      if (inode === null) return `chroot directory "${chroot}" does not exist`;
      if (inode.uid !== 0 || (inode.permissions & 0o022) !== 0) {
        return `bad ownership or modes for chroot directory${path === chroot ? '' : ' component'} "${path}"`;
      }
    }
    return null;
  }

  loginShellRefusal(user: SshUserContext): { readonly output: string; readonly exitCode: number } | null {
    const shell = this.userManager.getUser(user.username)?.shell ?? '/bin/bash';
    const program = shell.slice(shell.lastIndexOf('/') + 1);
    if (program === 'nologin') return { output: 'This account is currently not available.\n', exitCode: 1 };
    if (program === 'false') return { output: '', exitCode: 1 };
    return null;
  }

  rootMayLogIn(method: 'password' | 'publickey', keyForcesCommand?: boolean): boolean {
    if (this.rootLoginOverride !== undefined) return this.rootLoginOverride;
    const policy = this.effectiveSshdServerConfig().effectiveFor({ user: 'root' }).permitRootLogin;
    if (policy === 'yes') return true;
    if (method !== 'publickey') return false;
    if (policy === 'prohibit-password') return true;
    return policy === 'forced-commands-only' && keyForcesCommand !== false;
  }

  bannerFor(user: string, clientIp: string): string | null {
    const path = this.accessPolicy().bannerPath(user, clientIp);
    return path === null ? null : this.vfs.readFile(path);
  }

  /** Banner text shown before authentication (SSH-07-R8). */
  getBanner(): string | null {
    if (!this.sshdConfig.bannerPath) return null;
    return this.vfs.readFile(this.sshdConfig.bannerPath);
  }

  getFilesystem(userCtx: SshUserContext): ISftpFileSystem {
    const fs = new LinuxSftpFSAdapter(this.vfs, userCtx.uid, userCtx.gid);
    const chroot = this.chrootDirectoryFor(userCtx.username);
    return chroot ? new ChrootedSftpFileSystem(fs, chroot) : fs;
  }

  /**
   * `ChrootDirectory` for this account, global or from the first matching
   * `Match` block. A real sshd confines the session itself; here it was
   * applied only by a client that resolved the remote VFS in memory, so
   * the same account escaped its chroot the moment the transfer went
   * over the wire.
   */
  private chrootDirectoryFor(user: string): string | null {
    const cfg = this.effectiveSshdServerConfig();
    const groups = (this.userManager.getUserGroups?.(user) ?? []).map((g: { name: string }) => g.name);
    for (const block of cfg.matchBlocks) {
      const applies = block.criteria.every((c: { keyword: string; value: string }) => {
        if (c.keyword === 'User') return c.value === user || c.value === '*';
        if (c.keyword === 'Group') return groups.includes(c.value);
        return true;
      });
      if (!applies) continue;
      const cd = (block.overrides as { chrootDirectory?: string }).chrootDirectory;
      if (cd) return cd;
    }
    return cfg.chrootDirectory;
  }

  accountLocked(user: string): boolean {
    if (this.effectiveSshdServerConfig().usePam) return false;
    const entry = this.userManager.getUser(user) as { locked?: boolean; password?: string } | undefined;
    if (entry?.locked === true || entry?.password === '!') return true;
    const shadow = this.vfs.readFile('/etc/shadow') ?? '';
    const line = shadow.split('\n').find((l) => l.startsWith(`${user}:`));
    return line !== undefined && (line.split(':')[1] ?? '').startsWith('!');
  }

  holdSession(user: SshUserContext, clientIp: string, seconds: number): void {
    if (this.device instanceof LinuxMachine) {
      this.device.scheduleSshLogout(user.username, clientIp, seconds, true, this.clientPort(clientIp));
    }
  }

  ptyPermitted(user: SshUserContext, clientIp: string, keyOptions: AuthorizedKeyOptions | null): boolean {
    if (keyOptions?.noPty === true) return false;
    return this.accessPolicy().permitsTty(user.username, clientIp);
  }

  agentForwardingPermitted(user: SshUserContext, clientIp: string, keyOptions: AuthorizedKeyOptions | null): boolean {
    if (keyOptions?.noAgentForwarding === true) return false;
    return this.accessPolicy().agentForwarding(user.username, clientIp);
  }

  maxAuthTriesFor(user: string, clientIp: string): number {
    return this.accessPolicy().maxAuthTries(user, clientIp);
  }

  authMethodEnabled(user: string, clientIp: string, method: 'password' | 'publickey' | 'keyboard-interactive'): boolean {
    return this.accessPolicy().methodEnabled(user, clientIp, method);
  }

  availableMethodsFor(user: string, clientIp: string): readonly AuthMethodType[] {
    return this.accessPolicy().availableMethods(user, clientIp, {
      publickey: this.config.pubkeyAuthentication,
      password: this.config.passwordAuthentication,
      keyboardInteractive: this.config.kbdInteractiveAuthentication,
    });
  }

  userPolicyRefusal(user: string, address: string): string | null {
    return this.accessPolicy().refusal(user, address);
  }

  acceptsEnvironment(name: string): boolean {
    return this.effectiveSshdServerConfig().acceptEnv.some((pattern) => sshWildcardMatches(pattern, name));
  }

  private applyExecEnvironment(
    session: { readonly env: Map<string, string> },
    user: SshUserContext,
    exec: NonNullable<Parameters<ISshServerContext['getShell']>[2]>['exec'] & object,
  ): void {
    for (const [name, value] of exec.environment) session.env.set(name, value);
    if (this.effectiveSshdServerConfig().permitUserEnvironment) {
      const file = this.vfs.readFile(`${user.homeDirectory}/.ssh/environment`) ?? '';
      for (const line of file.split('\n')) {
        const entry = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*?)\s*$/.exec(line);
        if (entry) session.env.set(entry[1], entry[2]);
      }
    }
    for (const [name, value] of exec.keyOptions?.environment ?? []) session.env.set(name, value);
    if (exec.pty === null || exec.keyOptions?.noPty === true) {
      session.env.set('SSH_NO_TTY', '1');
      return;
    }
    session.env.set('COLUMNS', String(exec.pty.columns));
    session.env.set('LINES', String(exec.pty.rows));
    session.env.set('TERM', exec.pty.term);
  }

  getShell(
    userCtx: SshUserContext, cwd: string,
    opts?: Parameters<ISshServerContext['getShell']>[2],
  ): ILinuxShell {
    // Real per-session isolation: a dedicated LinuxShellSession (its own
    // cwd/env/su-stack, exactly like a real pty) so commands run as the
    // AUTHENTICATED user, not whatever user the device's single shared
    // ambient LinuxCommandExecutor happens to be sitting in. Without
    // this, `ssh alice@host` then `whoami` would print the device's
    // ambient console user instead of "alice" — SshServerHandler calls
    // getShell() once per shell channel and reuses the returned object
    // (see `shell_open`), so this session persists correctly across the
    // channel's lifetime and is torn down via ILinuxShell.dispose().
    if (this.device instanceof LinuxMachine) {
      const device = this.device;
      const interactive = opts?.interactive ?? false;
      // An account can exist in /etc/passwd with no home on disk
      // (`useradd` without -m). Real sshd reports "Could not chdir to home
      // directory" and starts the session in `/` rather than in a
      // directory that isn't there.
      const startCwd = this.vfs.exists(cwd) ? cwd : '/';
      const session = device.openShellSession({ user: userCtx.username, cwd: startCwd });
      const serverIp = firstConfiguredIp(device as unknown as Equipment) ?? '0.0.0.0';
      if (opts?.exec) {
        device.takeSessionHold();
        this.applyExecEnvironment(session, userCtx, opts.exec);
      }
      const agentSocket = opts?.agent === undefined ? null : device.bindForwardedAgent(userCtx.username, opts.agent);
      if (agentSocket !== null) session.env.set('SSH_AUTH_SOCK', agentSocket.path);
      const ptyRc = opts?.exec && opts.exec.pty !== null && opts.exec.keyOptions?.noPty !== true
        ? this.vfs.readFile(`${userCtx.homeDirectory}/.bashrc`) ?? ''
        : '';
      if (opts?.clientIp) {
        const clientPort = opts.clientPort ?? 0;
        session.env.set('SSH_CONNECTION', `${opts.clientIp} ${clientPort} ${serverIp} 22`);
        session.env.set('SSH_CLIENT', `${opts.clientIp} ${clientPort} 22`);
      }
      // `sqlplus` / `rman` typed over SSH must push their REPL on this
      // side of the wire — the client only exchanges lines and a prompt,
      // so a client-side sub-shell stack would never see them.
      const subShells = new SubShellStack({
        device: device as unknown as Equipment,
        user: userCtx.username,
        primaryKind: 'bash',
      });
      const nestedSsh = new NestedSshLogin();
      let challengeOwner: 'login' | 'stack' | null = null;
      const stepResult = (
        output: readonly string[], exitCode: number, pendingInput: SubShellStackStep['pendingInput'],
        owner: 'login' | 'stack',
      ) => {
        challengeOwner = pendingInput === undefined ? null : owner;
        return { stdout: joinLines(output), stderr: '', exitCode, ...(pendingInput ? { pendingInput } : {}) };
      };
      const loginResult = (launch: NestedSshLaunch) => {
        const banner = launch.childShell ? subShells.push(launch.childShell) : [];
        return stepResult([...launch.output, ...banner], 0, launch.pendingInput, 'login');
      };
      const EXIT_WORDS = new Set(['exit', 'logout']);
      return {
        streamSession: session,
        loginShellKind: 'bash',
        takeSessionHold: () => device.takeSessionHold(),
        provideInput: async (value: string) => {
          if (challengeOwner === 'stack' && subShells.active) {
            const routed = await subShells.answer(value);
            return stepResult(routed.output, routed.exitCode, routed.pendingInput, 'stack');
          }
          return loginResult(await nestedSsh.answer(value));
        },
        execute: async (line: string, onProgress?: (text: string) => void, stdin?: string) => {
          if (subShells.active) {
            const routed = await subShells.process(line, onProgress);
            return stepResult(routed.output, routed.exitCode, routed.pendingInput, 'stack');
          }
          nestedSsh.abandon();
          challengeOwner = null;
          if (EXIT_WORDS.has(line.trim().toLowerCase())) {
            const left = device.handleExitInSession(session);
            return { stdout: 'logout\n', stderr: '', exitCode: 0, sessionEnded: !left.inSu };
          }
          const launched = subShells.launch(line);
          if (launched) return { stdout: joinLines(launched), stderr: '', exitCode: 0 };
          if (interactive) {
            const ssh = await nestedSsh.launch(line, {
              defaultUser: session.user,
              sourceIp: serverIp,
              sourceHostname: device.getSshHostname(),
              sourceDevice: device as unknown as Equipment,
            });
            if (ssh) return loginResult(ssh);
          }
          const toRun = ptyRc.trim() ? `${ptyRc}\n${line}` : line;
          const stdout = await device.executeCommandInSession(toRun, session, { color: interactive, stdin });
          // The shell session's own `$?`, captured by the command pipeline.
          // Guessing it from the output text used to report success for
          // anything the pattern missed — `false`, a failing grep, a
          // missing file.
          return { stdout, stderr: '', exitCode: session.lastExitCode };
        },
        // Completion runs inside this channel's own session, so paths
        // resolve against its cwd rather than the device-wide one.
        getCompletions: (line: string) =>
          [...(subShells.getCompletions(line) ?? device.getCompletionsForSession(line, session))],
        getCompletionsAsync: (line: string) => subShells.getCompletionsAsync(line),
        interrupt: () => subShells.interruptForeground(),
        editorRelay: () => subShells.editorRelay(),
        isNested: () => subShells.active,
        // The engine runs here, on this channel's own session: the file
        // it opens, the permissions it obeys and the swap file it drops
        // are the remote's, not the client's.
        setWindowSize: (rows: number, cols: number) => {
          session.windowSize = { rows, cols };
          subShells.resize(rows, cols);
        },
        openEditor: (commandLine: string) => {
          installDefaultEditors();
          return openFullScreenProgram(commandLine, {
            fs: new LinuxEditorFsContext(device, session),
            owner: userCtx.username,
            windowSize: session.windowSize,
            runCommand: (line) => device.executeCommandInSession(line, session),
          });
        },
        getPrompt: () => {
          const nested = subShells.getPrompt();
          if (nested !== null) return nested;
          return formatBashPrompt(bashPromptParts({
            user: session.user,
            root: session.uid === 0,
            hostname: device.getSshHostname(),
            cwd: session.cwd,
            home: device.homeDirectoryOf(session.user),
          }));
        },
        // A persistent shell channel ends by hanging up (real terminal
        // close); a one-shot exec ran its single command to completion,
        // so its shell exits normally instead.
        dispose: () => {
          nestedSsh.abandon();
          subShells.dispose();
          agentSocket?.release();
          device.closeShellSession(session, { graceful: !interactive });
        },
      };
    }

    // BRD SSH-05/SSH-04: bare test contexts built without a resolvable
    // device fall back to the shared ambient pipeline (`fullExecutor`)
    // when available, since it covers network commands (ip, arp, ping)
    // and systemctl in addition to the bash interpreter. Fall back to the
    // executor's bash-only path, then to an informative stub. No real
    // device (LinuxMachine.getSshServerContext()) ever takes this path.
    const executor = this.executor;
    const full = this.fullExecutor;
    if (full) {
      return {
        execute: async (line: string) => {
          const stdout = await full(line);
          const exitCode = /command not found|Permission denied/.test(stdout)
            ? 1
            : 0;
          return { stdout, stderr: '', exitCode };
        },
      };
    }
    if (executor) {
      return {
        execute: async (line: string) => {
          const stdout = executor.execute(line);
          const exitCode = /command not found|Permission denied/.test(stdout)
            ? 1
            : 0;
          return { stdout, stderr: '', exitCode };
        },
      };
    }
    return {
      execute: async (line: string) => ({
        stdout: `${line}: shell execution not wired (no executor)\n`,
        stderr: '',
        exitCode: 0,
      }),
    };
  }

  getMotd(session?: { readonly user: string; readonly ip: string; readonly port?: number }): string {
    const policy = this.effectiveSshdServerConfig();
    if (session !== undefined && this.hushLogin(session.user)) return '';
    const pam = this.sshdPam();
    if (pam !== null && session !== undefined) {
      return `${pam.sessionMessages({ ip: session.ip, port: session.port }).join('')}${this.previousLoginLine(session.user, policy.printLastLog)}`;
    }
    const lastLogin = session === undefined ? '' : this.previousLoginLine(session.user, policy.printLastLog);
    if (!policy.printMotd) return lastLogin;
    const motd = this.vfs.readFile('/etc/motd');
    return `${lastLogin}${motd ?? `Welcome to ${hostnameOf(this.hostnameSource)}\n`}`;
  }

  private previousLoginLine(user: string, printLastLog: boolean): string {
    const previous = this.executor?.lastlog.getPrevious(user);
    if (!printLastLog || previous === undefined) return '';
    return `Last login: ${formatLoginDate(new Date(previous.when))} from ${previous.sourceHost}\n`;
  }

  private hushLogin(user: string): boolean {
    const home = this.userManager.getUser(user)?.home ?? `/home/${user}`;
    return this.vfs.exists(`${home}/.hushlogin`);
  }

  getLastLogin(user: string): string | null {
    const entry = this.executor?.lastlog.getCurrent(user);
    if (!entry) return null;
    return `Last login: ${new Date(entry.when).toUTCString()} from ${entry.sourceHost}`;
  }

  recordLogin(user: string, fromIp: string): void {
    this.openPamSession(user, fromIp);
    if (this.device instanceof LinuxMachine) this.device.openSshSessionRecord(user, fromIp, fromIp);
    else this.executor?.lastlog.record(user, fromIp, 'pts/0');
  }

  clientPort(fromIp: string): number | undefined {
    const machine = this.device as { sshClientPort?: (ip: string) => number } | null;
    return machine?.sshClientPort?.(fromIp);
  }

  openPamSession(user: string, fromIp: string): void {
    const pam = this.sshdPam();
    const uid = this.userManager.getUser(user)?.uid;
    if (pam === null || this.executor === null || uid === undefined) return;
    const state = pam.openSession(user, { ip: fromIp, port: this.clientPort(fromIp) });
    const processes = this.executor.processMgr;
    const nofile = state.limits.get('nofile');
    const nproc = state.limits.get('nproc');
    const bounded = (value: number): number => (Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER);
    if (nofile !== undefined) {
      processes.setNofileHardLimit(uid, bounded(nofile.hard));
      processes.setNofileLimit(uid, bounded(nofile.soft));
    }
    if (nproc !== undefined) {
      processes.setNprocHardLimit(uid, bounded(nproc.hard));
      processes.setNprocLimit(uid, bounded(nproc.soft));
    }
  }

  connectionClosed(user: string, fromIp: string, fromPort?: number): void {
    this.pamAuth?.closeSession({ ip: fromIp, port: fromPort ?? this.clientPort(fromIp) });
    const machine = this.device as { sshWireConnectionClosed?: (u: string, ip: string, port?: number) => void } | null;
    machine?.sshWireConnectionClosed?.(user, fromIp, fromPort);
  }

  recordAuthFailure(user: string, fromIp: string): void {
    if (this.device instanceof LinuxMachine) this.device.recordFailedSshLogin(user || 'invalid user', fromIp);
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

  private ensureEtcSshFiles(): void {
    if (!this.vfs.exists(ETC_SSH_DIR)) {
      this.vfs.mkdirp(ETC_SSH_DIR, 0o755, 0, 0);
    }
    if (!this.vfs.exists(SSHD_CONFIG_DROP_IN_DIR)) {
      this.vfs.mkdirp(SSHD_CONFIG_DROP_IN_DIR, 0o755, 0, 0);
    }
  }

  /**
   * Read the sshd jail's `maxretry`/`bantime`/`findtime` from
   * `/etc/fail2ban/jail.local`, seeding it with fail2ban's real stock
   * defaults on first access. Consulted once at construction, matching
   * real fail2ban which only re-reads its jail config on service
   * restart, not on every connection.
   */
  private loadFail2banJailConfig(): { maxretry: number; bantimeSeconds: number; findtimeSeconds: number } {
    const defaults = { maxretry: 5, bantimeSeconds: 300, findtimeSeconds: 60 };
    let raw = this.vfs.readFile(FAIL2BAN_JAIL_LOCAL_PATH);
    if (raw === null) {
      if (!this.vfs.exists('/etc/fail2ban')) this.vfs.mkdirp('/etc/fail2ban', 0o755, 0, 0);
      this.vfs.writeFile(FAIL2BAN_JAIL_LOCAL_PATH, DEFAULT_FAIL2BAN_JAIL_LOCAL, 0, 0, 0o022);
      raw = DEFAULT_FAIL2BAN_JAIL_LOCAL;
    }

    let inSshdSection = false;
    const values: Partial<typeof defaults> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
      const section = /^\[(\w+)\]$/.exec(trimmed);
      if (section) { inSshdSection = section[1] === 'sshd'; continue; }
      if (!inSshdSection) continue;
      const kv = /^(\w+)\s*=\s*(\S+)$/.exec(trimmed);
      if (!kv) continue;
      const value = parseInt(kv[2], 10);
      if (!Number.isFinite(value)) continue;
      if (kv[1] === 'maxretry') values.maxretry = value;
      else if (kv[1] === 'bantime') values.bantimeSeconds = value;
      else if (kv[1] === 'findtime') values.findtimeSeconds = value;
    }
    return { ...defaults, ...values };
  }

  private hostKeyFiles(): HostKeyFileAccess {
    return {
      exists: (path) => this.vfs.exists(path),
      read: (path) => this.vfs.readFile(path),
      write: (path, content, secret) => {
        this.vfs.writeFile(path, content, 0, 0, 0o022);
        this.vfs.chmod(path, secret ? 0o600 : 0o644);
      },
      writeDeferred: (path, produce, secret, declaredSize) => {
        this.vfs.createDeferredFileAt(path, produce, secret ? 0o600 : 0o644, 0, 0, declaredSize);
      },
    };
  }

  additionalHostKeys(): SshHostKey[] {
    const paths = configuredHostKeyPaths(this.rawConfig, DEFAULT_HOST_KEY_PATHS);
    return paths
      .filter((path) => path !== HOST_KEY_PATH)
      .flatMap((path) => hostKeyFromFile(this.hostKeyFiles(), path) ?? []);
  }

  hostCertificates(): HostCertificateBinding[] {
    return this.certificates().hostCertificates([this.hostKey, ...this.additionalHostKeys()]);
  }

  private loadOrGenerateHostKey(): SshHostKey {
    provisionHostKeyFiles(this.hostKeyFiles(), ETC_SSH_DIR, '/', hostnameOf(this.hostnameSource));
    const pub = this.vfs.readFile(HOST_KEY_PUB_PATH) ?? '';
    const priv = this.vfs.readFile(HOST_KEY_PATH) ?? '';
    return SshHostKey.fromFiles(pub.trim().split(/\s+/)[1] ?? pub.trim(), priv.trim(), 'ssh-ed25519');
  }

  private loadOrGenerateSshdConfig(): SshdServerConfig {
    if (this.vfs.readFile(SSHD_CONFIG_PATH)) return SshdServerConfig.parse(readSshdConfig(this.vfs));
    this.vfs.writeFile(SSHD_CONFIG_PATH, UBUNTU_2204_SSHD_CONFIG, 0, 0, 0o022);
    this.vfs.chmod(SSHD_CONFIG_PATH, 0o644);
    return SshdServerConfig.parse(readSshdConfig(this.vfs));
  }

  private pamAuth: SshdPam | null = null;

  private sshdPam(): SshdPam | null {
    if (this.executor === null || !this.effectiveSshdServerConfig().usePam) return null;
    this.pamAuth ??= new SshdPam(
      this.executor.pam,
      (peer) => ({
        tag: 'sshd',
        pid: this.connectionPid(peer.ip, peer.port) ?? (this.device as { sshdPid?: () => number } | null)?.sshdPid?.(),
        unit: 'ssh',
      }),
      () => this.permitEmptyPasswords(),
      (user) => this.userManager.getUser(user) !== undefined,
      () => this.rootMayLogIn('password'),
    );
    return this.pamAuth;
  }

  closePamSession(fromIp: string): void {
    const peer = { ip: fromIp, port: this.clientPort(fromIp) };
    this.pamAuth?.closeSession(peer);
    this.pamAuth?.end(peer);
  }

  connectionEnded(fromIp: string, port: number | undefined): void {
    this.pamAuth?.end({ ip: fromIp, port });
    if (this.device instanceof LinuxMachine) this.device.endSshConnectionProcess(fromIp, port);
  }

  private connectionPid(ip: string, port: number | undefined): number | undefined {
    return this.device instanceof LinuxMachine ? this.device.sshConnectionPid(ip, port) : undefined;
  }

  private buildAuthContext(): ISshAuthContext {
    let attemptsLeft = this.config.maxAuthTries;
    const passwordAttempt = (user: string, password: string, peer: SshPeer | undefined): boolean => {
      attemptsLeft = Math.max(0, attemptsLeft - 1);
      if (!this.userAllowed(user, 'password', peer?.ip)) return false;
      if (!this.config.passwordAuthentication || !this.authMethodEnabled(user, peer?.ip ?? '', 'password')) return false;
      const pam = this.sshdPam();
      if (pam === null) return this.userManager.passwordMatches(user, password);
      if (!pam.isPasswordAuthenticationOpen(peer)) return false;
      return pam.authenticatePassword(user, password, peer);
    };
    return {
      checkPassword: (user, password) => passwordAttempt(user, password, undefined),
      checkPasswordAsync: async (user, password, peer) => passwordAttempt(user, password, peer),
      rejectInvalidUser: async (user, password, peer) => {
        const pam = this.sshdPam();
        if (pam !== null && this.config.passwordAuthentication && pam.isPasswordAuthenticationOpen(peer)) {
          pam.rejectInvalidUser(user, password, peer);
        }
      },
      checkPublicKey: (user, publicKey) => this.admittedKey(user, publicKey, { ip: '' }) !== null,
      acceptsWithoutCredential: () => false,
      getAttemptsRemaining: () => attemptsLeft,
      getAvailableMethods: (): readonly AuthMethodType[] => {
        const methods: AuthMethodType[] = [];
        if (this.config.pubkeyAuthentication) methods.push('publickey');
        if (this.config.passwordAuthentication) methods.push('password');
        if (this.config.kbdInteractiveAuthentication) methods.push('keyboard-interactive');
        return methods;
      },
      keyboardInteractive: (peer) => {
        if (!this.config.kbdInteractiveAuthentication || !this.effectiveSshdServerConfig().usePam) return null;
        const pam = this.sshdPam();
        if (pam !== null) return pam.challenge(peer, (user) => this.userAllowed(user, 'password', peer.ip));
        return {
          device: 'pam',
          name: '',
          instruction: '',
          prompts: [{ prompt: 'Password: ', echo: false }],
          verify: (user, responses) => this.userAllowed(user, 'password')
            && this.userManager.passwordMatches(user, responses[0] ?? ''),
        };
      },
      checkAccountLifecycle: (user, peer) => this.sshdPam()?.account(user, peer) ?? this.userManager.accountLifecycleGate(user),
    };
  }

  /**
   * Enforce sshd_config user-acceptance rules. Order mirrors real OpenSSH:
   *   1. DenyUsers  — explicit reject wins.
   *   2. AllowUsers — when set, only listed patterns may log in.
   *   3. DenyGroups — reject if any of user's groups match.
   *   4. AllowGroups — when set, at least one group must match.
   *   5. PermitRootLogin — root is gated last.
   */
  private userAllowed(user: string, method: 'password' | 'publickey', address?: string): boolean {
    if (user === 'root' && !this.rootMayLogIn(method)) return false;
    return this.accessPolicy().refusal(user, address) === null;
  }

  /**
   * StrictModes (`man 5 sshd_config`): refuse a pubkey login when $HOME or
   * ~/.ssh are group/world-writable, or authorized_keys has any group/other
   * access at all — mirrors OpenSSH's stock check (0o022 mask on
   * $HOME/~/.ssh) plus the stricter, universally-taught "must be 0600" rule
   * on authorized_keys (0o077 mask). Returns the first offending path, or
   * null when nothing fails.
   */
  private firstStrictModesViolation(userUid: number, home: string): string | null {
    for (const path of [home, `${home}/.ssh`]) {
      const inode = this.vfs.resolveInode(path, true);
      if (!inode) continue;
      if (inode.uid !== userUid && inode.uid !== 0) return path;
      if ((inode.permissions & 0o022) !== 0) return path;
    }
    const akPath = AUTHORIZED_KEYS_PATH(home);
    const ak = this.vfs.resolveInode(akPath, true);
    if (ak) {
      if (ak.uid !== userUid && ak.uid !== 0) return akPath;
      if ((ak.permissions & 0o077) !== 0) return akPath;
    }
    return null;
  }
}
