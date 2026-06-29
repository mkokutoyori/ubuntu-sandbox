/**
 * WindowsPC - Windows workstation with cmd.exe terminal
 *
 * Extends EndHost (which provides the full L2/L3 network stack).
 * Delegates command execution to modular handlers under windows/.
 *
 * Architecture follows linux/LinuxPC.ts pattern:
 *   - WindowsFileSystem (VFS) in windows/WindowsFileSystem.ts
 *   - Network commands in Win*.ts modules (WinIpconfig, WinNetsh, etc.)
 *   - File commands in WinFileCommands.ts + WinDir.ts
 *   - WindowsPC orchestrates both via context objects
 *
 * PowerShell is implemented as a sub-shell (ISubShell) at the terminal
 * session level, not at the device level. This device only handles cmd.exe.
 */

import { EndHost, PingResult } from './EndHost';
import { WindowsDnsCache } from './windows/WinDnsCache';
import type { UserAccountHost } from '../equipment/HostCapabilities';
import { Port } from '../hardware/Port';
import { IPAddress, SubnetMask, DeviceType, type IPv4Packet, IP_PROTO_TCP, IP_PROTO_UDP, IP_PROTO_ICMP } from '../core/types';
import { WindowsSshServerContext } from '../protocols/ssh/server/WindowsSshServerContext';
import { SshServerHandler } from '../protocols/ssh/server/SshServerHandler';
import { CrossVendorSshHost } from '../protocols/ssh/server/CrossVendorSshHost';
import { WindowsUserManagerAuthority } from './windows/network/WindowsUserManagerAuthority';
import { runWindowsSshClient } from './windows/network/WindowsSshClient';
import { runWindowsSftpClient } from './windows/network/WindowsSftpClient';
import { runWindowsScpClient } from './windows/network/WindowsScpClient';
import { splitCmdArgs } from './windows/cmdline';
import { WindowsAccountsPolicy } from './windows/security/WindowsAccountsPolicy';
import { DoskeyTable } from './windows/cli/DoskeyTable';
import { runPowerShellShim, createShimState, type PsShimState } from './windows/PowerShellCmdShim';
import type { WinCommandContext, RouteEntry, TracerouteHop } from './windows/WinCommandExecutor';
import type { WinFileCommandContext } from './windows/WinFileCommands';
import { WindowsFileSystem } from './windows/WindowsFileSystem';
import { HostsFile } from './HostsFile';
import { WindowsShellSession } from './windows/shell/WindowsShellSession';
import { WindowsUserManager } from './windows/WindowsUserManager';
import { WindowsSecurityAudit } from './windows/WindowsSecurityAudit';
import { WindowsSecurityAuditProjection } from './windows/WindowsSecurityAuditProjection';
import { WindowsEventLogProjection } from './windows/WindowsEventLogProjection';
import { WindowsServicePortProjection } from './windows/WindowsServicePortProjection';
import { PortProxyTable } from './windows/PortProxyTable';
import { PortProxySocketProjection } from './windows/PortProxySocketProjection';
import { WindowsServiceManager } from './windows/WindowsServiceManager';
import { WindowsProcessManager } from './windows/WindowsProcessManager';
import { HostClock } from './host/lifecycle/HostClock';
import { PSRegistryProvider } from './windows/PSRegistryProvider';
import { PSEventLogProvider } from './windows/PSEventLogProvider';
import { cmdHelp } from './windows/WinHelp';
import { cmdIpconfig } from './windows/WinIpconfig';
import { cmdNetsh } from './windows/WinNetsh';
import { cmdPing } from './windows/WinPing';
import { cmdArp } from './windows/WinArp';
import { cmdGetmac } from './windows/WinGetmac';
import { cmdTracert } from './windows/WinTracert';
import { cmdRoute } from './windows/WinRoute';
import { cmdWevtutil } from './windows/WinWevtutil';
import { cmdWhoami } from './windows/WinWhoami';
import { cmdNetUser, cmdNetLocalgroup } from './windows/WinNetUser';
import { cmdIcacls } from './windows/WinIcacls';
import { cmdTasklist as cmdTasklistDynamic } from './windows/WinTasklist';
import { cmdTaskkill } from './windows/WinTaskkill';
import { cmdSc } from './windows/WinSc';
import { cmdNetStart, cmdNetStop } from './windows/WinNetStart';
import { cmdNetUse } from './windows/WinNetUse';
import { cmdNetShare } from './windows/WinNetShare';
import { cmdPrint } from './windows/WinPrint';
import { executeNslookup } from './linux/LinuxDnsService';
import { SessionWorkQueue } from './host/session/SessionWorkQueue';
import { SessionSwapWindow } from './host/session/SessionSwapWindow';
import * as WinSys from './windows/WinSystemCommands';
import { cmdReg as winCmdReg } from './windows/WinRegCommand';
import { cmdDir } from './windows/WinDir';
import {
  cmdCd, cmdMkdir, cmdRmdir, cmdType, cmdCopy, cmdMove,
  cmdRen, cmdDel, cmdTree, cmdSet, cmdTasklist, cmdNetstat,
  cmdAttrib, cmdFind, cmdFindstr, cmdWhere, cmdMore, cmdFc,
  cmdXcopy, cmdSort,
} from './windows/WinFileCommands';

/**
 * Parse a `findstr` filter from a piped command (`net user | findstr /i Full`).
 * Returns the active flags and the literal patterns. Multi-token patterns
 * separated by spaces are split into individual `OR` patterns to mirror real
 * `findstr` behaviour (use `/C:"..."` to force a single literal substring).
 */
function parseFindstrFilter(filter: string): { patterns: string[]; ignoreCase: boolean; invert: boolean; count: boolean } {
  const tokens = filter.split(/\s+/).slice(1);
  let ignoreCase = false;
  let invert = false;
  let count = false;
  let cLiteral: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.toLowerCase() === '/i') { ignoreCase = true; continue; }
    if (t.toLowerCase() === '/v') { invert = true; continue; }
    if (t.toLowerCase() === '/c')  { count = true; continue; }
    if (/^\/c:/i.test(t)) {
      cLiteral = t.slice(3).replace(/^"|"$/g, '');
      continue;
    }
    if (t.startsWith('"')) {
      let str = t.slice(1);
      while (i < tokens.length - 1 && !str.endsWith('"')) { i++; str += ' ' + tokens[i]; }
      if (str.endsWith('"')) str = str.slice(0, -1);
      positional.push(str);
      continue;
    }
    positional.push(t);
  }

  if (cLiteral !== null) return { patterns: [cLiteral], ignoreCase, invert, count };
  // Bareword multi-token form: each token is a separate literal (OR semantics).
  return { patterns: positional, ignoreCase, invert, count };
}

export class WindowsPC extends EndHost implements UserAccountHost {
  protected readonly defaultTTL = 128;
  /** DHCP event log for Windows Event Viewer */
  private dhcpEventLog: string[] = [];
  /** Track synced DHCP events to avoid duplicates */
  private trackedEvents: Set<string> = new Set();
  /** Virtual file system */
  private fs: WindowsFileSystem;
  /** Current working directory */
  private cwd: string = 'C:\\Users\\User';
  /** Environment variables */
  private env: Map<string, string> = new Map();
  /** Exposes the env map so subshells (PS / cmd) share the same source.
   *  Reads are case-insensitive on Windows. */
  getEnvVars(): Map<string, string> { return this.env; }
  getEnvVar(name: string): string | undefined {
    const u = name.toUpperCase();
    for (const [k, v] of this.env) if (k.toUpperCase() === u) return v;
    return undefined;
  }
  /** Per-interface DNS configuration: portName → { servers, mode } */
  private dnsConfig: Map<string, { servers: string[]; mode: 'static' | 'dhcp' }> = new Map();
  readonly dnsCache = new WindowsDnsCache();
  /** DHCP client trace flag */
  private dhcpTraceEnabled: boolean = false;
  /** Primary DNS suffix (set via netsh dnsclient set global) */
  private dnsSuffix: string = '';
  /** User and group manager (access control / privileges) */
  private userMgr: WindowsUserManager;
  /** LSA account policy mirrored by `net accounts`. */
  readonly accountsPolicy: WindowsAccountsPolicy = new WindowsAccountsPolicy();
  /** cmd.exe doskey macro table. */
  readonly doskey: DoskeyTable = new DoskeyTable();
  /** Per-device PowerShell shim state (functions, aliases, vars). */
  readonly psShimState: PsShimState = createShimState();
  /** Reactive consumer: account/group/logon events → Security event log. */
  private securityAuditProjection: WindowsSecurityAuditProjection | null = null;
  /** Reactive consumer: service lifecycle events → System event log. */
  private eventLogProjection: WindowsEventLogProjection | null = null;
  /** Reactive consumer: service lifecycle events → socket-table ports. */
  private servicePortProjection: WindowsServicePortProjection | null = null;
  /** `netsh interface portproxy` rules — port-forwarding entries. */
  readonly portProxyTable: PortProxyTable = new PortProxyTable();
  /** Reactive consumer: port-proxy events → socket-table listeners. */
  private portProxySocketProjection: PortProxySocketProjection | null = null;
  /** Service manager (service lifecycle, dependencies) */
  private svcMgr: WindowsServiceManager;
  /** Process manager (process table, PIDs, kill, tree) */
  private procMgr: WindowsProcessManager;

