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
import { Port } from '../hardware/Port';
import { IPAddress, SubnetMask, DeviceType } from '../core/types';
import { WindowsSshServerContext } from '../protocols/ssh/server/WindowsSshServerContext';
import { SshServerHandler } from '../protocols/ssh/server/SshServerHandler';
import { CrossVendorSshHost } from '../protocols/ssh/server/CrossVendorSshHost';
import { WindowsUserManagerAuthority } from './windows/network/WindowsUserManagerAuthority';
import { runWindowsSshClient } from './windows/network/WindowsSshClient';
import { WindowsAccountsPolicy } from './windows/security/WindowsAccountsPolicy';
import { DoskeyTable } from './windows/cli/DoskeyTable';
import { runPowerShellShim, createShimState, type PsShimState } from './windows/PowerShellCmdShim';
import type { WinCommandContext, RouteEntry, TracerouteHop } from './windows/WinCommandExecutor';
import type { WinFileCommandContext } from './windows/WinFileCommands';
import { WindowsFileSystem } from './windows/WindowsFileSystem';
import { HostsFile } from './HostsFile';
import { findDnsServerByIP } from './linux/LinuxDnsService';
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

export class WindowsPC extends EndHost {
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

  constructor(type: DeviceType = 'windows-pc', name: string = 'WindowsPC', x: number = 0, y: number = 0) {
    super(type, name, x, y);
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
    this.securityAuditProjection = new WindowsSecurityAuditProjection(
      bus, new WindowsSecurityAudit(this.eventLog), this.id,
    );
    this.eventLogProjection = new WindowsEventLogProjection(bus, this.eventLog, this.id);
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
    this.listenTcp(22, (conn) => {
      this.getSshServerHandler().register(conn, '0.0.0.0');
    });
  }