  // ── Per-device transitional state (Phase 4 relocation) ──────────────────
  // These maps + provider instances used to live as private fields on
  // PowerShellExecutor. Moving them to the device makes them visible to
  // any consumer (the interpreter, future Get-* cmdlets, the executor's
  // own handlers via shared references) without going through the
  // executor as the source of truth.
  /** Additional IP addresses (added via New-NetIPAddress). */
  readonly extraIPs: Map<string, { ifAlias: string; prefixLength: number; prefixOrigin: string; suffixOrigin: string; skipAsSource: boolean; gateway?: string; addressFamily: string }> = new Map();
  /** Extra routes (added via New-NetRoute). */
  readonly extraRoutes: Map<string, { ifAlias: string; nextHop: string; metric: number }> = new Map();
  /** Adapter overrides: status / display name. */
  readonly adapterOverrides: Map<string, { status?: string; displayName?: string }> = new Map();
  /** Dynamic firewall rules (added via New-NetFirewallRule). */
  readonly dynamicFirewallRules: Map<string, { name: string; displayName: string; enabled: boolean; action: string; direction: string; protocol: string; localPort: string; remotePort: string; description: string }> = new Map();
  /** Network connection profiles: ifIndex → category. */
  readonly networkProfiles: Map<number, string> = new Map();
  /** VPN connections: lowercase name → details. */
  readonly vpnConnections: Map<string, { name: string; serverAddress: string; tunnelType: string; encryptionLevel: string; authMethod: string }> = new Map();
  /** In-memory registry hive (HKLM / HKCU). */
  readonly registry: PSRegistryProvider = new PSRegistryProvider();

  /**
   * Shared scheduled-task table. Both `schtasks` (cmd) and the Get/Register/
   * Unregister-ScheduledTask cmdlets read and write here so a task created
   * from one shell is visible from the other.
   */
  readonly scheduledTasks: Map<string, { taskName: string; taskPath: string; state: string }> = new Map([
    ['googleupdatetaskuser',           { taskName: 'GoogleUpdateTaskUser',            taskPath: '\\',                         state: 'Ready' }],
    ['onedrive standalone update task',{ taskName: 'OneDrive Standalone Update Task', taskPath: '\\',                         state: 'Ready' }],
    ['.net framework ngen v4.0.30319', { taskName: '.NET Framework NGEN v4.0.30319',  taskPath: '\\Microsoft\\Windows\\.NET', state: 'Ready' }],
    ['simtesttask',                    { taskName: 'SimTestTask',                     taskPath: '\\',                         state: 'Ready' }],
  ]);
  /** Event-log store. */
  readonly eventLog: PSEventLogProvider = new PSEventLogProvider();

  private readonly clock = new HostClock();
  private readonly wallEpoch = new Date(2026, 5, 20).getTime();

  constructor(type: DeviceType = 'windows-pc', name: string = 'WindowsPC', x: number = 0, y: number = 0) {
    super(type, name, x, y);
    // Windows (Vista+) uses the strong host model on IPv4: packets are only
    // accepted when addressed to the ingress interface (RFC 1122 §3.3.4.2).
    this.hostModel = 'strong';
    this.createPorts();
    this.fs = new WindowsFileSystem(name);
    // Materialise the event logs as .evtx files under winevt\Logs.
    this.eventLog.attachFilesystem(this.fs);
    this.userMgr = new WindowsUserManager();
    this.svcMgr = new WindowsServiceManager();
    this.procMgr = new WindowsProcessManager();
    this.initEnv();
    this.initDefaultSockets();
    this.wireReactiveProjections();
  }

  /**
   * Wire the Windows managers to the central event bus and stand up the
   * reactive consumers: account / group / logon changes flow to the Security
   * event log, service lifecycle to the System log. The managers only
   * announce — the projections keep the derived views coherent.
   */
  private wireReactiveProjections(): void {
    const bus = this.getBus();
    this.userMgr.attachBus(bus, this.id);
    this.svcMgr.attachBus(bus, this.id);
    this.procMgr.attachBus(bus, this.id);
    this.securityAuditProjection?.dispose();
    this.securityAuditProjection = new WindowsSecurityAuditProjection(
      bus, new WindowsSecurityAudit(this.eventLog), this.id,
    );
    this.eventLogProjection?.dispose();
    this.eventLog.attachBus(bus, this.id);
    this.eventLogProjection = new WindowsEventLogProjection(bus, this.eventLog, this.id);
    this.servicePortProjection?.dispose();
    this.servicePortProjection = new WindowsServicePortProjection(bus, this.id, this.socketTable);
    // Port-proxy rules announce on the bus; the projection keeps the
    // socket table coherent so `netstat` reflects every active rule.
    this.portProxySocketProjection = new PortProxySocketProjection(bus, this.id, this.socketTable);
    this.portProxyTable.attachBus(bus, this.id);
  }

  private initDefaultSockets(): void {
    // OpenSSH Server — SFTP transport
    this.socketTable.bind('tcp', '0.0.0.0', 22, 1088, 'sshd.exe');
    // RDP — Remote Desktop Protocol (TermService)
    this.socketTable.bind('tcp', '0.0.0.0', 3389, 1096, 'svchost.exe');
    // SMB — file sharing / domain traffic (LanmanServer)
    this.socketTable.bind('tcp', '0.0.0.0', 445, 4, 'System');
    // NetBIOS Session Service (LanmanServer)
    this.socketTable.bind('tcp', '0.0.0.0', 139, 4, 'System');

    // Persist SSH server config + host key under C:\ProgramData\ssh\ on
    // first boot so OpenSSH-for-Windows files are visible from the shell.
    this.getSshServerContext();

    // TCP SSH server on port 22 — handles SSH auth + SFTP subsystem.
    this.getTcpStack().listen(22, {
      onAccept: (socket) => {
        this.getSshServerHandler().register(socket, socket.remoteIp);
      },
    });
  }

  /** Build a fresh ISshServerContext bound to this machine's NTFS / users. */
  getSshServerContext(): WindowsSshServerContext {
    return new WindowsSshServerContext(this.fs, this.userMgr, this.hostname, {}, {
      executeCmdCommand: (line: string) => this.executeCmdCommand(line),
    },
    // Publish a `windows.account.logon` per inbound SSH auth attempt
    // — the SecurityAuditProjection turns each into a 4624 / 4625 in
    // the Security event log, matching what OpenSSH-for-Windows logs.
    // Logon type 10 = RemoteInteractive, what sshd uses on real Windows.
    (user, success) => {
      this.getBus().publish({
        topic: 'windows.account.logon',
        payload: { deviceId: this.id, account: user, success, logonType: 10 },
      });
    },
    // Paired logoff hook — turns into 4634 (Logoff) in the Security
    // event log when the SSH session ends.
    (user) => {
      this.getBus().publish({
        topic: 'windows.account.logoff',
        payload: { deviceId: this.id, account: user, logonType: 10 },
      });
    });
  }

  private _sshHost: CrossVendorSshHost | null = null;
  private _sshAuthority: WindowsUserManagerAuthority | null = null;

  getSshHost(): CrossVendorSshHost {
    if (!this._sshAuthority) {
      this._sshAuthority = new WindowsUserManagerAuthority({
        userMgr: this.userMgr,
        deviceId: this.id,
        hostname: this.hostname,
        recordSshLogin: (user, fromIp, fromHost, accepted) => this.recordSshLogin(user, fromIp, fromHost, accepted),
      });
    }
    if (!this._sshHost) {
      this._sshHost = new CrossVendorSshHost({
        deviceId: this.id,
        hostname: this.hostname,
        vendor: 'windows',
        bus: this.getBus(),
        authority: this._sshAuthority,
        banner: this.getSshBanner(),
        motd: this.getSshMotd(),
        active: this.isSshActive(),
      });
    } else {
      this._sshHost.setSshActive(this.isSshActive());
      this._sshHost.setHostname(this.hostname);
      this._sshHost.setBanner(this.getSshBanner());
      this._sshHost.setMotd(this.getSshMotd());
    }
    return this._sshHost;
  }

  /** Build a SshServerHandler ready to be hooked onto a TcpConnection. */
  getSshServerHandler(): SshServerHandler {
    return new SshServerHandler(this.getSshServerContext());
  }

  // ─── SSH server surface (consumed by the outbound ssh client) ───────

  /** Whether the OpenSSH server (`sshd` service) is accepting connections. */
  isSshActive(): boolean {
    return this.svcMgr.getService('sshd')?.state === 'Running';
  }

  /**
   * Login-policy decision for an inbound SSH user. Honours account
   * existence and the enabled flag; further policy (allowed groups,
   * `PermitRootLogin`-style gates) is layered on as the suite grows.
   */
  sshdAcceptsLogin(user: string): { ok: boolean; reason?: string } {
    const account = this.userMgr.getUser(user);
    if (!account) return { ok: false, reason: 'no such user' };
    if (!account.enabled) return { ok: false, reason: 'account disabled' };
    return { ok: true };
  }

  /**
   * Record an inbound SSH connection attempt in the audit trail. The
   * logon event feeds the Security event-log projection, exactly as a
   * real network logon (type 3) would.
   */
  recordSshLogin(user: string, _fromIp: string, _fromHost: string, accepted: boolean): void {
    this.getBus().publish({
      topic: 'windows.account.logon',
      payload: { deviceId: this.id, account: user, success: accepted, logonType: 3 },
    });
  }

  /** The remote command-prompt banner shown to an interactive SSH client. */
  sshBanner(): string {
    return 'Microsoft Windows [Version 10.0.22631.6649]\n' +
      '(c) Microsoft Corporation. All rights reserved.';
  }

  /** Run a command on this machine for an SSH exec-mode request. */
  async runSshCommand(user: string, command: string): Promise<{ output: string; exitCode: number }> {
    const previous = this.userMgr.currentUser;
    if (this.userMgr.getUser(user)) this.userMgr.currentUser = user;
    try {
      const output = await this.executeCmdCommand(command);
      return { output, exitCode: 0 };
    } finally {
      this.userMgr.currentUser = previous;
    }
  }

  // ─── Equipment-level credential surface ─────────────────────────────

  /**
   * Validate <user, password> against the local SAM database. Override of
   * the {@link Equipment} stub so SSH (and any future caller) can authenticate
   * a Windows account without reaching into the private user manager.
   */
  checkPassword(username: string, password: string): boolean {
    return this.userMgr.checkPassword(username, password);
  }

  /**
   * Set / change a user's password through the SAM database. Mirrors
   * LinuxMachine.setUserPassword so the two platforms expose a parallel
   * surface to callers that don't care which OS they're talking to.
   */
  setUserPassword(username: string, password: string): void {
    this.userMgr.setUserProperty(username, 'password', password);
  }

  /** True iff the named account exists in the local SAM. */
  userExists(username: string): boolean {
    return this.userMgr.getUser(username) !== undefined;
  }

  // ─── SshExecTarget surface (sync path used by cross-platform clients) ───

  /** Hostname as it would appear in the remote shell's prompt. */
  getSshHostname(): string { return this.hostname; }

  /** Pre-auth banner. Windows ships an empty Banner by default. */
  getSshBanner(): string {
    const psKey = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\System';
    try {
      const values = this.registry.getItemPropertyValues(psKey);
      const banner = values?.['LegalNoticeText'];
      return typeof banner === 'string' ? banner : '';
    } catch {
      return '';
    }
  }

  /** Post-auth MOTD; Windows shows the cmd.exe version line. */
  getSshMotd(): string { return this.sshBanner(); }

  /** Polymorphic alias for `isSshActive` so any caller can ask by name. */
  isServiceActive(name: string): boolean {
    if (name === 'ssh' || name === 'sshd') return this.isSshActive();
    return this.svcMgr.getService(name)?.state === 'Running';
  }

  /**
   * Frozen view of OpenSSH-for-Windows policy. Reads from C:\ProgramData\
   * ssh\sshd_config when present, falls back to OpenSSH defaults.
   */
  getSshPolicy(): {
    readonly active: boolean;
    readonly ports: readonly number[];
    readonly permitRootLogin: boolean;
    readonly passwordAuthentication: boolean;
    readonly pubkeyAuthentication: boolean;
    readonly maxAuthTries: number;
    readonly permitEmptyPasswords: boolean;
  } {
    const cfgResult = this.fs.readFile('C:\\ProgramData\\ssh\\sshd_config');
    const cfg = cfgResult.ok && cfgResult.content ? cfgResult.content : '';
    const directive = (n: string): string | null => {
      const m = new RegExp(`^\\s*${n}\\s+(\\S+)`, 'im').exec(cfg);
      return m ? m[1].toLowerCase() : null;
    };
    const ports = Array.from(cfg.matchAll(/^\s*Port\s+(\d+)/gim))
      .map(m => Number(m[1]))
      .filter(n => Number.isFinite(n) && n > 0 && n < 65536);
    return Object.freeze({
      active: this.isSshActive(),
      ports: ports.length ? Object.freeze(ports) : Object.freeze([22]),
      permitRootLogin: directive('PermitRootLogin') !== 'no',
      passwordAuthentication: directive('PasswordAuthentication') !== 'no',
      pubkeyAuthentication: directive('PubkeyAuthentication') !== 'no',
      maxAuthTries: Number(directive('MaxAuthTries') ?? 6),
      permitEmptyPasswords: directive('PermitEmptyPasswords') === 'yes',
    });
  }

  /** Stable host-key identity surfaced to known_hosts. */
  getSshHostKey(): {
    readonly type: 'ssh-rsa' | 'ssh-ed25519' | 'ecdsa-sha2-nistp256';
    readonly fingerprintSha256: string;
    readonly publicKey: string;
  } {
    return this.getSshServerContext().hostKey as unknown as {
      readonly type: 'ssh-rsa' | 'ssh-ed25519' | 'ecdsa-sha2-nistp256';
      readonly fingerprintSha256: string;
      readonly publicKey: string;
    };
  }

  /**
   * Curated, *synchronous* exec entry point used by the cross-platform
   * SSH client dispatch. Returns `null` for anything outside this
   * whitelist — the caller falls back to the async surface.
   *
   * The whitelist mirrors what an operator types right after
   * `ssh User@host` on a Windows box: identification, identity check,
   * trivial transforms. Everything else (PowerShell pipelines,
   * `dir`, `reg add`, …) goes through async cmd.exe.
   */
  runSshCommandSync(user: string, command: string): { output: string; exitCode: number } | null {
    let cmd = command.trim();
    if (!cmd) return { output: '', exitCode: 0 };
    // Outbound clients (Cisco / Huawei) preserve the surrounding quotes
    // when they hand the command string to the cross-platform bridge.
    if ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'"))) {
      cmd = cmd.slice(1, -1).trim();
    }