  /** Build a fresh ISshServerContext bound to this machine's NTFS / users. */
  getSshServerContext(): WindowsSshServerContext {
    return new WindowsSshServerContext(this.fs, this.userMgr, this.hostname, {}, {
      executeCmdCommand: (line: string) => this.executeCmdCommand(line),
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
  override checkPassword(username: string, password: string): boolean {
    return this.userMgr.checkPassword(username, password);
  }

  /**
   * Set / change a user's password through the SAM database. Mirrors
   * LinuxMachine.setUserPassword so the two platforms expose a parallel
   * surface to callers that don't care which OS they're talking to.
   */
  override setUserPassword(username: string, password: string): void {
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

  /**
   * Resolve a name to an IPv4 address, mirroring the Windows resolver
   * order: literal IP → hosts file → the machine's own name → DNS.
   */
  resolveHostname(name: string): IPAddress | null {
    // 1. Already a literal IP address.
    try { return new IPAddress(name); } catch { /* not an IP */ }

    // 2. Static hosts file.
    const ip = this.readHostsFile().resolve(name, 4);
    if (ip) {
      try { return new IPAddress(ip); } catch { /* malformed entry */ }
    }

    // 3. The machine's own name always resolves to loopback.
    if (name.toLowerCase() === this.hostname.toLowerCase()) {
      return new IPAddress('127.0.0.1');
    }

    // 4. DNS fallback — query every statically/DHCP-configured server.
    for (const cfg of this.dnsConfig.values()) {
      for (const server of cfg.servers) {
        const dns = findDnsServerByIP(server);
        if (!dns) continue;
        const records = dns.query(name, 'A');
        if (records.length > 0) {
          try { return new IPAddress(records[0].value); } catch { /* skip */ }
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
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') {
        inQuote = !inQuote;
      } else if (ch === ' ' && !inQuote) {
        if (current) { parts.push(current); current = ''; }
      } else {
        current += ch;
      }
    }
    if (current) parts.push(current);
    return parts;
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
      executeTraceroute: (target: IPAddress, maxHops?: number) =>
        this.executeTraceroute(target, maxHops) as Promise<TracerouteHop[]>,

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
      addStaticARP: (ip: string, mac: any, iface: string) => this.addStaticARP(ip, mac, iface),
      deleteARP: (ip: string) => this.deleteARP(ip),
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

      // Port-proxy rules (netsh interface portproxy)
      portProxy: this.portProxyTable,
      // Event log provider — wevtutil queries against Security/System.
      eventLog: this.eventLog,
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
      case 'nslookup': return this.cmdNslookup(args);
      // ping / tracert are async — no sync path.
      default: return null;
    }
  }

  private cmdSysteminfo(): string {
    const lines: string[] = [];
    const os = this.getIdentity().os;
    lines.push(`Host Name:                 ${this.hostname}`);
    lines.push(`OS Name:                   ${os.prettyName}`);
    lines.push(`OS Version:                ${os.version}`);
    lines.push(`OS Manufacturer:           Microsoft Corporation`);
    lines.push(`OS Configuration:          Member Workstation`);
    lines.push(`OS Build Type:             Multiprocessor Free`);
    const bootedAt = this.getLifecycle().bootedAt();
    if (bootedAt) {
      lines.push(`System Boot Time:          ${bootedAt.toLocaleString('en-US')}`);
    }
    lines.push(`System Manufacturer:       ${this.hardware.manufacturer}`);
    lines.push(`System Model:              ${this.hardware.productName}`);
    lines.push(`System Type:               x64-based PC`);
    lines.push(...this.systeminfoHardwareLines());
    lines.push(`Network Card(s):           ${this.ports.size} NIC(s) Installed.`);
    let idx = 1;
    for (const [name, port] of this.ports) {
      const displayName = name.replace(/^eth/, 'Ethernet ');
      lines.push(`                           [${String(idx).padStart(2, '0')}]: Intel(R) Ethernet Connection`);
      const ip = port.getIPAddress();
      if (ip) {
        lines.push(`                                 Connection Name: ${displayName}`);
        lines.push(`                                 DHCP Enabled:    ${this.isDHCPConfigured(name) ? 'Yes' : 'No'}`);
        lines.push(`                                 IP address(es)`);
        lines.push(`                                 [01]: ${ip}`);
      } else {
        lines.push(`                                 Connection Name: ${displayName}`);
        lines.push(`                                 Status:          Media disconnected`);
      }
      idx++;
    }
    return lines.join('\n');
  }

  /**
   * The processor / BIOS / memory block of `systeminfo`, rendered from the
   * host's hardware inventory so it stays coherent with the device model.
   */
  private systeminfoHardwareLines(): string[] {
    const { cpu, memory, firmware } = this.hardware;
    const mb = (kib: number): string =>
      `${Math.round(kib / 1024).toLocaleString('en-US')} MB`;
    return [
      `Processor(s):              ${cpu.sockets} Processor(s) Installed.`,
      `                           [01]: Intel64 Family ${cpu.cpuFamily} ` +
        `Model ${cpu.model} Stepping ${cpu.stepping} ${cpu.vendor} ` +
        `~${cpu.clockMhz} Mhz`,
      `BIOS Version:              ${firmware.vendor} ${firmware.version}, ` +
        `${firmware.releaseDate}`,
      `Total Physical Memory:     ${mb(memory.totalKib)}`,
      `Available Physical Memory: ${mb(memory.availableKib)}`,
      `Virtual Memory: Max Size:  ${mb(memory.totalKib + memory.swapTotalKib)}`,
    ];
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

  /**
   * vol — print volume label + serial.  Real cmd output:
   *   Volume in drive C has no label.
   *   Volume Serial Number is XXXX-XXXX
   */
  /**
   * `doskey NAME=BODY` installs a macro consumed by every subsequent
   * cmd dispatch. Without args, lists current macros (cmd.exe form).
   */
  private cmdDoskey(args: string[]): string {
    if (args.length === 0) {
      return this.doskey.entries().map(e => `${e.head}=${e.body}`).join('\n');
    }
    const joined = args.join(' ');
    if (!joined.includes('=')) {
      return this.doskey.entries().map(e => `${e.head}=${e.body}`).join('\n');
    }
    this.doskey.define(joined);
    return '';
  }

  private cmdVol(args: string[]): string {
    const arg = (args[0] ?? 'C:').toUpperCase().replace(/[:\\]+$/, '');
    const letter = arg.charAt(0) || 'C';
    // Single source of truth — same serial `dir` prints for this volume.
    const serial = this.fs.getVolumeSerialNumber(letter);
    return [
      ` Volume in drive ${letter} has no label.`,
      ` Volume Serial Number is ${serial}`,
    ].join('\n');
  }

  /** chcp — print/set active code page.  Defaults to 65001 (UTF-8). */
  private cmdChcp(args: string[]): string {
    if (args.length === 0) return 'Active code page: 65001';
    const cp = parseInt(args[0], 10);
    if (isNaN(cp)) return 'Invalid code page';
    return `Active code page: ${cp}`;
  }

  /** date /t — print today's date in MM/DD/YYYY (en-US). */
  private cmdDate(args: string[]): string {
    const wantOnly = args.includes('/t') || args.includes('/T');
    void wantOnly;
    const d = new Date();
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dow = days[d.getDay()];
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dow} ${mm}/${dd}/${yyyy}`;
  }

  /** time /t — print current time in h:mm AM/PM (en-US). */
  private cmdTime(_args: string[]): string {
    const d = new Date();
    const h24 = d.getHours();
    const min = String(d.getMinutes()).padStart(2, '0');
    const tt = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return `${h12}:${min} ${tt}`;
  }

  /** `start <program>` — simulator stub: returns silently (real cmd
   *  detaches a new process and returns immediately). */
  /**
   * `start <command>` — launch a program in a new session. Spawns into the
   * shared process manager so both `tasklist` and `Get-Process` see it.
   * Returns an empty string on success (matches cmd.exe semantics).
   */
  private cmdStart(args: string[]): string {
    // Strip cmd-style flags (/B, /WAIT, /MIN, ...) and the optional "title"
    // argument that precedes the executable.
    const filtered = args.filter(a => !a.startsWith('/'));
    if (filtered.length === 0) return '';
    let target = filtered[0].replace(/^["']|["']$/g, '');
    // `start "title" prog ...` form: drop the title token.
    if (filtered.length >= 2 && /^"[^"]*"$/.test(args.find(a => /^"[^"]*"$/.test(a)) ?? '')) {
      target = filtered[1].replace(/^["']|["']$/g, '');
    }
    if (!target) return '';
    const leaf = target.split(/[\\/]/).pop() ?? target;
    const imageName = /\.exe$/i.test(leaf) ? leaf : `${leaf}.exe`;
    const parent = this.procMgr.getAllProcesses().find(p => p.name.toLowerCase() === 'explorer.exe');
    const ppid = parent?.pid ?? 1;
    this.procMgr.spawnProcess(imageName, ppid, this.userMgr.currentUser, {
      session: 'Console', sessionId: 1,
    });
    return '';
  }

  /** `setx VAR VALUE [/M]` — persists an environment variable. */
  private cmdSetx(args: string[]): string {
    const machine = args.some(a => a.toUpperCase() === '/M');
    const filtered = args.filter(a => a.toUpperCase() !== '/M');
    if (filtered.length < 2) {
      return 'ERROR: Invalid syntax. Type "SETX /?" for usage.';
    }
    const name = filtered[0];
    const value = filtered.slice(1).join(' ').replace(/^"(.*)"$/, '$1');
    this.env.set(name, value);
    return machine
      ? `SUCCESS: Specified value was saved.`
      : `SUCCESS: Specified value was saved.`;
  }

  /**
   * `schtasks` — query/create/delete entries in the shared
   * `scheduledTasks` map so PowerShell's `Get-ScheduledTask` and
   * `Register-ScheduledTask` see the same data.
   */
  private cmdSchtasks(args: string[]): string {
    if (this.svcMgr.getService('Schedule')?.state !== 'Running') {
      return `ERROR: The Task Scheduler service is not running.`;
    }
    const action = args[0]?.toLowerCase();
    const flagIdx = (name: string) => args.findIndex(a => a.toLowerCase() === name);
    const tn      = (() => { const i = flagIdx('/tn'); return i >= 0 ? args[i + 1] : undefined; })();

    if (action === '/query') {
      const filtered = tn
        ? Array.from(this.scheduledTasks.values()).filter(t => t.taskName.toLowerCase() === tn.toLowerCase())
        : Array.from(this.scheduledTasks.values());
      const lines = [
        'Folder: \\',
        'TaskName                                 Next Run Time          Status',
        '======================================== ====================== ===============',
      ];
      for (const t of filtered) {
        lines.push(`${t.taskName.padEnd(40)} N/A                    ${t.state}`);
      }
      return lines.join('\n');
    }
    if (action === '/create') {
      if (!tn) return 'ERROR: The required parameter "/TN" is missing.';
      this.scheduledTasks.set(tn.toLowerCase(), { taskName: tn, taskPath: '\\', state: 'Ready' });
      return `SUCCESS: The scheduled task "${tn}" has successfully been created.`;
    }
    if (action === '/delete') {
      if (!tn) return 'ERROR: The required parameter "/TN" is missing.';
      const removed = this.scheduledTasks.delete(tn.toLowerCase());
      return removed
        ? `SUCCESS: The scheduled task "${tn}" was successfully deleted.`
        : `ERROR: The system cannot find the file specified.`;
    }
    if (action === '/run' || action === '/end' || action === '/change') {
      return 'SUCCESS: The scheduled task was created/modified successfully.';
    }
    return 'SCHTASKS /parameter [arguments]\n\nDescription:\n    Enables an administrator to create, delete, query, change, run, and\n    end scheduled tasks on a local or remote computer.';
  }

  /** `nbtstat -n / -a / -A` — returns a minimal local NetBIOS name table. */
  private cmdNbtstat(args: string[]): string {
    const flag = args[0]?.toLowerCase();
    if (flag === '-n') {
      return [
        '',
        '    Node IpAddress: [0.0.0.0] Scope Id: []',
        '',
        '                       NetBIOS Local Name Table',
        '',
        '       Name               Type         Status',
        '    ---------------------------------------------',
        `    ${this.hostname.toUpperCase().padEnd(16)} <00>  UNIQUE      Registered`,
        `    WORKGROUP        <00>  GROUP       Registered`,
        '',
      ].join('\n');
    }
    return 'NBTSTAT [ [-a RemoteName] [-A IP address] [-c] [-n] [-r] [-R] [-RR] [-s] [-S] [interval] ]';
  }

  /** `wmic logicaldisk get name` / minimal WMI stub. */
  private cmdWmic(args: string[]): string {
    if (args.length === 0) return 'wmic:root\\cli>';
    const joined = args.join(' ').toLowerCase();
    if (joined.includes('logicaldisk') && joined.includes('get name')) {
      return 'Name  \nC:    ';
    }
    if (joined.includes('os get caption')) {
      return 'Caption                              \nMicrosoft Windows 10 Enterprise      ';
    }
    if (joined.includes('cpu get name')) {
      return 'Name                                              \nIntel(R) Core(TM) i7 CPU @ 2.50GHz                ';
    }
    return '';
  }

  /** `reg query | add | delete` — bridges cmd.exe's reg.exe to the
   *  PowerShell registry provider so changes made from cmd are visible
   *  from `Get-ItemProperty HKCU:\…` in PS (and vice versa). */
  private cmdReg(args: string[]): string {
    if (args.length === 0) {
      return 'ERROR: Invalid syntax. Type "REG /?" for usage.';
    }
    const action = args[0].toLowerCase();
    const rawKey = args[1] ?? '';
    // `reg.exe` uses unprefixed HKCU\..., PS provider expects HKCU:\...
    const psKey = rawKey.replace(/^(HKCU|HKLM|HKCR|HKU|HKCC)\\/i, '$1:\\');
    if (action === 'query') {
      if (!this.registry.testPath(psKey)) {
        return 'ERROR: The system was unable to find the specified registry key or value.';
      }
      const vIdx = args.findIndex(a => a.toLowerCase() === '/v');
      const recurse = args.some(a => a.toLowerCase() === '/s');
      const valueFilter = vIdx >= 0 ? args[vIdx + 1] : undefined;
      return this.formatRegQuery(rawKey, psKey, valueFilter, recurse);
    }
    if (action === 'add') {
      const vIdx = args.findIndex(a => a.toLowerCase() === '/v');
      const tIdx = args.findIndex(a => a.toLowerCase() === '/t');
      const dIdx = args.findIndex(a => a.toLowerCase() === '/d');
      this.registry.newItem(psKey, true);
      if (vIdx >= 0) {
        const valueName = args[vIdx + 1];
        const data: string | number = dIdx >= 0
          ? args[dIdx + 1].replace(/^"(.*)"$/, '$1')
          : '';
        const typ = tIdx >= 0 ? args[tIdx + 1].toUpperCase() : 'REG_SZ';
        const coerced: string | number = typ === 'REG_DWORD' ? Number(data) : data;
        this.registry.setItemProperty(psKey, valueName, coerced);
      }
      return 'The operation completed successfully.';
    }
    if (action === 'delete') {
      const vIdx = args.findIndex(a => a.toLowerCase() === '/v');
      if (vIdx >= 0) {
        this.registry.removeItemProperty(psKey, args[vIdx + 1]);
      } else {
        this.registry.removeItem(psKey, true);
      }
      return 'The operation completed successfully.';
    }
    return 'ERROR: Invalid syntax.';
  }

  /**
   * Render a `reg query` result in the canonical reg.exe layout:
   *   <RootKey>\<Sub>\<Sub>
   *       Name    REG_TYPE    Value
   * Optionally filters to a single value (`/v Name`) or recurses (`/s`).
   */
  private formatRegQuery(rawKey: string, psKey: string, valueFilter: string | undefined, recurse: boolean): string {
    const lines: string[] = [];
    const visit = (currentRaw: string, currentPs: string): void => {
      const values = this.registry.getItemPropertyValues(currentPs);
      const subkeys = this.registry.listSubkeyNames(currentPs);
      lines.push('');
      lines.push(currentRaw);
      if (values) {
        for (const [name, val] of Object.entries(values)) {
          if (valueFilter && name.toLowerCase() !== valueFilter.toLowerCase()) continue;
          const t = typeof val === 'number' ? 'REG_DWORD' : 'REG_SZ';
          const v = typeof val === 'number' ? `0x${val.toString(16)}` : String(val);
          lines.push(`    ${name}    ${t}    ${v}`);
        }
      }
      if (recurse) {
        for (const sub of subkeys) {
          visit(`${currentRaw}\\${sub}`, `${currentPs}\\${sub}`);
        }
      }
    };
    visit(rawKey, psKey);
    lines.push('');
    return lines.join('\n');
  }

  /** nslookup command implementation for Windows */
  private cmdNslookup(args: string[]): string {
    const host = args.find(a => !a.startsWith('-')) ?? '';
    // The static hosts table (including the machine's own name) is
    // answered locally, ahead of any DNS query — same order as the
    // resolveHostname() resolver.
    if (host && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const hostsIp = this.readHostsFile().resolve(host, 4)
        ?? (host.toLowerCase() === this.hostname.toLowerCase() ? '127.0.0.1' : null);
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
    // Allow specifying server as second argument: nslookup domain server
    return executeNslookup(args, resolverIP);
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

  /** Get the user manager (for PowerShellExecutor and other integrations) */
  getUserManager(): WindowsUserManager { return this.userMgr; }

  /** Get the service manager (for PowerShellExecutor and other integrations) */
  getServiceManager(): WindowsServiceManager { return this.svcMgr; }

  /** Get the process manager (for PowerShellExecutor and other integrations) */
  getProcessManager(): WindowsProcessManager { return this.procMgr; }

  /** runas command — simplified non-interactive version */
  private cmdRunas(args: string[]): string {
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

    // Switch context, run command, (in simulation, stay switched)
    const prevUser = this.userMgr.currentUser;
    this.setCurrentUser(user.name);
    // For simulation, just execute the command as the new user
    // and return the result (user stays switched for simplicity)
    return this.executeCmdCommand(cmdParts.join(' ')) as unknown as string;
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
  private wsExecQueue: Promise<unknown> = Promise.resolve();

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
    const run = async () => {
      if (!this.isPoweredOn) return 'Device is powered off';
      if (session.disposed) return '';
      const baseline = this.snapshotShellState();
      this.swapInWindowsSession(session);
      try {
        const out = await this.executeCommand(command);
        this.captureShellStateInto(session);
        return out;
      } finally {
        this.restoreShellState(baseline);
      }
    };
    const promise = this.wsExecQueue.then(run, run) as Promise<string>;
    this.wsExecQueue = promise.catch(() => undefined);
    return promise;
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
    const run = async (): Promise<T> => {
      if (session.disposed) {
        // Best-effort no-op so callers don't crash post-tear-down.
        return fn();
      }
      const baseline = this.snapshotShellState();
      this.swapInWindowsSession(session);
      try {
        const out = await fn();
        this.captureShellStateInto(session);
        return out;
      } finally {
        this.restoreShellState(baseline);
      }
    };
    const promise = this.wsExecQueue.then(run, run) as Promise<T>;
    this.wsExecQueue = promise.catch(() => undefined);
    return promise;
  }

  /** Tab completion against a specific shell session's cwd/env. */
  getCompletionsForSession(partial: string, session: WindowsShellSession): string[] {
    if (session.disposed || !this.isPoweredOn) return [];
    const baseline = this.snapshotShellState();
    this.swapInWindowsSession(session);
    try {
      return this.getCompletions(partial);
    } finally {
      this.restoreShellState(baseline);
    }
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

  private restoreShellState(b: { cwd: string; env: Map<string, string> }): void {
    this.cwd = b.cwd;
    this.env = b.env;
    this._activeShellSession = null;
  }
}