    // `hostname` → the configured machine name.
    if (/^hostname\s*$/i.test(cmd)) {
      return { output: `${this.hostname}\n`, exitCode: 0 };
    }
    // `ver` → cmd.exe Windows-version banner.
    if (/^ver\s*$/i.test(cmd)) {
      return { output: `\n${this.sshBanner().split('\n')[0]}\n\n`, exitCode: 0 };
    }
    // `whoami` → the SSH user. Real Windows returns "host\user"; we
    // keep that shape so AD-aware scripts see something coherent.
    if (/^whoami\s*$/i.test(cmd)) {
      return { output: `${this.hostname.toLowerCase()}\\${user}\n`, exitCode: 0 };
    }
    // `echo something` → literal echo (no variable expansion).
    const echoMatch = /^echo\s+(.*)$/i.exec(cmd);
    if (echoMatch) {
      return { output: `${echoMatch[1]}\n`, exitCode: 0 };
    }
    return null;
  }

  /** First IPv4 address configured on an up interface, or null. */
  private firstConfiguredIp(): string | null {
    for (const port of this.ports.values()) {
      const ip = port.getIPAddress()?.toString();
      if (ip && port.getIsUp()) return ip;
    }
    return null;
  }

  /** `ssh user@host [command]` — outbound SSH client. */
  private cmdSsh(args: string[]): Promise<string> {
    const user = this.userMgr.currentUser;
    return runWindowsSshClient({
      args,
      sourceHostname: this.hostname,
      sourceIp: this.firstConfiguredIp() ?? '127.0.0.1',
      sourceUser: user,
      sourceHome: `C:\\Users\\${user}`,
      localFs: {
        readFile: (p: string) => this.fs.readFile(p),
        createFile: (p: string, c: string) => {
          const dir = p.substring(0, p.lastIndexOf('\\'));
          if (dir && !this.fs.exists(dir)) this.fs.mkdirp(dir);
          return this.fs.createFile(p, c);
        },
      },
    }).then(r => r.output);
  }

  private cmdSftp(args: string[]): Promise<string> {
    const user = this.userMgr.currentUser;
    let stdin: string | undefined;
    if (args.length > 0 && args[args.length - 1].includes('\n')) {
      stdin = args.pop();
    }
    return runWindowsSftpClient({
      args,
      stdin,
      sourceHostname: this.hostname,
      sourceIp: this.firstConfiguredIp() ?? '127.0.0.1',
      sourceUser: user,
      sourceHome: `C:\\Users\\${user}`,
      localFs: this.fs,
    }).then(r => r.output);
  }

  private cmdScp(args: string[]): Promise<string> {
    const user = this.userMgr.currentUser;
    return runWindowsScpClient({
      args,
      sourceHostname: this.hostname,
      sourceIp: this.firstConfiguredIp() ?? '127.0.0.1',
      sourceUser: user,
      sourceHome: `C:\\Users\\${user}`,
      localFs: this.fs,
      tcpConnector: (h, p) => this.tcpConnect(h, p) as ReturnType<import('../core/TcpConnection').TcpConnector>,
    }).then(r => r.output);
  }

  private async cmdTelnet(args: string[]): Promise<string> {
    const positional = args.filter((a) => !a.startsWith('-'));
    const host = positional[0];
    if (!host) {
      return `Microsoft Telnet> ?\nCommands may be abbreviated. Supported commands are:\n\nc\t- close\t\tclose current connection\nd\t- display\t\tdisplay operating parameters\no\t- open hostname [port]\tconnect to hostname (default port 23).\nq\t- quit\t\t\texit telnet`;
    }
    const port = positional[1] ? parseInt(positional[1], 10) : 23;
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return `Invalid command: ${positional[1]}`;
    }
    const sourceIp = this.firstConfiguredIp();
    if (!sourceIp) {
      return `Connecting To ${host}...Could not open connection to the host, on port ${port}: Network is unreachable`;
    }
    const sock = await this.tcpConnect(host, port);
    if (!sock) {
      return `Connecting To ${host}...Could not open connection to the host, on port ${port}: Connect failed`;
    }
    sock.close();
    return `Connecting To ${host}...\nWelcome to Microsoft Telnet Client\n\nEscape Character is 'CTRL+]'`;
  }

  private createPorts(): void {
    for (let i = 0; i < 4; i++) {
      this.addPort(new Port(`eth${i}`, 'ethernet'));
    }
  }

  private initEnv(): void {
    this.env.set('USERNAME', 'User');
    this.env.set('COMPUTERNAME', this.hostname);
    this.env.set('HOMEDRIVE', 'C:');
    this.env.set('HOMEPATH', '\\Users\\User');
    this.env.set('USERPROFILE', 'C:\\Users\\User');
    this.env.set('WINDIR', 'C:\\Windows');
    this.env.set('SYSTEMROOT', 'C:\\Windows');
    this.env.set('SYSTEMDRIVE', 'C:');
    this.env.set('COMSPEC', 'C:\\Windows\\System32\\cmd.exe');
    this.env.set('PATH', 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem');
    this.env.set('PATHEXT', '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSH;.MSC');
    this.env.set('TEMP', 'C:\\Users\\User\\AppData\\Local\\Temp');
    this.env.set('TMP', 'C:\\Users\\User\\AppData\\Local\\Temp');
    this.env.set('OS', 'Windows_NT');
    this.env.set('PROCESSOR_ARCHITECTURE', 'AMD64');
    this.env.set('NUMBER_OF_PROCESSORS', '4');
  }

  private static readonly HOSTS_FILE = 'C:\\Windows\\System32\\drivers\\etc\\hosts';

  /** Single source of truth for the simulated OS build, so `ver` reports
   *  the same string from cmd and from the PowerShell native shim, and it
   *  agrees with `systeminfo` (build 22631). */
  private static readonly VER_STRING = '\nMicrosoft Windows [Version 10.0.22631.6649]';

  // ─── Hosts file ──────────────────────────────────────────────

  /** Read the Windows hosts file into a parsed {@link HostsFile}. */
  private readHostsFile(): HostsFile {
    const result = this.fs.readFile(WindowsPC.HOSTS_FILE);
    return HostsFile.parse(result.ok ? result.content : null);
  }

  /** Append a static name → IP mapping to the Windows hosts file. */
  addHostsEntry(ip: string, hostname: string): void {
    const updated = this.readHostsFile().withEntry(ip, hostname);
    this.fs.createFile(WindowsPC.HOSTS_FILE, updated.serialize());
  }

  /**
   * Re-sync the hosts file's self entry after a hostname change so the
   * machine keeps resolving its own name — the Windows analogue of the
   * Linux 127.0.1.1 convention.
   */
  private syncHostsFile(hostname: string): void {
    this.fs.createFile(
      WindowsPC.HOSTS_FILE,
      HostsFile.defaultWindows(hostname).serialize(),
    );
  }

  /**
   * Rename the machine. Besides the Equipment-level field, the hosts file
   * is rewritten so the new computer name keeps resolving locally and
   * `COMPUTERNAME` stays coherent.
   */
  override setHostname(hostname: string): void {
    super.setHostname(hostname);
    this.env.set('COMPUTERNAME', hostname);
    this.syncHostsFile(hostname);
  }

  protected async resolveHostForCommand(targetStr: string): Promise<IPAddress | null> {
    return this.resolveHostname(targetStr);
  }

  resolveHostnameSync(name: string): IPAddress | null {
    try { return new IPAddress(name); } catch { /* not an IP */ }
    const ip = this.readHostsFile().resolve(name, 4);
    if (ip) {
      try { return new IPAddress(ip); } catch { /* malformed entry */ }
    }
    const lower = name.toLowerCase();
    const ownHostname = typeof this.hostname === 'string' ? this.hostname.toLowerCase() : '';
    if (lower === 'localhost' || (ownHostname && lower === ownHostname)) {
      return new IPAddress('127.0.0.1');
    }
    return null;
  }

  /**
   * Resolve a name to an IPv4 address, mirroring the Windows resolver
   * order: literal IP → hosts file → the machine's own name → DNS.
   * The DNS step queries each configured server over UDP/53 through the
   * simulated network, so unreachable servers time out like real ones.
   */
  async resolveHostname(name: string): Promise<IPAddress | null> {
    // 1. Already a literal IP address.
    try { return new IPAddress(name); } catch { /* not an IP */ }

    // 2. Static hosts file.
    const ip = this.readHostsFile().resolve(name, 4);
    if (ip) {
      try { return new IPAddress(ip); } catch { /* malformed entry */ }
    }

    // 3. The machine's own name always resolves to loopback.
    const ownHostname = typeof this.hostname === 'string' ? this.hostname.toLowerCase() : '';
    if (ownHostname && name.toLowerCase() === ownHostname) {
      return new IPAddress('127.0.0.1');
    }

    // 4. DNS fallback — query every statically/DHCP-configured server.
    for (const cfg of this.dnsConfig.values()) {
      for (const server of cfg.servers) {
        let serverIP: IPAddress;
        try { serverIP = new IPAddress(server); } catch { continue; }
        const response = await this.queryDnsServer(serverIP, name, 'A');
        if (response && response.answers.length > 0) {
          this.dnsCache.store(name, response.answers);
          try { return new IPAddress(response.answers[0].value); } catch { /* skip */ }
        }
      }
    }
    return null;
  }

  // ─── Terminal ──────────────────────────────────────────────────

  async executeCommand(command: string): Promise<string> {
    return this.executeCmdCommand(command);
  }

  /**
   * Execute a command in CMD mode.
   * Also used by PowerShellExecutor (via PSDeviceContext) to delegate
   * native commands (ipconfig, ping, cd, etc.) directly to cmd.
   */
  async executeCmdCommand(trimmed: string): Promise<string> {
    if (!this.isPoweredOn) return 'Device is powered off';

    trimmed = trimmed.trim();
    if (!trimmed) return '';

    // Strip stderr redirects like "2>&1", "2> nul", "2>nul" – in simulation all output is stdout
    trimmed = trimmed.replace(/\s+2>&1\s*$/i, '').replace(/\s+2>\s*(?:nul|&1)\s*$/i, '').trim();

    // Command chaining: `a && b` (b iff a ok), `a || b` (b iff a failed),
    // `a & b` (b always). Real cmd.exe semantics; needed so coherence
    // probes like `cd <dir> && cd` behave like the actual shell.
    const chain = this.splitCmdChain(trimmed);
    if (chain.length > 1) {
      const outputs: string[] = [];
      let prevFailed = false;
      for (const link of chain) {
        const run =
          link.op === '&'  ? true :
          link.op === '&&' ? !prevFailed :
          link.op === '||' ? prevFailed :
          true; // first segment (op === '')
        if (!run) continue;
        const out = await this.executeCmdCommand(link.cmd);
        if (out !== '') outputs.push(out);
        prevFailed = this.cmdOutputIsError(out);
      }
      return outputs.join('\n');
    }

    // Handle piped commands (but not inside redirects)
    if (trimmed.includes('|') && !trimmed.match(/[>]/)) {
      return this.executePipedCommand(trimmed);
    }

    // Handle echo with redirect: echo text > file / echo text >> file
    const redirectMatch = trimmed.match(/^(.+?)\s*(>>|>)\s*(.+)$/);
    if (redirectMatch) {
      return this.handleRedirect(redirectMatch[1].trim(), redirectMatch[2], redirectMatch[3].trim());
    }

    // Expand environment variables, then expand doskey macros so
    // `ll` → `dir /a` before the dispatcher sees an unknown command.
    const expandedEnv = this.expandEnvVars(trimmed);
    const doskeyExpanded = this.doskey.expand(expandedEnv);
    const expanded = doskeyExpanded !== expandedEnv
      ? doskeyExpanded
      : expandedEnv;
    if (doskeyExpanded !== expandedEnv) {
      // Recurse so the expanded form goes through the full pipeline
      // (pipes, redirects, chains).
      return this.executeCmdCommand(doskeyExpanded);
    }
    const parts = this.parseCommandLine(expanded);
    if (parts.length === 0) return '';

    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    // Bare drive letter (e.g. "D:" or "D:\\path") — change current drive
    // and restore the per-drive last cwd. Real cmd.exe: typing `D:` at the
    // prompt does not run an external command, it switches to drive D and
    // its remembered cwd (terminal_gap.md §6.3).
    const driveOnly = /^([a-zA-Z]):$/.exec(parts[0]);
    const drivePath = /^([a-zA-Z]):[\\/](.*)$/.exec(parts[0]);
    if ((driveOnly || drivePath) && args.length === 0) {
      const letter = (driveOnly ? driveOnly[1] : drivePath![1]).toUpperCase();
      return this.switchActiveDrive(letter, drivePath ? parts[0] : null);
    }

    // File commands (use file context)
    const fileCtx = this.buildFileContext();
    switch (cmd) {
      case 'cd':
      case 'chdir':   return cmdCd(fileCtx, args);
      case 'dir':     return cmdDir(fileCtx, args);
      case 'mkdir':
      case 'md':      return cmdMkdir(fileCtx, args);
      case 'rmdir':
      case 'rd':      return cmdRmdir(fileCtx, args);
      case 'type':    return cmdType(fileCtx, args);
      case 'copy':    return cmdCopy(fileCtx, args);
      case 'move':    return cmdMove(fileCtx, args);
      case 'ren':
      case 'rename':  return cmdRen(fileCtx, args);
      case 'del':
      case 'erase':   return cmdDel(fileCtx, args);
      case 'tree':    return cmdTree(fileCtx, args);
      case 'set':     return cmdSet(fileCtx, args);
      case 'tasklist': return cmdTasklistDynamic(
        { processManager: this.procMgr, currentUser: this.userMgr.currentUser, hostname: this.hostname }, args);
      case 'taskkill': return cmdTaskkill(
        { processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin() }, args);
      case 'sc':
      case 'sc.exe': return cmdSc(
        { serviceManager: this.svcMgr, processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin() }, args);
      case 'netstat': return cmdNetstat(fileCtx, args, this.socketTable);
      case 'attrib':  return cmdAttrib(fileCtx, args);
      case 'find':    return cmdFind(fileCtx, args);
      case 'findstr': return cmdFindstr(fileCtx, args);
      case 'where':   return cmdWhere(fileCtx, args);
      case 'more':    return cmdMore(fileCtx, args);
      case 'fc':      return cmdFc(fileCtx, args);
      case 'xcopy':   return cmdXcopy(fileCtx, args);
      case 'sort':    return cmdSort(fileCtx, args);
      case 'echo':    return args.join(' ');
      case 'cls':     return '';
      case 'doskey':  return this.cmdDoskey(args);
      case 'powershell':
      case 'pwsh':
        return runPowerShellShim({
          executeCmdCommand: (l) => this.executeCmdCommand(l),
          shimState: this.psShimState,
        }, args);
      case 'ver':     return WindowsPC.VER_STRING;
      case 'hostname': return this.hostname;
      case 'systeminfo': return this.cmdSysteminfo();
      case 'whoami':  return cmdWhoami({ hostname: this.hostname, userManager: this.userMgr }, args);
      case 'icacls':  return cmdIcacls({ fs: this.fs, cwd: this.cwd, userManager: this.userMgr }, args);
      case 'runas':   return this.cmdRunas(args);
      case 'vol':     return this.cmdVol(args);
      case 'chcp':    return this.cmdChcp(args);
      case 'date':    return this.cmdDate(args);
      case 'time':    return this.cmdTime(args);
      case 'start':   return this.cmdStart(args);
      case 'setx':    return this.cmdSetx(args);
      case 'schtasks': return this.cmdSchtasks(args);
      case 'print':    return cmdPrint(this.buildNetContext(), args);
      case 'nbtstat': return this.cmdNbtstat(args);
      case 'wmic':    return this.cmdWmic(args);
      case 'reg':     return this.cmdReg(args);
    }

    // net user / net localgroup / net start / net stop / net help
    if (cmd === 'net') {
      if (args.length === 0) {
        return 'The syntax of this command is:\n\nNET\n    [ ACCOUNTS | COMPUTER | CONFIG | CONTINUE | FILE | GROUP | HELP |\n      HELPMSG | LOCALGROUP | PAUSE | SESSION | SHARE | START |\n      STATISTICS | STOP | TIME | USE | USER | VIEW ]';
      }
      const subCmd = args[0].toLowerCase();
      const subArgs = args.slice(1);
      const netCtx2 = { hostname: this.hostname, userManager: this.userMgr };
      if (subCmd === 'user') return cmdNetUser(netCtx2, subArgs);
      if (subCmd === 'localgroup') return cmdNetLocalgroup(netCtx2, subArgs);
      const netSvcCtx = { serviceManager: this.svcMgr, processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin() };
      if (subCmd === 'start') return cmdNetStart(netSvcCtx, subArgs);
      if (subCmd === 'stop') return cmdNetStop(netSvcCtx, subArgs);
      if (subCmd === 'use') return cmdNetUse(this.buildNetContext(), subArgs);
      if (subCmd === 'share') return cmdNetShare(this.buildNetContext(), subArgs);
      if (subCmd === 'accounts') {
        if (subArgs.length === 0) return this.accountsPolicy.render();
        for (const a of subArgs) {
          const m = /^\/([a-z]+):(.+)$/i.exec(a);
          if (m) {
            const err = this.accountsPolicy.apply(m[1], m[2]);
            if (err) return err;
          }
        }
        return 'The command completed successfully.';
      }
      if (subCmd === 'help' || subCmd === '/?' || subCmd === '-?') {
        const topic = (subArgs[0] ?? '').toLowerCase();
        if (!topic) {
          return 'The following commands are available:\n\nNET ACCOUNTS         NET HELPMSG       NET STATISTICS\nNET COMPUTER         NET LOCALGROUP    NET STOP\nNET CONFIG           NET PAUSE         NET TIME\nNET CONTINUE         NET SESSION       NET USE\nNET FILE             NET SHARE         NET USER\nNET GROUP            NET START         NET VIEW\nNET HELP             NET HELPMSG       NET HELP SERVICES';
        }
        return `The syntax of this command is:\n\nNET ${topic.toUpperCase()} [...]`;
      }
      return `The syntax of this command is:\n\nNET ${subCmd.toUpperCase()} [...]`;
    }

    // Network commands (use network context)
    const netCtx = this.buildNetContext();
    switch (cmd) {
      case 'help':     return cmdHelp(args);
      case 'ipconfig': return cmdIpconfig(netCtx, args);
      case 'netsh':    return cmdNetsh(netCtx, args);
      case 'ping':     return cmdPing(netCtx, args);
      case 'arp':      return cmdArp(netCtx, args);
      case 'getmac':   return cmdGetmac(netCtx, args);
      case 'tracert':
      case 'traceroute': return cmdTracert(netCtx, args);
      case 'route':    return cmdRoute(netCtx, args);
      case 'wevtutil': return cmdWevtutil(netCtx, args);
      case 'nslookup': return this.cmdNslookup(args);
      case 'ssh':      return this.cmdSsh(args);
      case 'sftp':     return this.cmdSftp(args);
      case 'scp':      return this.cmdScp(args);
      case 'telnet':   return this.cmdTelnet(args);
      default:
        return `'${cmd}' is not recognized as an internal or external command,\noperable program or batch file.`;
    }
  }

  // ─── Command Chaining ─────────────────────────────────────────────

  /**
   * Split a command line into `&&` / `||` / `&`-separated links,
   * respecting double quotes. A single `|` is a PIPE (left intact for
   * the segment's own pipe handling); only `||` is a chain operator.
   */
  private splitCmdChain(line: string): Array<{ op: '' | '&&' | '||' | '&'; cmd: string }> {
    const links: Array<{ op: '' | '&&' | '||' | '&'; cmd: string }> = [];
    let buf = '';
    let inQuote = false;
    let pendingOp: '' | '&&' | '||' | '&' = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQuote = !inQuote; buf += c; continue; }
      if (!inQuote) {
        if (c === '&' && line[i + 1] === '&') {
          links.push({ op: pendingOp, cmd: buf.trim() }); pendingOp = '&&'; buf = ''; i++; continue;
        }
        if (c === '|' && line[i + 1] === '|') {
          links.push({ op: pendingOp, cmd: buf.trim() }); pendingOp = '||'; buf = ''; i++; continue;
        }
        if (c === '&') {
          links.push({ op: pendingOp, cmd: buf.trim() }); pendingOp = '&'; buf = ''; continue;
        }
      }
      buf += c;
    }
    links.push({ op: pendingOp, cmd: buf.trim() });
    // Drop empty links (e.g. trailing `&`); keep at least one.
    const cleaned = links.filter(l => l.cmd.length > 0);
    return cleaned.length ? cleaned : [{ op: '', cmd: line.trim() }];
  }

  /** Heuristic: did a cmd produce an error (drives `&&` / `||`)? */
  private cmdOutputIsError(out: string): boolean {
    const s = out.trim().toLowerCase();
    if (!s) return false;
    return /^error:/.test(s)
      || s.includes('the system cannot find the path specified')
      || s.includes('the system cannot find the file specified')
      || s.includes('is not recognized as an internal or external command')
      || s.includes('access is denied')
      || s.includes('the syntax of the command is incorrect')
      || s.includes('the network path was not found')
      || s.includes('a duplicate name exists')
      || s.includes('the parameter is incorrect')
      || s.includes('the filename, directory name, or volume label syntax is incorrect')
      || s.includes('could not find')
      || s.includes('cannot find');
  }

  // ─── Command Parsing ──────────────────────────────────────────────

  private parseCommandLine(line: string): string[] {
    return splitCmdArgs(line);
  }

  private expandEnvVars(text: string): string {
    return text.replace(/%([^%]+)%/g, (match, varName) => {
      const upper = varName.toUpperCase();
      if (upper === 'CD') return this.cwd;
      return this.env.get(upper) ?? match;
    });
  }

  // ─── Redirect Handling ────────────────────────────────────────────

  private handleRedirect(cmdPart: string, op: string, filePath: string): string {
    // Execute the command part to get its output
    const expanded = this.expandEnvVars(cmdPart);
    const parts = this.parseCommandLine(expanded);
    if (parts.length === 0) return '';

    const cmd = parts[0].toLowerCase();
    let content: string;
    if (cmd === 'echo') {
      content = parts.slice(1).join(' ');
    } else {
      // For other commands, we'd need async, but echo is the main use case
      content = parts.slice(1).join(' ');
    }

    const absPath = this.fs.normalizePath(filePath, this.cwd);
    if (op === '>>') {
      this.fs.appendFile(absPath, content + '\n');
    } else {
      this.fs.createFile(absPath, content + '\n');
    }
    return '';
  }

  // ─── Piped Commands ─────────────────────────────────────────────

  private async executePipedCommand(command: string): Promise<string> {
    const segments = command.split('|').map(s => s.trim());
    let output = await this.executeCommand(segments[0]);

    for (let i = 1; i < segments.length; i++) {
      const filter = segments[i].trim();
      const filterParts = filter.split(/\s+/);
      const filterCmd = filterParts[0].toLowerCase();

      if (filterCmd === 'findstr') {
        const { patterns, ignoreCase, invert, count } = parseFindstrFilter(filter);
        const lines = output.split('\n');
        const matches = (line: string): boolean => {
          const haystack = ignoreCase ? line.toLowerCase() : line;
          return patterns.some(p => haystack.includes(ignoreCase ? p.toLowerCase() : p));
        };
        const filtered = lines.filter(l => invert ? !matches(l) : matches(l));
        output = count ? String(filtered.length) : filtered.join('\n');
      } else if (filterCmd === 'grep') {
        const pattern = filterParts[filterParts.length - 1];
        const lines = output.split('\n');
        output = lines.filter(l => l.includes(pattern)).join('\n');
      } else if (filterCmd === 'find') {
        const ci = /\s\/i(\s|$)/i.test(' ' + filter);
        const cnt = /\s\/c(\s|$)/i.test(' ' + filter);
        const quoteMatch = filter.match(/find\s+(?:\/[a-z]\s+)*"([^"]+)"/i);
        if (quoteMatch) {
          const pattern = quoteMatch[1];
          const lines = output.split('\n');
          const matched = lines.filter(l => ci ? l.toLowerCase().includes(pattern.toLowerCase()) : l.includes(pattern));
          output = cnt ? String(matched.length) : matched.join('\n');
        }
      } else if (filterCmd === 'more') {
        // Passthrough in simulation
      }
    }

    return output;
  }

  // ─── Tab Completion ──────────────────────────────────────────────

  getCompletions(partial: string): string[] {
    const parts = partial.trimStart().split(/\s+/);

    if (parts.length <= 1) {
      // Command completion
      const prefix = (parts[0] || '').toLowerCase();
      const commands = [
        'help', 'ipconfig', 'netsh', 'ping', 'arp', 'getmac', 'tracert', 'route',
        'nslookup', 'wevtutil', 'hostname', 'ver', 'cls', 'systeminfo', 'tasklist',
        'netstat', 'dir', 'cd', 'mkdir', 'md', 'rmdir', 'rd', 'type',
        'copy', 'move', 'ren', 'rename', 'del', 'erase', 'echo', 'set',
        'tree', 'powershell', 'exit',
      ];
      return commands.filter(c => c.startsWith(prefix)).sort();
    }

    // File/directory completion for the last argument
    const lastArg = parts[parts.length - 1];
    // Split on last backslash to get directory and partial name
    const lastSep = lastArg.lastIndexOf('\\');
    let dir: string;
    let partialName: string;
    if (lastSep >= 0) {
      const dirPart = lastArg.substring(0, lastSep) || '\\';
      dir = this.fs.normalizePath(dirPart, this.cwd);
      partialName = lastArg.substring(lastSep + 1);
    } else {
      dir = this.cwd;
      partialName = lastArg;
    }

    return this.fs.getCompletions(dir, partialName);
  }

  // ─── Build Contexts ──────────────────────────────────────────────

  private buildFileContext(): WinFileCommandContext {
    return {
      fs: this.fs,
      cwd: this.cwd,
      hostname: this.hostname,
      env: this.env,
      setCwd: (path: string) => {
        // When the new cwd belongs to a different drive than the old one,
        // remember the previous drive's cwd in the active session's
        // per-drive map so a later bare `C:` returns to the right
        // location (terminal_gap.md §6.3).
        const oldDrive = this.cwd.match(/^([A-Za-z]):/)?.[1]?.toUpperCase();
        const newDrive = path.match(/^([A-Za-z]):/)?.[1]?.toUpperCase();
        const s = this._activeShellSession;
        if (s && oldDrive && newDrive && oldDrive !== newDrive) {
          s.driveCwd.set(oldDrive, this.cwd);
        }
        if (s && newDrive) s.driveCwd.set(newDrive, path);
        this.cwd = path;
      },
    };
  }

  /**
   * Handle a bare drive-letter command (`D:` / `D:\path`). When typed at
   * the prompt this is *not* an external command — it changes the active
   * drive. Real cmd.exe semantics:
   *   - `D:` alone     → switch to D, restoring D's last-known cwd
   *                      (or `D:\` if D has never been visited).
   *   - `D:\some\path` → switch to D and chdir to `D:\some\path` (only if
   *                      it exists; otherwise leave the cwd untouched).
   * The previous drive's cwd is saved into the session's `driveCwd` map.
   *
   * If the drive does not exist on the simulated FS, mirror the real
   * cmd.exe error.
   */
  private switchActiveDrive(letter: string, fullPath: string | null): string {
    const target = fullPath ?? `${letter}:\\`;
    const normalised = this.fs.normalizePath(target, this.cwd);
    // Drives in the sim are virtual directories rooted at `<L>:\\`. Treat
    // an unknown root as "system cannot find the drive specified".
    const root = `${letter}:\\`;
    if (!this.fs.isDirectory(root)) {
      return 'The system cannot find the drive specified.';
    }

    const s = this._activeShellSession;
    const oldDrive = this.cwd.match(/^([A-Za-z]):/)?.[1]?.toUpperCase();
    // Save the current drive's cwd before leaving.
    if (s && oldDrive) s.driveCwd.set(oldDrive, this.cwd);

    let next: string;
    if (fullPath) {
      if (!this.fs.isDirectory(normalised)) {
        return 'The system cannot find the path specified.';
      }
      next = normalised;
    } else {
      // No path given — go to the session's remembered cwd for that
      // drive, fall back to its root.
      next = (s?.driveCwd.get(letter)) ?? root;
      if (!this.fs.isDirectory(next)) next = root;
    }
    this.cwd = next;
    if (s) s.driveCwd.set(letter, next);
    return '';
  }

  private buildNetContext(): WinCommandContext {
    return {
      hostname: this.hostname,
      ports: this.ports,
      defaultGateway: this.defaultGateway?.toString() || null,
      arpTable: this.arpTable,

      configureInterface: (ifName: string, ip: IPAddress, mask: SubnetMask) =>
        this.configureInterface(ifName, ip, mask),
      setDefaultGateway: (gw: IPAddress) => this.setDefaultGateway(gw),
      clearDefaultGateway: () => this.clearDefaultGateway(),
      addStaticRoute: (network: IPAddress, mask: SubnetMask, nextHop: IPAddress, metric: number) =>
        this.addStaticRoute(network, mask, nextHop, metric),
      removeRoute: (dest: IPAddress, mask: SubnetMask) => this.removeRoute(dest, mask),
      getRoutingTable: () => this.getRoutingTable() as RouteEntry[],

      isDHCPConfigured: (ifName: string) => this.isDHCPConfigured(ifName),
      getDHCPState: (ifName: string) => this.dhcpClient.getState(ifName),
      releaseLease: (ifName: string) => this.dhcpClient.releaseLease(ifName),
      requestLease: (ifName: string, opts: any) => this.dhcpClient.requestLease(ifName, opts),
      autoDiscoverDHCPServers: () => this.autoDiscoverDHCPServers(),

      addDHCPEvent: (type: string, message: string) => this.addDHCPEvent(type, message),
      syncDHCPEvents: () => this.syncDHCPEvents(),
      getDHCPEventLog: () => this.dhcpEventLog,

      executePingSequence: (target: IPAddress, count: number, timeout?: number, ttl?: number) =>
        this.executePingSequence(target, count, timeout, ttl),
      executeTraceroute: (target: IPAddress, maxHops?: number, timeoutMs?: number) =>
        this.executeTraceroute(target, maxHops, timeoutMs ?? 500) as Promise<TracerouteHop[]>,

      reverseLookup: (ip: string): string | null => {
        const entry = this.readHostsFile().reverse(ip);
        return entry ? entry.canonicalName : null;
      },

      resetStack: () => {
        for (const [name, port] of this.ports) {
          port.clearIP();
          this.dhcpClient.releaseLease(name);
        }
        this.defaultGateway = null;
        this.routingTable = [];
        this.arpTable.clear();
        this.dnsConfig.clear();
        this.dnsSuffix = '';
      },

      // DNS management
      getDnsServers: (ifName: string) => {
        const cfg = this.dnsConfig.get(ifName);
        return cfg ? [...cfg.servers] : [];
      },
      setDnsServers: (ifName: string, servers: string[]) => {
        this.dnsConfig.set(ifName, { servers: [...servers], mode: 'static' });
      },
      getDnsMode: (ifName: string) => {
        return this.dnsConfig.get(ifName)?.mode ?? 'dhcp';
      },
      setDnsMode: (ifName: string, mode: 'static' | 'dhcp') => {
        if (mode === 'dhcp') {
          this.dnsConfig.set(ifName, { servers: [], mode: 'dhcp' });
        } else {
          const cfg = this.dnsConfig.get(ifName);
          if (cfg) cfg.mode = 'static';
          else this.dnsConfig.set(ifName, { servers: [], mode: 'static' });
        }
      },

      // Interface admin state
      setInterfaceAdmin: (ifName: string, enabled: boolean) => {
        const port = this.ports.get(ifName);
        if (port) port.setUp(enabled);
      },
      getInterfaceAdmin: (ifName: string) => {
        const port = this.ports.get(ifName);
        return port ? port.getIsUp() : false;
      },

      // IP address removal
      clearInterfaceIP: (ifName: string) => {
        const port = this.ports.get(ifName);
        if (port) port.clearIP();
      },

      // Switch interface to DHCP address mode
      setAddressDhcp: (ifName: string) => {
        const port = this.ports.get(ifName);
        if (port) port.clearIP();
        this.dhcpInterfaces.add(ifName);
      },

      // DHCP tracing
      getDhcpTraceEnabled: () => this.dhcpTraceEnabled,
      setDhcpTraceEnabled: (enabled: boolean) => { this.dhcpTraceEnabled = enabled; },

      // DNS suffix
      getDnsSuffix: () => this.dnsSuffix,
      setDnsSuffix: (suffix: string) => { this.dnsSuffix = suffix; },

      // ARP table mutation
      addStaticARP: (ip: IPAddress, mac: any, iface: string) => this.addStaticARP(ip, mac, iface),
      deleteARP: (ip: IPAddress) => this.deleteARP(ip),
      clearARPTable: () => this.clearARPTable(),

      // Interface renaming
      renameInterface: (oldName: string, newName: string): boolean => {
        const port = this.ports.get(oldName);
        if (!port || this.ports.has(newName)) return false;
        this.ports.delete(oldName);
        this.ports.set(newName, port);
        // Migrate DNS config
        const dns = this.dnsConfig.get(oldName);
        if (dns) { this.dnsConfig.delete(oldName); this.dnsConfig.set(newName, dns); }
        // Migrate DHCP state
        if (this.dhcpInterfaces.has(oldName)) { this.dhcpInterfaces.delete(oldName); this.dhcpInterfaces.add(newName); }
        return true;
      },

      // Hostname resolution
      resolveHostname: (name: string) => this.resolveHostname(name),

      // Service state query
      isServiceRunning: (name: string) => {
        const svc = this.svcMgr.getService(name);
        return svc ? svc.state === 'Running' : false;
      },

      portProxy: this.portProxyTable,
      eventLog: this.eventLog,
      dnsCache: this.dnsCache,
    };
  }

  // ─── DHCP Event Log ─────────────────────────────────────────────

  private syncDHCPEvents(): void {
    for (const [name] of this.ports) {
      const logs = this.dhcpClient.getLogs(name);
      if (!logs) continue;
      const logLines = logs.split('\n').filter(Boolean);
      for (const line of logLines) {
        const eventKey = `${name}:${line}`;
        if (!this.trackedEvents.has(eventKey)) {
          this.trackedEvents.add(eventKey);
          let type = 'INFO';
          if (line.includes('DHCPDISCOVER')) type = 'DISCOVER';
          else if (line.includes('DHCPOFFER')) type = 'OFFER';
          else if (line.includes('DHCPREQUEST')) type = 'REQUEST';
          else if (line.includes('DHCPACK')) type = 'ACK';
          else if (line.includes('DHCPNAK')) type = 'NAK';
          else if (line.includes('released')) type = 'RELEASE';
          else if (line.includes('RENEWING')) type = 'RENEW';
          else if (line.includes('INIT')) type = 'INIT';
          else if (line.includes('bound')) type = 'ACK';
          this.addDHCPEvent(type, `${line} on ${name}`);
        }
      }
    }
  }

  private addDHCPEvent(type: string, message: string): void {
    const timestamp = new Date().toISOString();
    this.dhcpEventLog.push(`[${timestamp}] DHCP ${type}: ${message}`);
  }

  // ─── systeminfo ────────────────────────────────────────────────

  /**
   * Run a synchronous native CLI command (ipconfig / netsh / arp / route /
   * getmac / systeminfo / ver / net) directly. Used by the interpreter's
   * native-command cmdlets so they can deliver real output without going
   * through the async PowerShellExecutor pipeline.
   *
   * Returns null when the command is async (ping / tracert) or unknown —
   * callers fall back to executeCmdCommand() in that case.
   */
  runSyncNativeCommand(cmd: string, args: string[]): string | null {
    const lower = cmd.toLowerCase();
    if (lower === 'systeminfo') return this.cmdSysteminfo();
    if (lower === 'ver') return WindowsPC.VER_STRING;
    if (lower === 'hostname') return this.hostname;
    if (lower === 'vol')  return this.cmdVol(args);
    if (lower === 'chcp') return this.cmdChcp(args);
    if (lower === 'date') return this.cmdDate(args);
    if (lower === 'time') return this.cmdTime(args);
    if (lower === 'sc' || lower === 'sc.exe') {
      return cmdSc(
        { serviceManager: this.svcMgr, processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin() },
        args,
      );
    }
    // `net` is a multi-subcommand router — all its subhandlers are sync
    // (cmdNetUser / cmdNetLocalgroup / cmdNetStart / cmdNetStop).
    if (lower === 'net' && args.length > 0) {
      const subCmd = args[0].toLowerCase();
      const subArgs = args.slice(1);
      const netUserCtx = { hostname: this.hostname, userManager: this.userMgr };
      if (subCmd === 'user')        return cmdNetUser(netUserCtx, subArgs);
      if (subCmd === 'localgroup')  return cmdNetLocalgroup(netUserCtx, subArgs);
      const netSvcCtx = { serviceManager: this.svcMgr, processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin() };
      if (subCmd === 'start')       return cmdNetStart(netSvcCtx, subArgs);
      if (subCmd === 'stop')        return cmdNetStop(netSvcCtx, subArgs);
      if (subCmd === 'use')         return cmdNetUse(this.buildNetContext(), subArgs);
      if (subCmd === 'share')       return cmdNetShare(this.buildNetContext(), subArgs);
    }
    const netCtx = this.buildNetContext();
    switch (lower) {
      case 'ipconfig': return cmdIpconfig(netCtx, args);
      case 'netsh':    return cmdNetsh(netCtx, args);
      case 'arp':      return cmdArp(netCtx, args);
      case 'getmac':   return cmdGetmac(netCtx, args);
      case 'route':    return cmdRoute(netCtx, args);
      // ping / tracert / nslookup are async (they touch the wire) — no sync path.
      default: return null;
    }
  }

  /**
   * Narrow surface handed to the extracted cmd.exe system commands
   * (WinSystemCommands.ts). Rebuilt per call so it always reflects the
   * live hostname / user / hardware state.
   */
  private buildSystemContext(): WinSys.WinSystemContext {
    return {
      hostname: this.hostname,
      os: this.getIdentity().os,
      bootedAt: () => this.getLifecycle().bootedAt() ?? null,
      hardware: this.hardware,
      ports: this.ports,
      isDHCPConfigured: (ifName) => this.isDHCPConfigured(ifName),
      getVolumeSerialNumber: (letter) => this.fs.getVolumeSerialNumber(letter),
      doskey: this.doskey,
      env: this.env,
      processManager: this.procMgr,
      currentUser: this.userMgr.currentUser,
      isServiceRunning: (name) => this.svcMgr.getService(name)?.state === 'Running',
      scheduledTasks: this.scheduledTasks,
      now: () => this.simulatedDate(),
    };
  }

  private simulatedDate(): Date {
    return new Date(this.wallEpoch + this.clock.now());
  }

  simulatedNow(): number {
    return this.clock.now();
  }

  advanceTime(ms: number): void {
    this.clock.advance(ms);
    this.fireDueScheduledTasks();
  }

  private fireDueScheduledTasks(): void {
    if (this.svcMgr.getService('Schedule')?.state !== 'Running') return;
    const now = this.simulatedDate();
    for (const task of this.scheduledTasks.values()) {
      let guard = 0;
      while (task.runAt && task.runAt.getTime() <= now.getTime() && guard++ < 20_000) {
        WinSys.runScheduledProgram(task, this.procMgr, now);
        task.runAt = task.intervalMs
          ? new Date(task.runAt.getTime() + task.intervalMs)
          : undefined;
      }
    }
  }

  private cmdSysteminfo(): string {
    return WinSys.cmdSysteminfo(this.buildSystemContext());
  }

  // ─── PSDeviceContext implementation ───────────────────────────

  getFileSystem(): WindowsFileSystem { return this.fs; }
  getPortsMap(): Map<string, Port> { return this.ports; }
  getCwd(): string { return this.cwd; }
  setCwd(path: string): void { this.cwd = path; }
  getDefaultGateway(): string | null { return this.defaultGateway?.toString() ?? null; }
  getDnsServers(ifName: string): string[] {
    const cfg = this.dnsConfig.get(ifName);
    return cfg ? [...cfg.servers] : [];
  }

  setDnsServers(ifName: string, servers: string[]): void {
    this.dnsConfig.set(ifName, { servers: [...servers], mode: 'static' });
  }

  private cmdDoskey(args: string[]): string {
    return WinSys.cmdDoskey(this.buildSystemContext(), args);
  }

  private cmdVol(args: string[]): string {
    return WinSys.cmdVol(this.buildSystemContext(), args);
  }

  private cmdChcp(args: string[]): string {
    return WinSys.cmdChcp(args);
  }

  private cmdDate(args: string[]): string {
    return WinSys.cmdDate(args);
  }

  private cmdTime(args: string[]): string {
    return WinSys.cmdTime(args);
  }

  private cmdStart(args: string[]): string {
    return WinSys.cmdStart(this.buildSystemContext(), args);
  }

  private cmdSetx(args: string[]): string {
    return WinSys.cmdSetx(this.buildSystemContext(), args);
  }

  private cmdSchtasks(args: string[]): string {
    return WinSys.cmdSchtasks(this.buildSystemContext(), args);
  }

  private cmdNbtstat(args: string[]): string {
    return WinSys.cmdNbtstat(this.buildSystemContext(), args);
  }

  private cmdWmic(args: string[]): string {
    if (args.length === 0) return 'wmic:root\\cli>';
    const joined = args.join(' ').toLowerCase();
    if (joined.includes('logicaldisk') && joined.includes('get name')) {
      // Mirror real wmic — list every mounted drive, not just C:.
      const drives = this.fs.listDrives();
      return ['Name  ', ...drives.map(d => d.padEnd(6))].join('\n');
    }
    if (joined.includes('os get caption')) {
      return 'Caption                              \nMicrosoft Windows 10 Enterprise      ';
    }
    if (joined.includes('cpu get name')) {
      return 'Name                                              \nIntel(R) Core(TM) i7 CPU @ 2.50GHz                ';
    }
    return '';
  }

  private cmdReg(args: string[]): string {
    return winCmdReg(this.registry, args);
  }

  /** nslookup command implementation for Windows */
  private cmdNslookup(args: string[]): Promise<string> | string {
    const host = args.find(a => !a.startsWith('-')) ?? '';
    // The static hosts table (including the machine's own name) is
    // answered locally, ahead of any DNS query — same order as the
    // resolveHostname() resolver.
    if (host && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const ownHostName = typeof this.hostname === 'string' ? this.hostname.toLowerCase() : '';
      const hostsIp = this.readHostsFile().resolve(host, 4)
        ?? (ownHostName && host.toLowerCase() === ownHostName ? '127.0.0.1' : null);
      if (hostsIp) {
        return 'Server:  UnKnown\nAddress:  127.0.0.1\n\n' +
               `Name:    ${host}\nAddress:  ${hostsIp}`;
      }
    }
    if (this.svcMgr.getService('Dnscache')?.state !== 'Running') {
      return `*** Can't find ${host}: No DNS servers available\n` +
             `The DNS Client (Dnscache) service is not running.`;
    }
    // Get DNS server from any configured interface
    let resolverIP = '';
    for (const [ifName] of this.ports) {
      const servers = this.getDnsServers(ifName);
      if (servers.length > 0) { resolverIP = servers[0]; break; }
    }
    // Allow specifying server as second argument: nslookup domain server.
    // Queries travel over UDP/53 through the simulated network (EndHost
    // socket layer) — an unreachable server now times out for real.
    return executeNslookup(args, async (s, n, t, ms) => {
      let server: IPAddress;
      try { server = new IPAddress(s); } catch { return null; }
      return this.queryDnsServer(server, n, t, ms);
    }, resolverIP);
  }

  // ─── User / Access Control ──────────────────────────────────────

  /** Switch current user context (for testing & runas) */
  setCurrentUser(name: string): void {
    if (this.userMgr.setCurrentUser(name)) {
      this.env.set('USERNAME', this.userMgr.currentUser);
      this.env.set('USERPROFILE', `C:\\Users\\${this.userMgr.currentUser}`);
      this.env.set('HOMEPATH', `\\Users\\${this.userMgr.currentUser}`);
    }
  }

  /** Override Equipment's hard-coded 'user' default so syncDeviceState
   *  reports the real currently-logged-in account on this Windows host. */
  getCurrentUser(): string { return this.userMgr.currentUser; }

  /** Get the user manager (for PowerShellExecutor and other integrations) */
  getUserManager(): WindowsUserManager { return this.userMgr; }

  /** Get the service manager (for PowerShellExecutor and other integrations) */
  getServiceManager(): WindowsServiceManager { return this.svcMgr; }

  /** Get the process manager (for PowerShellExecutor and other integrations) */
  getProcessManager(): WindowsProcessManager { return this.procMgr; }

  /** runas command — simplified non-interactive version */
  private async cmdRunas(args: string[]): Promise<string> {
    if (args.length === 0) {
      return 'RUNAS USAGE:\n\nRUNAS /user:<UserName> program';
    }

    let userName = '';
    const cmdParts: string[] = [];

    for (const arg of args) {
      const lower = arg.toLowerCase();
      if (lower.startsWith('/user:')) {
        userName = arg.substring(6);
      } else {
        cmdParts.push(arg);
      }
    }

    if (!userName) {
      return 'RUNAS USAGE:\n\nRUNAS /user:<UserName> program';
    }

    const user = this.userMgr.getUser(userName);
    if (!user) {
      return `RUNAS ERROR: The user name "${userName}" is not recognized.`;
    }

    if (!user.enabled) {
      return `RUNAS ERROR: The account "${userName}" is disabled.`;
    }

    if (cmdParts.length === 0) {
      return 'RUNAS ERROR: No command specified.';
    }

    // Real runas launches the program AS the target user in a separate
    // logon session — the calling shell keeps its own identity. Run the
    // command under the switched context, then restore the caller.
    const previousUser = this.userMgr.currentUser;
    this.setCurrentUser(user.name);
    try {
      return await this.executeCmdCommand(cmdParts.join(' '));
    } finally {
      this.setCurrentUser(previousUser);
    }
  }

  // ─── OS Info ───────────────────────────────────────────────────

  getOSType(): string { return 'windows'; }

  // ─── Shell sessions (per-terminal isolation, §6 of terminal_gap.md) ─

  /** Live shell sessions keyed by their internal id. */
  private readonly shellSessions = new Map<string, WindowsShellSession>();
  /**
   * Per-device queue serialising concurrent executeCommandInSession calls.
   * Without it, two terminals issuing `cd` at the same time would race on
   * the device's mutable `cwd`/`env` swap window.
   */
  private readonly sessionQueue = new SessionWorkQueue();

  /** Swap-window over the device's cwd/env state (shared protocol). */
  private readonly sessionSwap = new SessionSwapWindow<
    WindowsShellSession, { cwd: string; env: Map<string, string> }
  >({
    snapshot: () => this.snapshotShellState(),
    swapIn: (s) => this.swapInWindowsSession(s),
    captureInto: (s) => this.captureShellStateInto(s),
    restore: (b) => this.restoreShellState(b),
  });

  /**
   * Allocate a fresh cmd.exe shell session — one per terminal window.
   * Initial cwd = `%USERPROFILE%`, env is the device's seed env (copied,
   * so the session may freely mutate via `set FOO=bar` without leaking).
   */
  openShellSession(init?: { user?: string; cwd?: string; env?: Map<string, string> }): WindowsShellSession {
    const user = init?.user ?? (this.env.get('USERNAME') ?? 'User');
    const profile = this.env.get('USERPROFILE') ?? 'C:\\Users\\User';
    const env = new Map(init?.env ?? this.env);
    const session = new WindowsShellSession({
      user,
      cwd: init?.cwd ?? profile,
      env,
      comSpec: env.get('COMSPEC') ?? env.get('ComSpec'),
    });
    this.shellSessions.set(session.id, session);
    return session;
  }

  /** Tear down a shell session — the cmd.exe instance is reclaimed. */
  closeShellSession(sessionOrId: WindowsShellSession | string): void {
    const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId.id;
    const s = this.shellSessions.get(id);
    if (!s) return;
    s.dispose();
    this.shellSessions.delete(id);
  }

  /** Lookup helper for the terminal layer / tests. */
  getShellSession(id: string): WindowsShellSession | undefined {
    return this.shellSessions.get(id);
  }

  /**
   * Like `executeCommand`, but uses the per-terminal session as the swap-in
   * state holder. Calls are serialised per device so the mutation window
   * around `this.cwd` / `this.env` is never observed concurrently from
   * another terminal.
   */
  executeCommandInSession(command: string, session: WindowsShellSession): Promise<string> {
    return this.sessionQueue.run(async () => {
      if (!this.isPoweredOn) return 'Device is powered off';
      if (session.disposed) return '';
      return this.sessionSwap.within(session, () => this.executeCommand(command));
    });
  }

  /**
   * Run an arbitrary callback inside a session swap-window. Used by
   * PowerShellSubShell so the interpreter, the legacy executor, and every
   * cmd-command delegation triggered during `processLine()` observe the
   * caller terminal's cwd / env / driveCwd — not the device-wide shared
   * fields. Serialised through the same per-device queue as
   * executeCommandInSession (terminal_gap.md §7.x).
   */
  runInSession<T>(session: WindowsShellSession, fn: () => Promise<T>): Promise<T> {
    return this.sessionQueue.run(async (): Promise<T> => {
      if (session.disposed) {
        // Best-effort no-op so callers don't crash post-tear-down.
        return fn();
      }
      return this.sessionSwap.within(session, fn);
    });
  }

  /** Tab completion against a specific shell session's cwd/env. */
  getCompletionsForSession(partial: string, session: WindowsShellSession): string[] {
    if (session.disposed || !this.isPoweredOn) return [];
    return this.sessionSwap.withinSync(
      session,
      () => this.getCompletions(partial),
      { capture: false },
    );
  }

  /**
   * Active shell session during executeCommandInSession / completion swap.
   * Null outside the swap window. The bare drive-letter command and
   * `cd /d` handler consult this to update the per-drive cwd map on the
   * caller's WindowsShellSession (terminal_gap.md §6.3).
   */
  private _activeShellSession: WindowsShellSession | null = null;

  /** @internal — exposed for the cd /d and `D:` drive-switch handlers. */
  _getActiveShellSession(): WindowsShellSession | null {
    return this._activeShellSession;
  }

  private snapshotShellState() {
    return { cwd: this.cwd, env: new Map(this.env) };
  }

  private swapInWindowsSession(s: WindowsShellSession): void {
    this._activeShellSession = s;
    this.cwd = s.cwd;
    // The device env carries seed values (USERPROFILE, ComSpec, …) that
    // sub-shells consume; we don't want a session to lose them when its
    // own env doesn't define them. Merge: device defaults first, session
    // overrides on top, so user `set FOO=bar` wins but builtins survive.
    const merged = new Map<string, string>();
    for (const [k, v] of this.env) merged.set(k, v);
    for (const [k, v] of s.env) merged.set(k, v);
    this.env = merged;
  }

  private captureShellStateInto(s: WindowsShellSession): void {
    s.cwd = this.cwd;
    // Capture only the keys that the session actually owned plus any
    // newly-defined ones. Keys unchanged from the device defaults stay
    // on the device — we don't want every session to drift its own copy
    // of USERPROFILE.
    const next = new Map<string, string>();
    for (const [k, v] of this.env) {
      if (!s.env.has(k)) {
        // Newly-defined or never-owned: belongs to the session iff it
        // differs from the baseline (captured below). We can't compute
        // that here cheaply, so we err on the safe side and store it.
        next.set(k, v);
      } else if (s.env.get(k) !== v) {
        next.set(k, v);
      } else {
        next.set(k, v);
      }
    }
    s.env = next;
    // Track drive cwd map for future `cd /d` support.
    const drive = this.cwd.match(/^([A-Za-z]):/)?.[1]?.toUpperCase();
    if (drive) s.driveCwd.set(drive, this.cwd);
  }

  override setEventBus(bus: import('@/events/EventBus').IEventBus | null): void {
    super.setEventBus(bus);
    this.wireReactiveProjections();
  }

  private restoreShellState(b: { cwd: string; env: Map<string, string> }): void {
    this.cwd = b.cwd;
    this.env = b.env;
    this._activeShellSession = null;
  }

  protected override firewallFilter(
    _portName: string,
    ipPkt: IPv4Packet,
    direction: 'in' | 'out' | 'forward',
    _outPortName?: string,
  ): 'accept' | 'drop' | 'reject' {
    if (this.dynamicFirewallRules.size === 0) return 'accept';
    const ports = this.extractPorts(ipPkt);
    const dirMatch = direction === 'in' ? 'Inbound'
                   : direction === 'out' ? 'Outbound' : null;
    if (!dirMatch) return 'accept';
    const proto = ipPkt.protocol === IP_PROTO_TCP ? 'TCP'
                : ipPkt.protocol === IP_PROTO_UDP ? 'UDP'
                : ipPkt.protocol === IP_PROTO_ICMP ? 'ICMPv4' : null;
    const matchPort = (rulePort: string, actualPort: number): boolean => {
      if (!rulePort || rulePort === 'Any') return true;
      return rulePort.split(',').some((p) => p.trim() === String(actualPort));
    };
    for (const rule of this.dynamicFirewallRules.values()) {
      if (!rule.enabled) continue;
      if (rule.direction !== dirMatch) continue;
      if (rule.protocol !== 'Any' && proto && rule.protocol !== proto) continue;
      const local = direction === 'in' ? ports.dstPort : ports.srcPort;
      const remote = direction === 'in' ? ports.srcPort : ports.dstPort;
      if (!matchPort(rule.localPort, local)) continue;
      if (!matchPort(rule.remotePort, remote)) continue;
      if (rule.action === 'Block') {
        this.getBus().publish({
          topic: 'windows.firewall.drop',
          payload: {
            deviceId: this.id, hostname: this.getHostname(),
            ruleName: rule.name,
            sourceIp: ipPkt.sourceIP.toString(),
            destinationIp: ipPkt.destinationIP.toString(),
            sourcePort: ports.srcPort, destinationPort: ports.dstPort,
            protocol: proto ?? 'Any', direction: dirMatch,
          },
        });
        return 'drop';
      }
      return 'accept';
    }
    return 'accept';
  }
}
