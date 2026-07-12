/**
 * WindowsPC - Windows workstation with cmd.exe terminal
 *
 * Extends EndHost (which provides the full L2/L3 network stack).
 * Delegates command execution to modular handlers under windows/.
 *
 * Architecture follows linux/LinuxPC.ts pattern:
 *   - WindowsFileSystem (VFS) in windows/WindowsFileSystem.ts
 *   - Network commands in Win*.ts modules (WinIpconfig, WinNetsh, etc.)
 *   - cmd.exe commands migrated to command-kernel (windows/command-kernel/commands/)
 *   - WindowsPC orchestrates both via context objects
 *
 * PowerShell is implemented as a sub-shell (ISubShell) at the terminal
 * session level, not at the device level. This device only handles cmd.exe.
 */

import { EndHost, PingResult } from './EndHost';
import { WindowsDnsCache } from './windows/WinDnsCache';
import { RRType } from '../dns/wire/RRType';
import type { ARecordData } from '../dns/wire/ResourceRecord';
import type { UserAccountHost } from '../equipment/HostCapabilities';
import { Port } from '../hardware/Port';
import { IPAddress, SubnetMask, DeviceType, type IPv4Packet, type TCPPacket, IP_PROTO_TCP, IP_PROTO_UDP, IP_PROTO_ICMP, createIPv4Packet } from '../core/types';
import { WindowsSshServerContext } from '../protocols/ssh/server/WindowsSshServerContext';
import { SshServerHandler } from '../protocols/ssh/server/SshServerHandler';
import type { TcpStream } from '../tcp/types';
import { CrossVendorSshHost } from '../protocols/ssh/server/CrossVendorSshHost';
import { WindowsUserManagerAuthority } from './windows/network/WindowsUserManagerAuthority';
import { runWindowsSshClient } from './windows/network/WindowsSshClient';
import { runWindowsSftpClient } from './windows/network/WindowsSftpClient';
import { runWindowsScpClient } from './windows/network/WindowsScpClient';
import { WindowsAccountsPolicy } from './windows/security/WindowsAccountsPolicy';
import { DoskeyTable } from './windows/cli/DoskeyTable';
import { createShimState, type PsShimState } from './windows/PowerShellCmdShim';
import { PSInterpreter, PSRuntimeError } from '@/powershell/interpreter/PSInterpreter';
import { createWindowsPSProviders } from '@/powershell/providers/WindowsPSProviders';
import type { VpnConnectionInfo } from '@/powershell/providers/PSProviders';
import type { WinCommandContext, RouteEntry, TracerouteHop } from './windows/WinCommandExecutor';
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
import { WindowsServiceManager, START_TYPE_CODES } from './windows/WindowsServiceManager';
import { WindowsAuditPolicy, cmdAuditpol } from './windows/WindowsAuditPolicy';
import { WindowsWinRmConfig, cmdWinrm } from './windows/WindowsWinRmConfig';
import { WindowsProcessManager } from './windows/WindowsProcessManager';
import { HostClock } from './host/lifecycle/HostClock';
import { PSRegistryProvider, WINDOWS_CLIENT_PRODUCT_IDENTITY, WINDOWS_SERVER_PRODUCT_IDENTITY } from './windows/PSRegistryProvider';
import { PSEventLogProvider } from './windows/PSEventLogProvider';
import { cmdIpconfig } from './windows/WinIpconfig';
import { cmdNetsh, resolveAdapterName as resolveAdapterNameUtil } from './windows/WinNetsh';
import { cmdArp } from './windows/WinArp';
import { cmdGetmac } from './windows/WinGetmac';
import { cmdRoute } from './windows/WinRoute';
import { cmdNetUser, cmdNetLocalgroup } from './windows/WinNetUser';
import { cmdSc } from './windows/WinSc';
import { cmdNetStart, cmdNetStop } from './windows/WinNetStart';
import { type NetUseEntry } from './windows/WinNetUse';
import { cmdNetShare } from './windows/WinNetShare';
import { SmbShareTable } from './windows/server/smb/SmbShareTable';
import { SmbSessionTable } from './windows/server/smb/SmbSessionTable';
import { SmbServerHandler } from './windows/server/smb/SmbServer';
import { dialSmbShare, type SmbDialResult } from './windows/server/smb/SmbClient';
import { WinRmServerHandler } from './windows/server/winrm/WinRmServer';
import { LdapServerHandler } from './windows/server/ad/ldap/LdapServer';
import { selfSignedLdapCert } from './windows/server/ad/ldap/ldapStartTls';
import { getForestForDomain } from './windows/server/ad/forest/Forest';
import { KdcSessionHandler } from '@/network/kerberos/KdcSession';
import { dialKdc } from '@/network/kerberos/KerberosClient';
import { KerberosTicketCache } from '@/network/kerberos/KerberosTicketCache';
import { ticketFlagsToHex } from '@/network/kerberos/codec';
import type { TicketFlags } from '@/network/kerberos/types';
import { KerberosSignalStore } from '@/network/kerberos/observables';
import { KerberosSignalRefreshActor } from '@/network/kerberos/actors/KerberosSignalRefreshActor';
import {
  ReplicationServerHandler, AD_REPLICATION_PORT, pullReplication,
  type ReplicationPullResult, type ReplicationLogEntry,
} from './windows/server/ad/replication/ReplicationSession';
import { ReplicationSignalStore } from './windows/server/ad/replication/observables';
import { ReplicationSignalRefreshActor } from './windows/server/ad/replication/actors/ReplicationSignalRefreshActor';
import { AdcsSignalStore } from './windows/server/adcs/observables';
import { AdcsSignalRefreshActor } from './windows/server/adcs/actors/AdcsSignalRefreshActor';
import { RdpSignalStore } from './windows/server/rdp/observables';
import { RdpSignalRefreshActor } from './windows/server/rdp/actors/RdpSignalRefreshActor';
import { ClusterSignalStore } from './windows/server/cluster/observables';
import { ClusterSignalRefreshActor } from './windows/server/cluster/actors/ClusterSignalRefreshActor';
import { DfsSignalStore } from './windows/server/dfs/observables';
import { DfsSignalRefreshActor } from './windows/server/dfs/actors/DfsSignalRefreshActor';
import { dialWinRm, type WinRmDialResult } from './windows/server/winrm/WinRmClient';
import { type DomainMembership, type DomainSession, parseDomainQualifiedUser } from './windows/domain/DomainTypes';
import { joinDomain, type DomainJoinResult } from './windows/domain/DomainJoinClient';
import { logonDomainUser } from './windows/domain/DomainLogonClient';
import { pullGroupPolicy } from './windows/domain/GpoPullClient';
import { dialHttp as dialHttpClient, parseHttpUrl } from '@/network/http/HttpClient';
import type { GpoSettings } from './windows/server/ad/AdTypes';
import { WindowsCertStore } from './windows/CertStore';
import { DFSR_PORT, DfsrServerHandler } from './windows/server/dfs/DfsReplicationGroup';
import { WindowsRdpConfig } from './windows/WindowsRdpConfig';
import { RDP_PORT, RdpServerHandler, dialRdp, type RdpDialResult } from './windows/server/rdp/RdpSession';
import { WindowsWsusClientConfig } from './windows/WindowsWsusClientConfig';
import { WSUS_PORT, WsusServerHandler, queryWsusApprovedUpdates, type WsusUpdate } from './windows/server/wsus/WsusRole';
import { LPD_PORT, LpdServerHandler } from './windows/server/print/LpdTransport';
import { WindowsLicensingState } from './windows/licensing/LicensingState';
import { generateSelfSignedCertificate } from '@/network/pki/SelfSignedCertificate';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import { runRunasNonInteractive, runAsUser } from './windows/WinRunas';
import type { RunasHost } from './windows/WinRunas';
import { executeNslookup } from './linux/LinuxDnsService';
import type { DnsQueryFn } from '../dns/compat/DnsWireCompat';
import { SessionWorkQueue } from './host/session/SessionWorkQueue';
import { SessionSwapWindow } from './host/session/SessionSwapWindow';
import * as WinSys from './windows/WinSystemCommands';
import { WIN_VER_STRING } from './windows/WindowsVersion';
import { createWindowsHostShell } from './windows/command-kernel/createWindowsHostShell';
import type { WinIpsecMutableState, WinNetshFeatureState } from './windows/command-kernel/WindowsMachineApi';
import type { CmdInterpreter } from './windows/command-kernel/CmdInterpreter';
import { lowercaseCommandNames } from './windows/command-kernel/ast/lowercaseCommandNames';
import { resolveWindowsUser } from './windows/command-kernel/WindowsUser';
import type { CommandRegistry } from '@/command-kernel/registry/command-registry';
import type { WindowsIPv6RouteEntry as WinIPv6RouteEntry, WindowsGpResult, DomainControllerLocation, DomainControllerDiagnostics, KerberosCachedTicket, DomainTrustDirection } from '@/command-kernel/machine/types';
import { createSession } from '@/command-kernel/session/types';
import { PipeBuffer } from '@/command-kernel/io/pipe-buffer';
import { ShellError, CommandNotFoundError } from '@/command-kernel/errors';
import type { ScriptNode } from '@/command-kernel/ast/nodes';

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
  /** Lazily-built command-kernel shell (registry + interpreter) for migrated cmd builtins. */
  private commandKernelShell: { registry: CommandRegistry; interpreter: CmdInterpreter } | null = null;
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
  /** Per-interface DHCP class id (option 60 vendor class), set via `ipconfig /setclassid`. */
  private dhcpClassIds: Map<string, string> = new Map();
  /** Per-interface DHCPv6 class id, set via `ipconfig /setclassid6`. */
  private dhcpClassIds6: Map<string, string> = new Map();
  readonly dnsCache = new WindowsDnsCache();
  /** DHCP client trace flag */
  private dhcpTraceEnabled: boolean = false;
  /** Primary DNS suffix (set via netsh dnsclient set global) */
  private dnsSuffix: string = '';
  /** User and group manager (access control / privileges) */
  private userMgr: WindowsUserManager;
  /** Domain-join state (`Add-Computer`/`netdom join`) — null while this machine is in a workgroup (PRD-Windows-Server.md §5 P6). */
  private domainMembership: DomainMembership | null = null;
  /** The active domain logon (`LAB\alice`/`alice@lab.local`), if any — distinct from `userMgr.currentUser`, which domain logon also updates for prompt/env-var purposes. */
  private domainSession: DomainSession | null = null;
  /** Real Kerberos ticket cache (PRD-Windows-Server-Advanced.md §5 P2) — populated by an actual AS exchange as a side effect of domain logon, backing `klist`. */
  private readonly kerberosTicketCache: KerberosTicketCache = new KerberosTicketCache();
  /** One entry per `replicateFrom` cycle, annotated intra-/inter-site (PRD-Windows-Server-Advanced.md §5 P6) — this simulator's minimal stand-in for a real replication event log (full observability arrives at §5 P12). */
  private readonly replicationLog: ReplicationLogEntry[] = [];
  /** This DC's own StartTLS identity (PRD-Windows-Server-Advanced.md §5 P11) — lazily created once and reused across connections, mirroring a real DC's stable machine certificate. */
  private ldapStartTlsIdentity: ReturnType<typeof selfSignedLdapCert> | null = null;
  /** Remote Desktop (PRD-Windows-Server-Advanced.md §5 P17) — disabled by default; toggled via `Enable-RemoteDesktop`. */
  readonly rdp: WindowsRdpConfig = new WindowsRdpConfig();
  /** Windows Update client redirection toward a WSUS server (PRD-Windows-Server-Advanced.md §5 P19) — unset by default (points at Windows Update directly, out of this simulator's scope); set via `Set-WUSettings -WUServer`. */
  readonly wsus: WindowsWsusClientConfig = new WindowsWsusClientConfig();
  /** Activation/licensing state (PRD-Windows-Server-Advanced.md §5 P21) — ships on every SKU; toggled via `slmgr /ipk`/`/ato`. */
  readonly licensing: WindowsLicensingState = new WindowsLicensingState();
  /** This host's own RDP TLS identity (§5 P17) — lazily created once, mirroring `ldapStartTlsIdentity`'s own convention. */
  private rdpTlsIdentity: ReturnType<typeof generateSelfSignedCertificate> | null = null;
  /**
   * Observable read-models (PRD-Windows-Server-Advanced.md §5 P12) — purely
   * additive, no existing behavior depends on these. `KdcSessionHandler`/
   * `ReplicationServerHandler`/`replicateFrom` only publish `kerberos.*`/
   * `replication.*` events; a `KerberosSignalRefreshActor`/
   * `ReplicationSignalRefreshActor` subscribing on this device's bus (see
   * `wireReactiveProjections`) is what actually feeds these stores.
   */
  private readonly kerberosSignals = new KerberosSignalStore();
  private readonly replicationSignals = new ReplicationSignalStore();
  private kerberosSignalActor: KerberosSignalRefreshActor | null = null;
  private replicationSignalActor: ReplicationSignalRefreshActor | null = null;
  /** PRD Phase 23 (§5 P23): same signal-store/refresh-actor convention, transverse to the new roles §5 P13-P22 named by the PRD (`adcs.*`/`rdp.*`/`cluster.*`/`dfs.*`). */
  private readonly adcsSignals = new AdcsSignalStore();
  private readonly rdpSignals = new RdpSignalStore();
  private readonly clusterSignals = new ClusterSignalStore();
  private readonly dfsSignals = new DfsSignalStore();
  private adcsSignalActor: AdcsSignalRefreshActor | null = null;
  private rdpSignalActor: RdpSignalRefreshActor | null = null;
  private clusterSignalActor: ClusterSignalRefreshActor | null = null;
  private dfsSignalActor: DfsSignalRefreshActor | null = null;
  /** `Cert:\LocalMachine\My` stand-in (PRD-Windows-Server-Advanced.md §5 P13/P14) — available on every Windows host, not just servers, matching real Windows' personal certificate store. */
  private readonly certStore = new WindowsCertStore();
  getCertStore(): WindowsCertStore { return this.certStore; }
  /** LSA account policy mirrored by `net accounts`. */
  readonly accountsPolicy: WindowsAccountsPolicy = new WindowsAccountsPolicy();
  /** cmd.exe doskey macro table. */
  readonly doskey: DoskeyTable = new DoskeyTable();
  /** Per-device PowerShell shim state (functions, aliases, vars). */
  readonly psShimState: PsShimState = createShimState();
  /** Lazy full PowerShell interpreter reused across `powershell -Command`. */
  private psInterpreter: PSInterpreter | null = null;

  getWindowsEdition(): 'client' | 'server' { return 'client'; }

  getPowerShellInterpreter(): PSInterpreter {
    if (!this.psInterpreter) {
      this.psInterpreter = new PSInterpreter(createWindowsPSProviders(this, {
        registry: this.registry,
        eventLog: this.eventLog,
        network: {
          extraIPs: this.extraIPs,
          extraRoutes: this.extraRoutes,
          adapterOverrides: this.adapterOverrides,
          dynamicFirewallRules: this.dynamicFirewallRules,
          networkProfiles: this.networkProfiles,
        },
        vpn: { vpnConnections: this.vpnConnections },
      }), { edition: this.getWindowsEdition() });
    }
    return this.psInterpreter;
  }
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
  readonly vpnConnections: Map<string, VpnConnectionInfo> = new Map();
  /** In-memory registry hive (HKLM / HKCU). */
  readonly registry: PSRegistryProvider = new PSRegistryProvider(
    this.getDeviceType() === 'windows-server' ? WINDOWS_SERVER_PRODUCT_IDENTITY : WINDOWS_CLIENT_PRODUCT_IDENTITY,
  );

  /**
   * Shared scheduled-task table. Both `schtasks` (cmd) and the Get/Register/
   * Unregister-ScheduledTask cmdlets read and write here so a task created
   * from one shell is visible from the other.
   */
  readonly scheduledTasks: Map<string, WinSys.WinScheduledTask> = new Map([
    ['googleupdatetaskuser',           { taskName: 'GoogleUpdateTaskUser',            taskPath: '\\',                         state: 'Ready' }],
    ['onedrive standalone update task',{ taskName: 'OneDrive Standalone Update Task', taskPath: '\\',                         state: 'Ready' }],
    ['.net framework ngen v4.0.30319', { taskName: '.NET Framework NGEN v4.0.30319',  taskPath: '\\Microsoft\\Windows\\.NET', state: 'Ready' }],
    ['simtesttask',                    { taskName: 'SimTestTask',                     taskPath: '\\',                         state: 'Ready' }],
  ]);
  /** Event-log store. */
  readonly eventLog: PSEventLogProvider = new PSEventLogProvider();
  /** `auditpol` subcategory state — gates 4657/4670 object-access auditing. */
  readonly auditPolicy: WindowsAuditPolicy = new WindowsAuditPolicy();
  /** WinRM / PowerShell Remoting state — off by default until `Enable-PSRemoting`. */
  readonly winrm: WindowsWinRmConfig = new WindowsWinRmConfig();
  /** SMB share table (`net share` / `New-SmbShare`) — instance-owned (PRD-Windows-Server.md §7 risk 6). */
  readonly smbShares: SmbShareTable = new SmbShareTable();
  /** `net use` drive-letter mappings — instance-owned. */
  readonly netUseTable: Map<string, NetUseEntry> = new Map();
  /** Live inbound SMB sessions (`Get-SmbSession` / `net session`). */
  readonly smbSessions: SmbSessionTable = new SmbSessionTable();

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
    this.userMgr.attachPolicy(this.accountsPolicy);
    // Documents the real account roster (name/password/groups) next to the
    // other sample data files (numbers.txt) — driven entirely by userMgr so
    // it can never drift from the accounts that actually exist.
    this.fs.createFile('C:\\users.txt', this.userMgr.renderUsersDoc());
    this.svcMgr = new WindowsServiceManager();
    this.procMgr = new WindowsProcessManager();
    this.procMgr.attachServiceManager(this.svcMgr, () => this.simulatedDate().getTime());
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
      bus, new WindowsSecurityAudit(this.eventLog), this.id, this.auditPolicy,
    );
    this.eventLogProjection?.dispose();
    this.eventLog.attachBus(bus, this.id);
    this.eventLogProjection = new WindowsEventLogProjection(bus, this.eventLog, this.id);
    this.servicePortProjection?.dispose();
    this.servicePortProjection = new WindowsServicePortProjection(bus, this.id, this.socketTable);
    this.portProxySocketProjection = new PortProxySocketProjection(bus, this.id, this.socketTable);
    this.portProxyTable.attachBus(bus, this.id);
    this.rdp.sessions.attachBus(bus, this.getHostname());

    this.kerberosSignalActor?.stop();
    this.kerberosSignalActor = new KerberosSignalRefreshActor(bus, this.getHostname(), this.kerberosSignals);
    this.kerberosSignalActor.start();
    this.replicationSignalActor?.stop();
    this.replicationSignalActor = new ReplicationSignalRefreshActor(bus, this.getHostname(), this.replicationSignals);
    this.replicationSignalActor.start();
    this.adcsSignalActor?.stop();
    this.adcsSignalActor = new AdcsSignalRefreshActor(bus, this.getHostname(), this.adcsSignals);
    this.adcsSignalActor.start();
    this.rdpSignalActor?.stop();
    this.rdpSignalActor = new RdpSignalRefreshActor(bus, this.getHostname(), this.rdpSignals);
    this.rdpSignalActor.start();
    this.clusterSignalActor?.stop();
    this.clusterSignalActor = new ClusterSignalRefreshActor(bus, this.getHostname(), this.clusterSignals);
    this.clusterSignalActor.start();
    this.dfsSignalActor?.stop();
    this.dfsSignalActor = new DfsSignalRefreshActor(bus, this.getHostname(), this.dfsSignals);
    this.dfsSignalActor.start();

    this._recoveryRunOff?.();
    this._recoveryRunOff = bus.subscribe('windows.service.recovery-run', (e) => {
      if (e.payload.deviceId !== this.id) return;
      this.runRecoveryCommand(e.payload.command);
    });

    this._serviceRegistrySyncOff?.();
    this._serviceRegistrySyncOff = bus.subscribe('windows.service.account-changed', (e) => {
      if (e.payload.deviceId !== this.id) return;
      this.syncServiceRegistryKey(e.payload.serviceName);
    });
    for (const svc of this.svcMgr.getAllServices()) this.syncServiceRegistryKey(svc.name);

    this._processSocketReaperOff?.();
    this._processSocketReaperOff = bus.subscribe('windows.process.stopped', (e) => {
      const payload = e.payload as { pid: number; name: string };
      const { pid, name } = payload;
      const stack = this.getTcpStack();
      const toUnbind: Array<{ protocol: 'tcp' | 'udp'; localAddress: string; localPort: number; state: string }> = [];
      for (const sock of this.socketTable.getAll()) {
        const matchesByPid = sock.pid === pid;
        const matchesByName = name && sock.processName === name;
        if (!matchesByPid && !matchesByName) continue;
        toUnbind.push({ protocol: sock.protocol, localAddress: sock.localAddress, localPort: sock.localPort, state: sock.state });
      }
      for (const s of toUnbind) {
        this.socketTable.unbind(s.protocol, s.localAddress, s.localPort);
        if (s.protocol === 'tcp' && s.state === 'LISTEN') {
          stack.closeListener(s.localPort, s.localAddress);
        }
      }
      stack.abortSocketsOwnedBy(pid);
    });
  }

  private _processSocketReaperOff: (() => void) | null = null;
  private _recoveryRunOff: (() => void) | null = null;
  private _serviceRegistrySyncOff: (() => void) | null = null;

  /** Keeps `HKLM:\SYSTEM\CurrentControlSet\Services\<name>` coherent with the live service. */
  private syncServiceRegistryKey(serviceName: string): void {
    const svc = this.svcMgr.getService(serviceName);
    if (!svc) return;
    this.registry.upsertServiceKey(svc.name, {
      objectName: svc.account,
      startCode: START_TYPE_CODES[svc.startType] ?? 3,
      imagePath: svc.binaryPath,
    });
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
        // TcpSocket structurally satisfies TcpStream (write/send/close/onData/
        // onClose all present) — the two abstractions just predate a shared
        // interface, so the handler's nested onData parameter variance needs
        // an explicit assertion here.
        this.getSshServerHandler().register(socket as unknown as TcpStream, socket.remoteIp);
      },
    });

    // TCP SMB server on port 445 (LanmanServer) — real `net use`/UNC traffic.
    // Refuses (drops) the connection when LanmanServer isn't Running, so the
    // client's negotiate gets no reply — same "network path not found" a
    // real client sees when the Server service is stopped.
    this.getTcpStack().listen(445, {
      onAccept: (socket) => {
        if (this.svcMgr.getService('LanmanServer')?.state !== 'Running') {
          socket.close();
          return;
        }
        const clientHost = this.reverseLookupClient(socket.remoteIp);
        this.getSmbServerHandler().register(socket as unknown as TcpStream, socket.remoteIp, clientHost);
      },
    });

    // TCP WinRM server on port 5985 — real Invoke-Command/Enter-PSSession/
    // Test-WSMan reachability (PRD-Windows-Server.md §5 P4). Refuses
    // (drops) the connection until `winrm quickconfig`/Enable-PSRemoting.
    this.getTcpStack().listen(5985, {
      onAccept: (socket) => {
        if (!this.winrm.enabled) {
          socket.close();
          return;
        }
        this.getWinRmServerHandler().register(socket as unknown as TcpStream);
      },
    });

    // TCP LDAP server on port 389 (RFC 4511) — real AD DS directory queries
    // (PRD-Windows-Server.md §5 P5). Refuses (drops) the connection until
    // `Install-ADDSForest` promotes this server to a domain controller.
    this.getTcpStack().listen(389, {
      onAccept: (socket) => {
        const store = this.getDirectoryStore();
        if (!store) { socket.close(); return; }
        const serviceSecret = store.getComputerSecret(this.getHostname());
        if (!this.ldapStartTlsIdentity) this.ldapStartTlsIdentity = selfSignedLdapCert(store.getRealm());
        const forest = getForestForDomain(store.dnsName);
        const otherDomainRoots = forest
          ? forest.listDomains()
            .filter(d => d.dnsName.toLowerCase() !== store.dnsName.toLowerCase())
            .map(d => d.dnsName.split('.').map(p => `DC=${p}`).join(','))
          : [];
        new LdapServerHandler({
          tree: store.getTree(), auth: store.getBindCheck(),
          kerberos: serviceSecret !== null ? { realm: store.getRealm(), serviceSecret } : undefined,
          startTls: { serverCert: this.ldapStartTlsIdentity.cert, serverPrivateKey: this.ldapStartTlsIdentity.keyPair.privateKey },
          otherForestDomainRoots: () => otherDomainRoots,
          retrieveManagedPassword: (sam, requestingPrincipalSam) => store.retrieveManagedPassword(sam, requestingPrincipalSam),
          checkMachineAccountQuota: (creatorSam) => store.checkMachineAccountQuota(creatorSam),
          onComputerRegistered: (computerName, ip) => {
            const dns = this.getDnsServerRole();
            dns?.applyDynamicARecord(store.dnsName, computerName, ip);
            dns?.applyDynamicPtrRecord(store.dnsName, computerName, ip);
          },
        }).register(socket);
      },
    });

    // TCP KDC listener on port 88 (RFC 4120 §7.2.1) — real AS-REQ/AS-REP
    // Kerberos exchange (PRD-Windows-Server-Advanced.md §5 P1). Refuses
    // (drops) the connection until this server is a domain controller,
    // mirroring the LDAP port-389 listener above.
    this.getTcpStack().listen(88, {
      onAccept: (socket) => {
        const store = this.getDirectoryStore();
        if (!store) { socket.close(); return; }
        new KdcSessionHandler({ store, deviceId: this.getHostname(), bus: this.getBus() }).register(socket);
      },
    });

    // TCP replication listener on port 135 (simplified real-shaped
    // MS-DRSR pull endpoint — PRD-Windows-Server-Advanced.md §5 P4).
    // Refuses (drops) the connection until this server is a domain
    // controller, mirroring the LDAP/KDC listeners above.
    this.getTcpStack().listen(AD_REPLICATION_PORT, {
      onAccept: (socket) => {
        const store = this.getDirectoryStore();
        if (!store) { socket.close(); return; }
        new ReplicationServerHandler(store, this.getHostname(), this.getBus()).register(socket);
      },
    });

    // TCP DFSR listener on port 5722 (DFSR's real default RPC endpoint —
    // PRD-Windows-Server-Advanced.md §5 P16). Refuses (drops) the
    // connection until the FS-DFS-Replication role is installed, mirroring
    // the LDAP/KDC/replication listeners above.
    this.getTcpStack().listen(DFSR_PORT, {
      onAccept: (socket) => {
        const role = this.getDfsrRole();
        if (!role) { socket.close(); return; }
        new DfsrServerHandler(role.getGroups()).register(socket);
      },
    });

    // TCP RDP listener on port 3389 (MS-RDPBCGR §2.2.1 — PRD-Windows-
    // Server-Advanced.md §5 P17). Refuses (drops) the connection until
    // `Enable-RemoteDesktop` has been run, mirroring the WinRM/5985
    // listener's own enabled-flag gating above.
    this.getTcpStack().listen(RDP_PORT, {
      onAccept: (socket) => {
        if (!this.rdp.enabled) { socket.close(); return; }
        new RdpServerHandler({
          tlsConfig: { serverCert: this.getRdpTlsCertificate()!, serverPrivateKey: this.rdpTlsIdentity!.privateKey },
          sessions: this.rdp.sessions,
          auth: {
            checkLocal: (u, p) => Boolean(this.userMgr.getUser(u)?.enabled) && this.userMgr.checkPassword(u, p),
            checkDomain: (u, p) => Boolean(this.tryDomainAuth(u, p)?.ok),
          },
        }).register(socket);
      },
    });

    // TCP WSUS listener on port 8530 (WSUS's real default site port —
    // PRD-Windows-Server-Advanced.md §5 P19). Refuses (drops) the
    // connection until the UpdateServices role is installed, mirroring
    // the DFSR/RDP listeners above.
    this.getTcpStack().listen(WSUS_PORT, {
      onAccept: (socket) => {
        const role = this.getWsusRole();
        if (!role) { socket.close(); return; }
        new WsusServerHandler(role).register(socket);
      },
    });

    // TCP LPD listener on port 515 (RFC 1179 — PRD-Windows-Server-
    // Advanced.md §5 P20). Refuses (drops) the connection until the
    // Print-Services role is installed, mirroring the DFSR/WSUS listeners
    // above.
    this.getTcpStack().listen(LPD_PORT, {
      onAccept: (socket) => {
        const role = this.getPrintServerRole();
        if (!role) { socket.close(); return; }
        new LpdServerHandler(role).register(socket);
      },
    });
  }

  /** This host's own RDP TLS identity certificate (PRD-Windows-Server-Advanced.md §5 P17) — lazily created once; a real client would present its own trust decision UI for this cert, which a `dialRdp()` caller stands in for via an explicit `CertificateVerifier`. */
  getRdpTlsCertificate(): X509Certificate {
    if (!this.rdpTlsIdentity) {
      this.rdpTlsIdentity = generateSelfSignedCertificate(`CN=${this.getHostname()}`, { now: this.simulatedDate().getTime() });
    }
    return this.rdpTlsIdentity.cert;
  }

  /**
   * Dial RDP on a remote device (PRD-Windows-Server-Advanced.md §5 P17):
   * TPKT/X.224 negotiation, a real TLS 1.3 handshake standing in for the
   * CredSSP/NLA security channel, then one credential PDU.
   */
  dialRdp(targetIp: string, username: string, password: string, verifier: CertificateVerifier): RdpDialResult {
    return dialRdp(this.getTcpStack(), targetIp, username, password, { verifier });
  }

  /**
   * One AD replication pull cycle against `partnerIp` (PRD-Windows-
   * Server-Advanced.md §5 P4) — dials the partner's TCP/135, exchanges
   * high-watermark vectors, and applies whatever the partner has that
   * this DC doesn't. Manually triggered (no KCC/scheduled replication
   * modeled, per PRD §2.2 scope).
   */
  replicateFrom(partnerIp: string): ReplicationPullResult {
    const store = this.getDirectoryStore();
    if (!store) return { ok: false, error: 'This computer is not a domain controller.', applied: 0 };
    const result = pullReplication(this.getTcpStack(), partnerIp, store);

    const ownIp = this.getInterfaces().map(p => p.getIPAddress()).find((ip): ip is NonNullable<typeof ip> => ip !== null)?.toString();
    const ownSite = ownIp ? store.siteForIp(ownIp) : null;
    const partnerSite = store.siteForIp(partnerIp);
    const siteRelation: 'intra-site' | 'inter-site' =
      ownSite !== null && partnerSite !== null && ownSite !== partnerSite ? 'inter-site' : 'intra-site';
    const logEntry: ReplicationLogEntry = {
      timestamp: Math.floor(Date.now() / 1000), partnerAddress: partnerIp, applied: result.applied, ok: result.ok, siteRelation,
    };
    this.replicationLog.push(logEntry);
    this.getBus().publish(
      result.ok
        ? {
            topic: 'replication.pull.completed',
            payload: {
              deviceId: this.getHostname(), invocationId: store.getInvocationId(), partnerAddress: partnerIp,
              applied: result.applied, siteRelation,
            },
          }
        : {
            topic: 'replication.pull.failed',
            payload: {
              deviceId: this.getHostname(), invocationId: store.getInvocationId(), partnerAddress: partnerIp,
              error: result.error ?? 'unknown error', siteRelation,
            },
          },
    );
    return result;
  }

  /** PRD-Windows-Server-Advanced.md §5 P6 — every past `replicateFrom` cycle, annotated intra-/inter-site. */
  getReplicationLog(): readonly ReplicationLogEntry[] { return this.replicationLog; }

  /** PRD-Windows-Server-Advanced.md §5 P12 — observable read-models for this DC's Kerberos KDC and AD replication activity. */
  getKerberosSignals(): KerberosSignalStore { return this.kerberosSignals; }
  getReplicationSignals(): ReplicationSignalStore { return this.replicationSignals; }

  /** PRD-Windows-Server-Advanced.md §5 P23 — observable read-models for AD CS/RDP/cluster/DFSR activity. */
  getAdcsSignals(): AdcsSignalStore { return this.adcsSignals; }
  getRdpSignals(): RdpSignalStore { return this.rdpSignals; }
  getClusterSignals(): ClusterSignalStore { return this.clusterSignals; }
  getDfsSignals(): DfsSignalStore { return this.dfsSignals; }

  /** Best-effort reverse DNS for the SMB session table's ClientComputerName column. */
  private reverseLookupClient(ip: string): string {
    return this.readHostsFile().reverse(ip)?.canonicalName ?? ip;
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

  /** Build a SmbServerHandler ready to be hooked onto a TcpConnection (one per accept, like SSH). */
  getSmbServerHandler(): SmbServerHandler {
    return new SmbServerHandler({
      fs: this.fs,
      userMgr: this.userMgr,
      shares: this.smbShares,
      sessions: this.smbSessions,
      now: () => this.simulatedDate().getTime(),
      hostname: this.hostname,
      domainAuth: (u, p) => this.tryDomainAuth(u, p),
    });
  }

  /**
   * Dial a remote SMB share over the real network (`net use`, UNC access
   * from cmd/PowerShell). Real TCP handshake through `tcpv2` — routing,
   * cables and a stopped `LanmanServer` on the far end all behave exactly
   * as they do for any other TCP client on this device.
   */
  dialSmbShare(targetIp: string, shareName: string, username: string, password: string): SmbDialResult {
    return dialSmbShare({ tcpStack: this.getTcpStack(), targetIp, shareName, username, password });
  }

  /** Build a WinRmServerHandler ready to be hooked onto a TcpConnection (one per accept). */
  getWinRmServerHandler(): WinRmServerHandler {
    return new WinRmServerHandler({ userMgr: this.userMgr, domainAuth: (u, p) => this.tryDomainAuth(u, p) });
  }

  // ─── Domain join / logon (PRD-Windows-Server.md §5 P6) ──────────────

  getDomainMembership(): DomainMembership | null { return this.domainMembership; }
  getDomainSession(): DomainSession | null { return this.domainSession; }

  /**
   * `Add-Computer -DomainName`/`netdom join` — real LDAP `AddRequest`
   * dialogue against the DC at `dcAddress` (no DNS SRV discovery yet,
   * P7 dependency — callers resolve the DC address themselves).
   */
  joinDomainNow(domainName: string, dcAddress: string, credentialUser: string, credentialPassword: string): DomainJoinResult {
    if (this.domainMembership) {
      return { ok: false, message: `The computer '${this.getHostname()}' is already joined to a domain.` };
    }
    const ownIp = this.getInterfaces().map(p => p.getIPAddress()).find((ip): ip is NonNullable<typeof ip> => ip !== null)?.toString();
    const result = joinDomain({
      tcpStack: this.getTcpStack(),
      computerName: this.getHostname(),
      domainName,
      dcAddress,
      credentialUser,
      credentialPassword,
      ownIp,
    });
    if (result.ok && result.membership) this.domainMembership = result.membership;
    return result;
  }

  /** Domain logon (`LAB\alice`/`alice@lab.local`) — validated against the DC over the real network, not a topology shortcut. */
  logonDomain(rawUser: string, password: string): { ok: boolean; message: string } {
    if (!this.domainMembership) {
      return { ok: false, message: 'The trust relationship between this workstation and the primary domain failed.' };
    }
    const parsed = parseDomainQualifiedUser(rawUser, this.domainMembership);
    if (!parsed) return { ok: false, message: 'The user name or password is incorrect.' };
    const result = logonDomainUser(this.getTcpStack(), this.domainMembership, parsed.sam, password);
    if (!result.ok) return { ok: false, message: result.message };
    this.setCurrentUser(parsed.sam);
    this.domainSession = result.session ?? null;
    this.acquireKerberosTgt(parsed.sam, password);
    return { ok: true, message: '' };
  }

  /**
   * Real Kerberos AS exchange (PRD-Windows-Server-Advanced.md §5 P1/P2), run
   * as a side effect of a successful domain logon — mirrors real Windows'
   * SSO behavior of silently acquiring a TGT at logon time. Best-effort:
   * the LDAP simple-bind above remains the actual logon decision until
   * DomainLogonClient itself migrates onto Kerberos (§5 P25), so a KDC
   * unreachable/erroring here doesn't fail the logon, it just leaves
   * `klist` showing no cached tickets.
   */
  private acquireKerberosTgt(sam: string, password: string): void {
    if (!this.domainMembership) return;
    this.kerberosTicketCache.clear();
    const conn = dialKdc(this.getTcpStack(), this.domainMembership.dcAddress);
    if (!conn.ok || !conn.client) return;
    const realm = this.domainMembership.dnsName.toUpperCase();
    const result = conn.client.asExchange(sam, password, realm);
    if (!result.ok || !result.ticket || !result.encKdcRepPart || !result.sessionKey) return;
    this.kerberosTicketCache.add({
      clientPrincipal: `${sam} @ ${realm}`,
      serverPrincipal: `krbtgt/${realm} @ ${realm}`,
      ticket: result.ticket, sessionKey: result.sessionKey, encKdcRepPart: result.encKdcRepPart,
    });
  }

  getKerberosTicketCache(): KerberosTicketCache { return this.kerberosTicketCache; }

  /** Domain-qualified credential check for inbound SMB/WinRM auth — real LDAP bind, not a topology shortcut. Returns null when unqualified/not domain-joined (caller should fall back to local auth). */
  tryDomainAuth(rawUser: string, password: string): { ok: boolean; sam: string; groups: string[] } | null {
    if (!this.domainMembership) return null;
    const parsed = parseDomainQualifiedUser(rawUser, this.domainMembership);
    if (!parsed) return null;
    const result = logonDomainUser(this.getTcpStack(), this.domainMembership, parsed.sam, password);
    if (!result.ok) return { ok: false, sam: parsed.sam, groups: [] };
    return { ok: true, sam: parsed.sam, groups: result.session?.groups ?? [] };
  }

  /**
   * Dial WinRM on a remote device over the real network (`Invoke-Command
   * -ComputerName`, `Enter-PSSession`, `Test-WSMan`). Real TCP handshake —
   * routing, cables, a stopped/unconfigured WinRM listener, and bad
   * credentials all behave exactly as they do for any other TCP client.
   */
  dialWinRm(targetIp: string, username: string, password: string): WinRmDialResult {
    return dialWinRm({ tcpStack: this.getTcpStack(), targetIp, username, password });
  }

  /**
   * `Invoke-WebRequest -Uri` (PRD-Windows-Server.md §5 P11): resolves the
   * host via the same real DNS chain `resolveDnsSync` uses (hosts file,
   * search domains, cache, real DNS query), then dials a real HTTP
   * request over `TcpStack` — reaches the IIS role (or any other real
   * HTTP-hosting device), not a stub.
   */
  invokeWebRequest(url: string): { ok: boolean; error?: string; statusCode?: number; statusDescription?: string; content?: string; headers?: Record<string, string> } {
    const parsed = parseHttpUrl(url);
    if (!parsed) return { ok: false, error: 'Invoke-WebRequest : Invalid URI: The format of the URI could not be determined.' };
    const ips = this.resolveDnsSync(parsed.host);
    const targetIp = ips[0] ?? (IPAddress.tryParse(parsed.host)?.toString());
    if (!targetIp) return { ok: false, error: `Invoke-WebRequest : The remote name could not be resolved: '${parsed.host}'` };
    const result = dialHttpClient({ tcpStack: this.getTcpStack(), targetIp, port: parsed.port, path: parsed.path });
    if (!result.ok || !result.response) {
      return { ok: false, error: `Invoke-WebRequest : Unable to connect to the remote server` };
    }
    const { response } = result;
    if (response.statusCode >= 400) {
      return {
        ok: false,
        error: `Invoke-WebRequest : The remote server returned an error: (${response.statusCode}) ${response.statusText}.`,
        statusCode: response.statusCode, statusDescription: response.statusText,
      };
    }
    return {
      ok: true, statusCode: response.statusCode, statusDescription: response.statusText,
      content: response.body, headers: response.headers,
    };
  }

  // ─── Group Policy (PRD-Windows-Server.md §5 P10) ────────────────────

  private gpoAppliedNames: string[] = [];
  private gpoLastAppliedAt: Date | null = null;
  private gpoLogonBanner: { title: string; text: string } | null = null;
  private gpoStartupScript: string | null = null;

  /**
   * `gpupdate /force` — pulls RSoP from the DC over the real network
   * (`GpoPullClient`, real LDAP) and applies it: the account-policy
   * settings replace this machine's local `WindowsAccountsPolicy`
   * (PRD §5 P10 — Default Domain Policy applies in place of the local
   * policy), and the logon banner/startup script are recorded for
   * `gpresult /r` to report. A domain controller applies its own
   * directory's RSoP directly (no need to dial itself over the wire).
   */
  gpupdateForce(): { ok: boolean; message: string } {
    if (!this.domainMembership) {
      return { ok: false, message: 'gpupdate : This computer is not joined to a domain.' };
    }
    let appliedGpoNames: string[];
    let settings: GpoSettings;
    const localStore = this.getDirectoryStore();
    if (localStore) {
      const rsop = localStore.resultantSetOfPolicy(this.getHostname());
      appliedGpoNames = rsop.appliedGpoNames;
      settings = rsop.settings;
    } else {
      const result = pullGroupPolicy(this.getTcpStack(), this.domainMembership, this.getHostname());
      if (!result.ok) return { ok: false, message: `gpupdate : ${result.message}` };
      appliedGpoNames = result.appliedGpoNames;
      settings = result.settings;
    }
    if (settings.accountPolicy) this.accountsPolicy.applyGpoOverrides(settings.accountPolicy);
    if (settings.logonBanner !== undefined) this.gpoLogonBanner = settings.logonBanner;
    if (settings.startupScript !== undefined) this.gpoStartupScript = settings.startupScript;
    this.gpoAppliedNames = appliedGpoNames;
    this.gpoLastAppliedAt = new Date();
    return { ok: true, message: '' };
  }

  /**
   * Instantané RSoP typé pour `gpresult /r` — `null` hors domaine. Le
   * formatage du texte est assuré par la commande `GpresultCommand` du
   * command-kernel ; cette primitive ne fournit que l'état.
   */
  groupPolicyResult(): WindowsGpResult | null {
    if (!this.domainMembership) return null;
    return {
      netbiosName: this.domainMembership.netbiosName,
      dcAddress: this.domainMembership.dcAddress,
      currentUser: this.userMgr.currentUser,
      hostname: this.getHostname(),
      lastAppliedAt: this.gpoLastAppliedAt,
      appliedGpoNames: [...this.gpoAppliedNames],
      logonBanner: this.gpoLogonBanner ? { title: this.gpoLogonBanner.title, text: this.gpoLogonBanner.text } : null,
      startupScript: this.gpoStartupScript ?? '',
    };
  }

  /**
   * `nltest /dsgetdc:<domaine>` — localise un contrôleur de domaine. Sonde
   * réseau réelle (TCP/389) contre l'adresse du DC ; le formatage du retour
   * console est porté par la commande. Hors domaine, retourne
   * `no-such-domain` — aucune fonctionnalité serveur exposée.
   */
  locateDomainController(domain: string): DomainControllerLocation {
    if (!this.domainMembership || this.domainMembership.dnsName.toLowerCase() !== domain.toLowerCase()) {
      return { ok: false, reason: 'no-such-domain' };
    }
    if (!this.probeTcpReachable(this.domainMembership.dcAddress, 389)) {
      return { ok: false, reason: 'unreachable' };
    }
    return {
      ok: true,
      dnsName: this.domainMembership.dnsName,
      dcAddress: this.domainMembership.dcAddress,
      siteName: 'Default-First-Site-Name',
    };
  }

  /**
   * `dcdiag` — instantané de santé de contrôleur de domaine. Un poste ou un
   * serveur non promu n'est jamais un DC (`isDc: false`) ; `WindowsServer`
   * surcharge cette méthode pour reporter l'état réel de ses services AD.
   * Garantit qu'aucun diagnostic serveur ne « passe » sur une machine non DC.
   */
  dcDiagnostics(): DomainControllerDiagnostics {
    return {
      isDc: false,
      hostname: this.getHostname(),
      dnsName: '',
      siteName: 'Default-First-Site-Name',
      servicesRunning: { ntds: false, netlogon: false, kdc: false },
      sysvolShareExists: false,
    };
  }

  /**
   * `klist` — instantané typé du cache de tickets Kerberos, alimenté par un
   * vrai échange AS/TGS lors du logon domaine. Le formatage texte est porté
   * par la commande. Vide tant qu'aucun logon domaine n'a eu lieu.
   */
  kerberosTickets(): readonly KerberosCachedTicket[] {
    const flagNames: ReadonlyArray<[keyof TicketFlags, string]> = [
      ['forwardable', 'forwardable'], ['forwarded', 'forwarded'],
      ['proxiable', 'proxiable'], ['proxy', 'proxy'],
      ['renewable', 'renewable'], ['initial', 'initial'],
      ['preAuthent', 'pre_authent'], ['hwAuthent', 'hw_authent'],
    ];
    return this.kerberosTicketCache.list().map((t) => {
      const e = t.encKdcRepPart;
      return {
        clientPrincipal: t.clientPrincipal,
        serverPrincipal: t.serverPrincipal,
        flagsHex: ticketFlagsToHex(e.flags),
        flagNames: flagNames.filter(([key]) => e.flags[key]).map(([, name]) => name),
        startTime: e.starttime ?? e.authtime,
        endTime: e.endtime,
        renewTill: e.renewTill ?? null,
      };
    });
  }

  /**
   * `netdom trust` — établit une relation d'approbation inter-domaines. Une
   * approbation ne peut être créée que depuis un contrôleur de domaine : sur
   * un poste (ou un serveur non promu) la primitive retourne `null` et la
   * commande signale « not a domain controller ». `WindowsServer` surcharge
   * cette méthode via `newADTrust`. Garantit qu'aucune approbation ne peut
   * être créée depuis un simple poste.
   */
  establishDomainTrust(
    _remoteRealm: string, _dcAddress: string, _direction: DomainTrustDirection,
    _transitive: boolean, _user: string, _password: string,
  ): { ok: boolean; message: string } | null {
    return null;
  }

  /** `gpresult /r` — RSoP summary text, matching the real tool's section layout. */
  cmdGpresult(): string {
    if (!this.domainMembership) {
      return 'gpresult : The processing of Group Policy failed. This computer is not a member of a domain.';
    }
    const lines: string[] = [
      'Microsoft (R) Windows (R) Operating System Group Policy Result tool v2.0',
      'Copyright (C) Microsoft Corp. 1981-2001',
      '',
      `RSOP data for ${this.domainMembership.netbiosName}\\${this.userMgr.currentUser} on ${this.getHostname()} : Logging Mode`,
      '-------------------------------------------------------------',
      '',
      'COMPUTER SETTINGS',
      '------------------',
      `    Last time Group Policy was applied: ${this.gpoLastAppliedAt ? this.gpoLastAppliedAt.toString() : 'N/A'}`,
      `    Group Policy was applied from:      ${this.domainMembership.dcAddress}`,
      `    Domain Name:                        ${this.domainMembership.netbiosName}`,
      `    Domain Type:                        Windows Active Directory`,
      '',
      '    Applied Group Policy Objects',
      '    -----------------------------',
    ];
    if (this.gpoAppliedNames.length === 0) lines.push('        N/A');
    else for (const name of this.gpoAppliedNames) lines.push(`        ${name}`);
    if (this.gpoLogonBanner) {
      lines.push('', '    Legal Notice', '    ------------', `        Caption: ${this.gpoLogonBanner.title}`, `        Text:    ${this.gpoLogonBanner.text}`);
    }
    if (this.gpoStartupScript) {
      lines.push('', '    Startup Scripts', '    ---------------', `        ${this.gpoStartupScript}`);
    }
    lines.push('', 'USER SETTINGS', '------------------', '    N/A');
    return lines.join('\n');
  }

  /** `net session` — inbound SMB sessions from other computers connected to shares on THIS device. */
  private cmdNetSession(args: string[]): string {
    if (args.some(a => a.toLowerCase() === '/delete')) {
      const target = args.find(a => a.startsWith('\\\\'));
      const before = this.smbSessions.list();
      for (const s of before) {
        if (!target || s.clientIp === target.slice(2) || s.clientComputerName === target.slice(2)) {
          this.smbSessions.close(s.id);
        }
      }
      return 'The command completed successfully.';
    }
    const sessions = this.smbSessions.list();
    const header =
      'Computer             User name            Client Type       Opens Idle time\n' +
      '-------------------------------------------------------------------------\n';
    if (sessions.length === 0) return header + 'There are no entries in the list.';
    const rows = sessions.map(s =>
      `\\\\${s.clientComputerName}`.padEnd(22) + s.user.padEnd(21) + ''.padEnd(18) + String(s.numOpens).padStart(5) + '  00:00:00',
    );
    return header + rows.join('\n') + '\nThe command completed successfully.';
  }

  /** Parsed target for a UNC path or a `net use`-mapped drive letter. */
  private resolveSmbPath(raw: string):
    | { unc: true; server: string; share: string; subPath: string }
    | { unc: false; mapped: NetUseEntry; subPath: string }
    | null {
    const uncMatch = /^\\\\([^\\]+)\\([^\\]+)\\?(.*)$/.exec(raw);
    if (uncMatch) return { unc: true, server: uncMatch[1], share: uncMatch[2], subPath: uncMatch[3] ?? '' };
    const driveMatch = /^([A-Za-z]):\\?(.*)$/.exec(raw);
    if (driveMatch) {
      const mapped = this.netUseTable.get(`${driveMatch[1].toUpperCase()}:`);
      if (mapped) return { unc: false, mapped, subPath: driveMatch[2] ?? '' };
    }
    return null;
  }

  /**
   * Obtain an `SmbConnection` for a resolved target: the persistent
   * session already open on a mapped drive, or a fresh ad-hoc dial (as
   * the current user, no password) for a bare UNC path with no mapping —
   * matching how real Windows opens an implicit admin session for a
   * one-off `dir \\srv\share`.
   */
  private async smbConnectionFor(
    target: NonNullable<ReturnType<WindowsPC['resolveSmbPath']>>,
  ): Promise<{ connection: import('./windows/server/smb/SmbClient').SmbConnection; adHoc: boolean } | { error: string }> {
    if (target.unc === false) {
      if (!target.mapped.connection) return { error: 'The specified network name is no longer available.' };
      return { connection: target.mapped.connection, adHoc: false };
    }
    const targetIp = await this.resolveHostname(target.server);
    if (!targetIp) return { error: 'System error 53 has occurred.\n\nThe network path was not found.' };
    const dial = this.dialSmbShare(targetIp.toString(), target.share, this.userMgr.currentUser, '');
    if (!dial.ok || !dial.connection) {
      return { error: dial.error ?? 'System error 53 has occurred.\n\nThe network path was not found.' };
    }
    return { connection: dial.connection, adHoc: true };
  }

  /**
   * Handle `dir`/`copy`/`type` when a UNC path or a mapped drive letter is
   * involved (PRD-Windows-Server.md §5 P3). Returns null when neither
   * source nor destination is remote, so the caller falls back to the
   * normal local-VFS command.
   */
  private async tryUncFileCommand(cmd: string, args: string[]): Promise<string | null> {
    if (cmd === 'type') {
      if (args.length === 0) return null;
      const target = this.resolveSmbPath(args.join(' '));
      if (!target) return null;
      const conn = await this.smbConnectionFor(target);
      if ('error' in conn) return conn.error;
      const result = conn.connection.read(target.subPath);
      if (conn.adHoc) conn.connection.disconnect();
      return result.ok ? (result.content ?? '') : (result.error ?? 'The system cannot find the file specified.');
    }

    if (cmd === 'dir') {
      const positional = args.find(a => !a.startsWith('/'));
      if (!positional) return null;
      const target = this.resolveSmbPath(positional);
      if (!target) return null;
      const conn = await this.smbConnectionFor(target);
      if ('error' in conn) return conn.error;
      const result = conn.connection.list(target.subPath);
      if (conn.adHoc) conn.connection.disconnect();
      if (!result.ok) return result.error ?? 'The network name cannot be found.';
      const lines = [` Directory of ${positional}`, ''];
      let fileCount = 0, dirCount = 0, totalBytes = 0;
      for (const e of result.entries ?? []) {
        if (e.isDirectory) { lines.push(`    <DIR>          ${e.name}`); dirCount++; }
        else { lines.push(`${String(e.size).padStart(14)} ${e.name}`); fileCount++; totalBytes += e.size; }
      }
      lines.push(`               ${fileCount} File(s) ${totalBytes.toLocaleString('en-US')} bytes`);
      lines.push(`               ${dirCount} Dir(s)`);
      return lines.join('\n');
    }

    if (cmd === 'copy') {
      if (args.length < 2) return null;
      const srcTarget = this.resolveSmbPath(args[0]);
      const dstTarget = this.resolveSmbPath(args[1]);
      if (!srcTarget && !dstTarget) return null;

      const baseNameOf = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
      const srcBaseName = baseNameOf(srcTarget ? srcTarget.subPath : args[0]);

      let content: string;
      if (srcTarget) {
        const conn = await this.smbConnectionFor(srcTarget);
        if ('error' in conn) return conn.error;
        const result = conn.connection.read(srcTarget.subPath);
        if (conn.adHoc) conn.connection.disconnect();
        if (!result.ok) return result.error ?? 'The system cannot find the file specified.';
        content = result.content ?? '';
      } else {
        const srcAbs = this.fs.normalizePath(args[0], this.cwd);
        const local = this.fs.readFile(srcAbs);
        if (!local.ok) return local.error!;
        content = local.content ?? '';
      }

      if (dstTarget) {
        // Destination is a share/subdirectory rather than a file name — keep the source's basename.
        const dstSubPath = dstTarget.subPath === '' || dstTarget.subPath.endsWith('\\')
          ? `${dstTarget.subPath}${srcBaseName}` : dstTarget.subPath;
        const conn = await this.smbConnectionFor(dstTarget);
        if ('error' in conn) return conn.error;
        const result = conn.connection.write(dstSubPath, content);
        if (conn.adHoc) conn.connection.disconnect();
        if (!result.ok) return result.error ?? 'Access is denied.';
      } else {
        let dstAbs = this.fs.normalizePath(args[1], this.cwd);
        if (this.fs.isDirectory(dstAbs)) dstAbs = `${dstAbs.replace(/\\$/, '')}\\${srcBaseName}`;
        const result = this.fs.createFile(dstAbs, content);
        if (!result.ok) return result.error!;
      }
      return '        1 file(s) copied.';
    }

    return null;
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

  /**
   * Pre-auth banner shown to an interactive SSH client, before the MOTD.
   * Mirrors Router.sshBanner() — delegates to the LegalNoticeText-backed
   * getSshBanner() so the version banner (getSshMotd()) isn't echoed twice.
   */
  sshBanner(): string {
    return this.getSshBanner();
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

  /** Look up a local account without reaching into the private user manager — used by `runas`'s interactive validation (WindowsTerminalSession.tryStartRunasInteractive). */
  getUser(username: string): { name: string; enabled: boolean } | undefined {
    return this.userMgr.getUser(username);
  }

  /**
   * Set / change a user's password through the SAM database. Mirrors
   * LinuxMachine.setUserPassword so the two platforms expose a parallel
   * surface to callers that don't care which OS they're talking to.
   */
  setUserPassword(username: string, password: string): void {
    this.userMgr.setUserProperty(username, 'password', password);
  }

  /** The local SAM (users/groups) — used by the NPS role (PRD-Windows-Server.md §5 P9) to resolve RADIUS auth against the local account database. */
  getUserManager(): WindowsUserManager { return this.userMgr; }

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
  getSshMotd(): string {
    return 'Microsoft Windows [Version 10.0.22631.6649]\n' +
      '(c) Microsoft Corporation. All rights reserved.';
  }

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
  async runSshCommandSync(user: string, command: string): Promise<{ output: string; exitCode: number } | null> {
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
      return { output: `\n${this.getSshMotd().split('\n')[0]}\n\n`, exitCode: 0 };
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

  private cmdSsh(args: string[]): Promise<string> {
    const user = this.userMgr.currentUser;
    const sourceIp = this.firstConfiguredIp() ?? '127.0.0.1';
    return runWindowsSshClient({
      args,
      sourceHostname: this.hostname,
      sourceIp,
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
    }).then(r => {
      const peerIp = this.resolveSshPeer(args);
      if (peerIp && !/Permission denied|refused|timed out|Could not resolve|No route/i.test(r.output)) {
        const entry = this.socketTable.connect('tcp', sourceIp, 0, peerIp, 22, undefined, 'ssh.exe');
        this.socketTable.transition(entry.id, 'TIME_WAIT');
      }
      return r.output;
    });
  }

  private resolveSshPeer(args: string[]): string | null {
    for (const a of args) {
      if (a.startsWith('-')) continue;
      const at = a.includes('@') ? a.split('@')[1] : a;
      if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(at)) return at;
    }
    return null;
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
      tcpConnector: (h, p) => this.tcpConnect(h, p) as ReturnType<import('../tcp/types').TcpConnector>,
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

    // 4. Resolver cache, then DNS over the wire via every effective server.
    for (const qname of this.dnsSearchCandidates(name)) {
      const cached = this.dnsCache.lookup(qname, 'A');
      if (cached) {
        try { return new IPAddress(cached); } catch { void 0; }
      }
    }
    for (const { server, qname } of this.dnsResolutionAttempts(name)) {
      const response = await this.queryDnsServer(server, qname, 'A');
      const aRecords = response?.answers.filter((rr) => rr.data.type === RRType.A) ?? [];
      if (aRecords.length > 0) {
        this.dnsCache.store(qname, response!.answers);
        return (aRecords[0].data as ARecordData).address;
      }
    }
    return null;
  }

  resolveDnsSync(name: string): string[] {
    const hostsIp = this.readHostsFile().resolve(name, 4);
    if (hostsIp) return [hostsIp];
    for (const qname of this.dnsSearchCandidates(name)) {
      const cached = this.dnsCache.lookup(qname, 'A');
      if (cached) return [cached];
    }
    for (const { server, qname } of this.dnsResolutionAttempts(name)) {
      const response = this.queryDnsServerSync(server, qname, 'A');
      const aRecords = response?.answers.filter((rr) => rr.data.type === RRType.A) ?? [];
      if (aRecords.length > 0) {
        this.dnsCache.store(qname, response!.answers);
        return aRecords.map((rr) => (rr.data as ARecordData).address.toString());
      }
    }
    return [];
  }

  resolveDnsViaServerSync(name: string, server: string): string[] {
    return this.resolveDnsViaServerWithTtlSync(name, server).map(r => r.ip);
  }

  resolveDnsViaServerWithTtlSync(name: string, server: string): Array<{ ip: string; ttl: number }> {
    let serverIP: IPAddress;
    try { serverIP = new IPAddress(server); } catch { return []; }
    for (const qname of this.dnsSearchCandidates(name)) {
      const response = this.queryDnsServerSync(serverIP, qname, 'A');
      const aRecords = response?.answers.filter((rr) => rr.data.type === RRType.A) ?? [];
      if (aRecords.length > 0) {
        return aRecords.map((rr) => ({ ip: (rr.data as ARecordData).address.toString(), ttl: rr.ttl }));
      }
    }
    return [];
  }

  private dhcpLease(ifName: string) {
    return this.dhcpClient.getState(ifName)?.lease ?? null;
  }

  private effectiveDnsServers(ifName: string): string[] {
    const cfg = this.dnsConfig.get(ifName);
    if (cfg?.mode === 'static') return [...cfg.servers];
    return this.dhcpLease(ifName)?.dnsServers ?? [];
  }

  getConnectionDnsSuffix(ifName: string): string {
    const cfg = this.dnsConfig.get(ifName);
    const leaseSuffix = cfg?.mode === 'static' ? '' : (this.dhcpLease(ifName)?.domainName ?? '');
    return leaseSuffix || this.dnsSuffix;
  }

  private dnsSearchCandidates(name: string): string[] {
    if (name.includes('.')) return [name];
    const suffixes = new Set<string>();
    if (this.dnsSuffix) suffixes.add(this.dnsSuffix);
    for (const [ifName] of this.ports) {
      const suffix = this.getConnectionDnsSuffix(ifName);
      if (suffix) suffixes.add(suffix);
    }
    return [name, ...[...suffixes].map((s) => `${name}.${s}`)];
  }

  private dnsResolutionAttempts(name: string): Array<{ server: IPAddress; qname: string }> {
    const attempts: Array<{ server: IPAddress; qname: string }> = [];
    for (const qname of this.dnsSearchCandidates(name)) {
      const seen = new Set<string>();
      for (const [ifName] of this.ports) {
        for (const server of this.effectiveDnsServers(ifName)) {
          if (seen.has(server)) continue;
          seen.add(server);
          try { attempts.push({ server: new IPAddress(server), qname }); } catch { void 0; }
        }
      }
    }
    return attempts;
  }

  // ─── Terminal ──────────────────────────────────────────────────

  async executeCommand(command: string): Promise<string> {
    return this.executeCmdCommand(command);
  }

  /**
   * Execute a command in CMD mode.
   * Also used by PowerShellExecutor (via PSDeviceContext) to delegate
   * native commands (ipconfig, ping, cd, etc.) directly to cmd.
   *
   * Single point of entry (migration_framework.md): after the two
   * pre-lexing steps below (neither of which the AST can express — a
   * stream redirect the simulation doesn't model, and a raw-text macro
   * substitution that happens before any tokenizing on real cmd.exe too),
   * everything else — chaining (`&&`/`||`/`&`), piping (`|`), redirects
   * (`>`/`>>`) — is handled by `CmdInterpreter` (`CmdLexer → Parser →
   * Executor`) in `runCommandKernel`, a single call, one path.
   */
  async executeCmdCommand(trimmed: string): Promise<string> {
    if (!this.isPoweredOn) return 'Device is powered off';

    trimmed = trimmed.trim();
    if (!trimmed) return '';

    // Strip stderr redirects like "2>&1", "2> nul" — the simulation has a
    // single unified output stream, nothing to redirect stderr away from.
    trimmed = trimmed.replace(/\s+2>&1\s*$/i, '').replace(/\s+2>\s*(?:nul|&1)\s*$/i, '').trim();

    // doskey macro expansion (`ll` -> `dir /a`) — a raw-text substitution
    // pass over the whole line, same as real cmd.exe's console layer,
    // before any tokenizing.
    const doskeyExpanded = this.doskey.expand(trimmed);
    if (doskeyExpanded !== trimmed) return this.executeCmdCommand(doskeyExpanded);

    return this.runCommandKernel(trimmed);
  }

  // ─── Tab Completion ──────────────────────────────────────────────

  private static readonly CMD_FLAGS: Readonly<Record<string, readonly string[]>> = {
    ping: ['-4', '-6', '-a', '-l', '-n', '-t', '-w'],
    ipconfig: ['/all', '/displaydns', '/flushdns', '/registerdns', '/release', '/renew'],
    netstat: ['-a', '-b', '-e', '-n', '-o', '-p', '-r', '-s'],
    tracert: ['-4', '-6', '-d', '-h', '-w'],
    arp: ['-a', '-d', '-g', '-s'],
    route: ['-4', '-6', '-p'],
    getmac: ['/fo', '/nh', '/s', '/v'],
    dir: ['/a', '/b', '/o', '/p', '/q', '/s', '/w'],
    del: ['/a', '/f', '/p', '/q', '/s'],
    erase: ['/a', '/f', '/p', '/q', '/s'],
    copy: ['/v', '/y', '/z'],
    rmdir: ['/q', '/s'],
    rd: ['/q', '/s'],
    tasklist: ['/fi', '/fo', '/m', '/svc', '/v'],
    systeminfo: ['/fo', '/s', '/u'],
    tree: ['/a', '/f'],
    wevtutil: [],
  };

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

    // Flag completion: `/`- or `-`-prefixed argument of a known command
    if (lastArg.startsWith('/') || lastArg.startsWith('-')) {
      const flags = WindowsPC.CMD_FLAGS[(parts[0] || '').toLowerCase()];
      if (flags) {
        return flags.filter(f => f.toLowerCase().startsWith(lastArg.toLowerCase()));
      }
    }
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

  /**
   * Change `this.cwd`, keeping the active shell session's per-drive cwd map
   * in sync — when the new cwd belongs to a different drive than the old
   * one, remember the previous drive's cwd so a later bare `C:` returns to
   * the right location (terminal_gap.md §6.3). Shared by every path that
   * mutates cwd (cmd's `cd`, drive switching) so the bookkeeping lives in
   * exactly one place.
   */
  private setCwdTracked(path: string): void {
    const oldDrive = this.cwd.match(/^([A-Za-z]):/)?.[1]?.toUpperCase();
    const newDrive = path.match(/^([A-Za-z]):/)?.[1]?.toUpperCase();
    const s = this._activeShellSession;
    if (s && oldDrive && newDrive && oldDrive !== newDrive) {
      s.driveCwd.set(oldDrive, this.cwd);
    }
    if (s && newDrive) s.driveCwd.set(newDrive, path);
    this.cwd = path;
  }

  private getCommandKernelShell(): { registry: CommandRegistry; interpreter: CmdInterpreter } {
    if (!this.commandKernelShell) {
      this.commandKernelShell = createWindowsHostShell({
        fs: this.fs,
        userManager: this.userMgr,
        processManager: this.procMgr,
        hostname: this.hostname,
        ports: this.getPorts(),
        identity: this.getIdentity(),
        hardware: this.hardware,
        socketTable: this.getSocketTable(),
        serviceManager: this.svcMgr,
        getDomainSession: () => this.domainSession,
        doskey: this.doskey,
        getDirectoryStore: () => this.getDirectoryStore(),
        smbShares: this.smbShares,
        smbSessions: this.smbSessions,
        netUseTable: this.netUseTable,
        accountsPolicy: this.accountsPolicy,
        resolveHostname: (name) => this.resolveHostname(name),
        dialSmbShare: (targetIp, shareName, username, password) => this.dialSmbShare(targetIp, shareName, username, password),
        scheduledTasks: this.scheduledTasks,
        registry: this.registry,
        auditPolicy: this.auditPolicy,
        winrm: this.winrm,
        arpTable: this.arpTable,
        getRoutingTable: () => this.getRoutingTable(),
        addStaticRoute: (network, mask, nextHop, metric) => this.addStaticRoute(network, mask, nextHop, metric),
        removeRoute: (dest, mask) => this.removeRoute(dest, mask),
        setDefaultGateway: (gw) => this.setDefaultGateway(gw),
        clearDefaultGateway: () => this.clearDefaultGateway(),
        addStaticARP: (ip, mac, iface) => this.addStaticARP(ip, mac, iface),
        deleteARP: (ip) => this.deleteARP(ip),
        clearARPTable: () => this.clearARPTable(),
        executePingSequence: (target, count, timeoutMs, ttl) => this.executePingSequence(target, count, timeoutMs, ttl),
        executeTraceroute: (target, maxHops, timeoutMs) =>
          this.executeTraceroute(target, maxHops, timeoutMs ?? 500) as Promise<TracerouteHop[]>,
        reverseLookup: (ip) => {
          const entry = this.readHostsFile().reverse(ip);
          return entry ? entry.canonicalName : null;
        },
        resolveViaHostsFile: (name) => this.readHostsFile().resolve(name, 4),
        firstConfiguredDnsServer: () => this.firstConfiguredDnsServer(),
        queryDnsServer: (server, name, qtype, timeoutMs) => this.queryDnsServer(server, name, qtype, timeoutMs),
        isDHCPConfigured: (ifName) => this.isDHCPConfigured(ifName),
        getConnectionDnsSuffix: (ifName) => this.getConnectionDnsSuffix(ifName),
        getDefaultGateway6: () => this.getDefaultGateway6(),
        effectiveDnsServers: (ifName) => this.effectiveDnsServers(ifName),
        getDnsSuffix: () => this.dnsSuffix,
        getClassId: (ifName) => this.getClassId(ifName),
        setClassId: (ifName, classId) => this.setClassId(ifName, classId),
        getClassId6: (ifName) => this.getClassId6(ifName),
        setClassId6: (ifName, classId) => this.setClassId6(ifName, classId),
        sendRouterSolicitation: (ifName) => this.sendRouterSolicitation(ifName),
        autoDiscoverDHCPServers: () => this.autoDiscoverDHCPServers(),
        getDhcpLease: (ifName) => this.getDhcpLease(ifName),
        releaseDhcpLease: (ifName) => this.releaseDhcpLease(ifName),
        requestDhcpLease: (ifName) => this.requestDhcpLease(ifName),
        releaseDynamicIPv6: (ifName) => this.releaseDynamicIPv6(ifName),
        dnsCache: this.dnsCache,
        netInterfaces: () => [...this.ports.entries()].map(([name, port]) => ({ name, port })),
        resolveAdapterName: (name) => resolveAdapterNameUtil(name, this.ports),
        configureInterface: (ifName, ip, mask) => this.configureInterface(ifName, ip, mask),
        setAddressDhcp: (ifName) => {
          this.unconfigureInterface(ifName);
          this.dhcpInterfaces.add(ifName);
        },
        clearInterfaceIP: (ifName) => this.unconfigureInterface(ifName),
        setDnsServers: (ifName, servers) => {
          this.dnsConfig.set(ifName, { servers: [...servers], mode: 'static' });
        },
        getDnsMode: (ifName) => this.dnsConfig.get(ifName)?.mode ?? 'dhcp',
        setDnsMode: (ifName, mode) => {
          if (mode === 'dhcp') {
            this.dnsConfig.set(ifName, { servers: [], mode: 'dhcp' });
          } else {
            const cfg = this.dnsConfig.get(ifName);
            if (cfg) cfg.mode = 'static';
            else this.dnsConfig.set(ifName, { servers: [], mode: 'static' });
          }
        },
        getInterfaceAdmin: (ifName) => {
          const port = this.ports.get(ifName);
          return port ? !port.isAdminDown() : false;
        },
        setInterfaceAdmin: (ifName, enabled) => {
          const port = this.ports.get(ifName);
          if (port) port.setAdminDown(!enabled);
        },
        renameInterface: (oldName, newName) => this.renameInterface(oldName, newName),
        resetTcpIpStack: () => this.resetTcpIpStack(),
        resetWinsockCatalog: () => this.resetWinsockCatalog(),
        addIPv6Route: (entry) => { this.ipv6Routes.push(entry); },
        getIPv6Routes: () => this.ipv6Routes,
        portProxy: this.portProxyTable,
        getWinhttpProxy: () => this.winhttpProxyValue,
        setWinhttpProxy: (proxy) => { this.winhttpProxyValue = proxy; },
        setPrimaryDnsSuffix: (suffix) => { this.dnsSuffix = suffix; },
        isServiceRunning: (name) => this.svcMgr.getService(name)?.state === 'Running',
        dhcpClientNetsh: this.dhcpClientNetshState,
        ipsecNetsh: this.ipsecNetshState,
        netshFeatures: this.netshFeatureState,
        dynamicFirewallRules: this.dynamicFirewallRules,
        getDhcpServerRole: () => this.getDhcpServerRole(),
        getNpsRole: () => this.getNpsRole(),
        getDnsServerRole: () => this.getDnsServerRole(),
        eventLogEntries: (logName) => this.eventLog.getEntriesStructured(logName, {}),
        dhcpEventLog: () => this.dhcpEventLog,
        syncDhcpEvents: () => this.syncDHCPEvents(),
        addDhcpEvent: (type, message) => this.addDHCPEvent(type, message),
        gpupdateForce: () => this.gpupdateForce(),
        groupPolicyResult: () => this.groupPolicyResult(),
        locateDomainController: (domain) => this.locateDomainController(domain),
        dcDiagnostics: () => this.dcDiagnostics(),
        kerberosTickets: () => this.kerberosTickets(),
        joinDomain: (domain, dcAddress, user, password) => this.joinDomainNow(domain, dcAddress, user, password),
        resolveDcAddress: (domain) => this.resolveHostnameSync(domain)?.toString() ?? null,
        establishTrust: (remoteRealm, dcAddress, direction, transitive, user, password) =>
          this.establishDomainTrust(remoteRealm, dcAddress, direction, transitive, user, password),
        bootedAt: () => this.getLifecycle().bootedAt() ?? null,
        now: () => this.simulatedDate(),
        powerOn: () => this.powerOn(),
        powerOff: () => this.powerOff(),
      });
    }
    return this.commandKernelShell;
  }

  /**
   * The single point of entry into the machine for cmd (migration_framework.md
   * §0/§6): `CmdLexer → Parser → Executor`, via `CmdInterpreter`. Parses
   * once, handles the two line-level special cases that aren't commands in
   * the grammar sense (bare drive-letter switch, UNC/mapped-drive access),
   * then runs the (possibly compound — chain/pipeline/redirect) AST as a
   * single `Executor.run()` call. No fallback: once routed, a
   * `CommandNotFoundError`/`ShellError` from inside is the real answer,
   * formatted exactly like cmd.exe, not a signal to retry elsewhere.
   */
  private async runCommandKernel(trimmed: string): Promise<string> {
    const { interpreter } = this.getCommandKernelShell();

    let ast: ScriptNode;
    try {
      ast = interpreter.parse(trimmed);
    } catch (err) {
      if (err instanceof ShellError) return `${err.message}\n`;
      throw err;
    }

    // Bare drive letter (`D:` / `D:\path`) — change current drive and
    // restore the per-drive last cwd. Real cmd.exe: typing `D:` at the
    // prompt does not run a command, it switches drives (terminal_gap.md §6.3).
    if (ast.kind === 'command' && ast.argv.length === 0) {
      const driveOnly = /^([a-zA-Z]):$/.exec(ast.name);
      const drivePath = /^([a-zA-Z]):[\\/](.*)$/.exec(ast.name);
      if (driveOnly || drivePath) {
        const letter = (driveOnly ? driveOnly[1] : drivePath![1]).toUpperCase();
        return this.switchActiveDrive(letter, drivePath ? ast.name : null);
      }
    }

    const resolved = lowercaseCommandNames(ast);

    // UNC (`\\srv\share\...`) / net-use-mapped-drive access for dir/copy/type
    // (PRD-Windows-Server.md §5 P3) — real SMB traffic, a distinct backend
    // concern from command dispatch, not expressible as a registered command.
    if (resolved.kind === 'command' && (resolved.name === 'dir' || resolved.name === 'copy' || resolved.name === 'type')) {
      const uncResult = await this.tryUncFileCommand(resolved.name, resolved.argv.map((w) => w.text));
      if (uncResult !== null) return uncResult;
    }

    const user = resolveWindowsUser(this.userMgr, this.userMgr.currentUser);
    const session = createSession({ id: 'legacy-bridge', user, cwd: this.cwd, env: new Map(this.env) });
    const chunks: string[] = [];
    const collector = { write: async (t: string) => { chunks.push(t); }, close: async () => {} };
    const io = { stdin: new PipeBuffer(), stdout: collector, stderr: collector };

    try {
      await interpreter.runAst(resolved, session, io);
    } catch (err) {
      this.setCwdTracked(session.cwd);
      this.env = session.env;
      if (err instanceof CommandNotFoundError) {
        return `'${err.commandName}' is not recognized as an internal or external command,\noperable program or batch file.`;
      }
      if (err instanceof ShellError) return `${err.message}\n`;
      throw err;
    }
    this.setCwdTracked(session.cwd);
    this.env = session.env;
    return chunks.join('').replace(/\n$/, '');
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
      defaultGateway6: this.getDefaultGateway6()?.toString() || null,
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

      resetStack: () => this.resetStackState(),

      // DNS management
      getDnsServers: (ifName: string) => this.effectiveDnsServers(ifName),
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
        if (port) port.setAdminDown(!enabled);
      },
      getInterfaceAdmin: (ifName: string) => {
        const port = this.ports.get(ifName);
        return port ? !port.isAdminDown() : false;
      },

      // IP address removal
      clearInterfaceIP: (ifName: string) => {
        // Clears the address AND its connected route, so `route print`
        // stops advertising the network after the IP is gone.
        this.unconfigureInterface(ifName);
      },

      // Switch interface to DHCP address mode
      setAddressDhcp: (ifName: string) => {
        // Drop the static address AND its connected route before handing
        // the interface to DHCP, so a stale static network route doesn't
        // linger until the lease reconfigures it.
        this.unconfigureInterface(ifName);
        this.dhcpInterfaces.add(ifName);
      },

      // DHCP tracing
      getDhcpTraceEnabled: () => this.dhcpTraceEnabled,
      setDhcpTraceEnabled: (enabled: boolean) => { this.dhcpTraceEnabled = enabled; },

      // DNS suffix
      getDnsSuffix: () => this.dnsSuffix,
      setDnsSuffix: (suffix: string) => { this.dnsSuffix = suffix; },
      getConnectionDnsSuffix: (ifName: string) => this.getConnectionDnsSuffix(ifName),

      // ARP table mutation
      addStaticARP: (ip: IPAddress, mac: any, iface: string) => this.addStaticARP(ip, mac, iface),
      deleteARP: (ip: IPAddress) => this.deleteARP(ip),
      clearARPTable: () => this.clearARPTable(),

      // Interface renaming
      renameInterface: (oldName: string, newName: string): boolean => this.renameInterface(oldName, newName),

      getClassId: (ifName: string) => this.getClassId(ifName),
      setClassId: (ifName: string, classId: string | null) => this.setClassId(ifName, classId),
      getClassId6: (ifName: string) => this.getClassId6(ifName),
      setClassId6: (ifName: string, classId: string | null) => this.setClassId6(ifName, classId),
      sendRouterSolicitation: (ifName: string) => this.sendRouterSolicitation(ifName),

      // Hostname resolution
      resolveHostname: (name: string) => this.resolveHostname(name),

      // Service state query
      isServiceRunning: (name: string) => {
        const svc = this.svcMgr.getService(name);
        return svc ? svc.state === 'Running' : false;
      },

      portProxy: this.portProxyTable,
      dynamicFirewallRules: this.dynamicFirewallRules,
      eventLog: this.eventLog,
      dnsCache: this.dnsCache,

      smbShares: this.smbShares,
      netUseTable: this.netUseTable,
      smbSessions: this.smbSessions,
      dialSmbShare: (targetIp: string, shareName: string, username: string, password: string) =>
        this.dialSmbShare(targetIp, shareName, username, password),
      dhcpServerRole: this.getDhcpServerRole(),
      npsRole: this.getNpsRole(),
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
    if (lower === 'ver') return WIN_VER_STRING;
    if (lower === 'hostname') return this.hostname;
    if (lower === 'vol')  return this.cmdVol(args);
    if (lower === 'chcp') return this.cmdChcp(args);
    if (lower === 'date') return this.cmdDate(args);
    if (lower === 'time') return this.cmdTime(args);
    if (lower === 'sc' || lower === 'sc.exe') {
      return cmdSc(
        { serviceManager: this.svcMgr, processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin(), currentUser: this.userMgr.currentUser },
        args,
      );
    }
    if (lower === 'auditpol' || lower === 'auditpol.exe') {
      return cmdAuditpol(this.auditPolicy, args);
    }
    if (lower === 'winrm') {
      return cmdWinrm(this.winrm, args);
    }
    // `net` is a multi-subcommand router — all its subhandlers are sync
    // (cmdNetUser / cmdNetLocalgroup / cmdNetStart / cmdNetStop). `net use`
    // now dials the network for its add-form (PRD-Windows-Server.md §5 P3)
    // so — like ping/tracert — it no longer has a sync path here; it falls
    // through to `null` and callers retry via executeCmdCommand().
    if (lower === 'net' && args.length > 0) {
      const subCmd = args[0].toLowerCase();
      const subArgs = args.slice(1);
      const netUserCtx = { hostname: this.hostname, userManager: this.userMgr, directoryStore: this.getDirectoryStore() };
      if (subCmd === 'user')        return cmdNetUser(netUserCtx, subArgs);
      if (subCmd === 'localgroup')  return cmdNetLocalgroup(netUserCtx, subArgs);
      const netSvcCtx = { serviceManager: this.svcMgr, processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin() };
      if (subCmd === 'start')       return cmdNetStart(netSvcCtx, subArgs);
      if (subCmd === 'stop')        return cmdNetStop(netSvcCtx, subArgs);
      if (subCmd === 'share')       return cmdNetShare(this.buildNetContext(), subArgs);
      if (subCmd === 'session')     return this.cmdNetSession(subArgs);
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

  simulatedDate(): Date {
    return new Date(this.wallEpoch + this.clock.now());
  }

  simulatedNow(): number {
    return this.clock.now();
  }

  advanceTime(ms: number): void {
    this.clock.advance(ms);
    this.procMgr.advanceTime(ms);
    this.fireDueScheduledTasks();
    this.svcMgr.advanceRecoveryTimers(
      this.simulatedDate().getTime(),
      (svc) => this.procMgr.onServiceStarted(svc.name, svc.processName),
    );
  }

  private fireDueScheduledTasks(): void {
    if (this.svcMgr.getService('Schedule')?.state !== 'Running') return;
    const now = this.simulatedDate();
    for (const task of this.scheduledTasks.values()) {
      let guard = 0;
      while (task.runAt && task.runAt.getTime() <= now.getTime() && guard++ < 20_000) {
        WinSys.runScheduledProgram(task, this.procMgr, now);
        this.runScheduledPowerShellScript(task.command);
        task.runAt = task.intervalMs
          ? new Date(task.runAt.getTime() + task.intervalMs)
          : undefined;
      }
    }
  }

  private runScheduledPowerShellScript(command?: string): void {
    if (!command) return;
    this.executePowerShellFileCommand(command);
  }

  /** Runs a `powershell(.exe) -File "<path>.ps1"` command line headlessly. Returns
   *  whether the command matched and the script executed. */
  private executePowerShellFileCommand(command: string): boolean {
    const match = /^\s*powershell(?:\.exe)?\s+-file\s+"?([^"]+\.ps1)"?/i.exec(command);
    if (!match) return false;
    const result = this.fs.readFile(match[1]);
    if (!result.ok || result.content === undefined) return false;
    this.getPowerShellInterpreter().executeInteractive(result.content);
    return true;
  }

  /** `sc failure ... actions= run/<delay>` fires: a transient `powershell.exe`
   *  runs the configured command, matching real SCM recovery-action behavior. */
  private runRecoveryCommand(command: string): void {
    if (!command) return;
    const proc = this.procMgr.spawnProcess('powershell.exe', 620, 'NT AUTHORITY\\SYSTEM', { systemOwned: true });
    this.executePowerShellFileCommand(command);
    this.procMgr.killProcess(proc.pid, true, true);
  }

  private cmdSysteminfo(): string {
    return WinSys.cmdSysteminfo(this.buildSystemContext());
  }

  // ─── PSDeviceContext implementation ───────────────────────────

  getFileSystem(): WindowsFileSystem { return this.fs; }
  getPortsMap(): Map<string, Port> { return this.ports; }
  getCwd(): string { return this.cwd; }
  setCwd(path: string): void { this.cwd = path; }
  /**
   * String-returning surface for PowerShell/cmd consumers (PSDeviceContext).
   * Deliberately NOT named `getDefaultGateway` - that name is EndHost's own
   * IPAddress-returning method, and overriding it here with a different
   * return type would violate that base contract for every generic
   * EndHost-typed caller (Linux/router/switch code all expect IPAddress).
   */
  getDefaultGatewayString(): string | null { return this.defaultGateway?.toString() ?? null; }
  getDnsServers(ifName: string): string[] {
    return this.effectiveDnsServers(ifName);
  }

  /**
   * Residual DHCP-lease lifetimes for an interface, or null when the address
   * is not leased. Feeds Get-NetIPAddress's ValidLifetime / PreferredLifetime,
   * the way a real Windows host reports the time left on a DHCP address.
   */
  getInterfaceLeaseLifetimes(ifName: string): { validSeconds: number; preferredSeconds: number } | null {
    const lease = this.dhcpClient.getState(ifName)?.lease;
    if (!lease) return null;
    if (lease.serverIdentifier === '0.0.0.0') return null;
    const remaining = Math.max(0, Math.floor((lease.expiration - Date.now()) / 1000));
    const preferred = Math.max(0, Math.min(remaining, Math.floor((lease.leaseStart + lease.renewalTime * 1000 - Date.now()) / 1000)));
    return { validSeconds: remaining, preferredSeconds: preferred };
  }

  getDhcpServer(ifName: string): string | null {
    const lease = this.dhcpClient.getState(ifName)?.lease;
    if (!lease || lease.serverIdentifier === '0.0.0.0') return null;
    return lease.serverIdentifier;
  }

  setDnsServers(ifName: string, servers: string[]): void {
    this.dnsConfig.set(ifName, { servers: [...servers], mode: 'static' });
  }

  getClassId(ifName: string): string | null { return this.dhcpClassIds.get(ifName) ?? null; }
  setClassId(ifName: string, classId: string | null): void {
    if (classId) this.dhcpClassIds.set(ifName, classId);
    else this.dhcpClassIds.delete(ifName);
  }
  getClassId6(ifName: string): string | null { return this.dhcpClassIds6.get(ifName) ?? null; }
  setClassId6(ifName: string, classId: string | null): void {
    if (classId) this.dhcpClassIds6.set(ifName, classId);
    else this.dhcpClassIds6.delete(ifName);
  }

  private getDhcpLease(ifName: string): { ipAddress: string; serverIdentifier: string; leaseStart: number; expiration: number; dnsServers: string[] } | null {
    const lease = this.dhcpClient.getState(ifName)?.lease;
    if (!lease) return null;
    return {
      ipAddress: lease.ipAddress,
      serverIdentifier: lease.serverIdentifier,
      leaseStart: lease.leaseStart,
      expiration: lease.expiration,
      dnsServers: lease.dnsServers ?? [],
    };
  }

  /** Libère le bail actif s'il y en a un, puis réinitialise l'état du client DHCP à `INIT` — toujours, même sans bail (comportement `ipconfig /release` réel). */
  private releaseDhcpLease(ifName: string): void {
    const state = this.dhcpClient.getState(ifName);
    if (state?.lease) {
      const oldIP = state.lease.ipAddress;
      this.dhcpClient.releaseLease(ifName);
      this.addDHCPEvent('RELEASE', `Released IP ${oldIP} on ${ifName}`);
    }
    if (state) state.state = 'INIT';
  }

  private requestDhcpLease(ifName: string): void {
    this.dhcpClient.requestLease(ifName, { verbose: false });
    const state = this.dhcpClient.getState(ifName);
    if (state?.lease && state.lease.serverIdentifier !== '0.0.0.0') {
      this.addDHCPEvent('RENEW', `Renewed IP ${state.lease.ipAddress} on ${ifName}`);
    }
  }

  private releaseDynamicIPv6(ifName: string): string[] {
    const port = this.ports.get(ifName);
    if (!port) return [];
    const released = port.releaseDynamicIPv6Addresses();
    if (released.length > 0) {
      this.addDHCPEvent('RELEASE', `Released IPv6 address(es) ${released.map((e) => e.address.toString()).join(', ')} on ${ifName}`);
    }
    return released.map((e) => e.address.toString());
  }

  private resetStackState(): void {
    for (const [name, port] of this.ports) {
      port.clearIP();
      this.dhcpClient.releaseLease(name);
    }
    this.defaultGateway = null;
    this.routingTable = [];
    this.arpTable.clear();
    this.dnsConfig.clear();
    this.dnsSuffix = '';
  }

  private resetTcpIpStack(): void {
    this.resetStackState();
    this.addDHCPEvent('RESET', 'TCP/IP stack has been reset');
  }

  private resetWinsockCatalog(): void {
    this.addDHCPEvent('RESET', 'Winsock catalog has been reset');
  }

  private renameInterface(oldName: string, newName: string): boolean {
    const port = this.ports.get(oldName);
    if (!port || this.ports.has(newName)) return false;
    this.ports.delete(oldName);
    this.ports.set(newName, port);
    const dns = this.dnsConfig.get(oldName);
    if (dns) { this.dnsConfig.delete(oldName); this.dnsConfig.set(newName, dns); }
    if (this.dhcpInterfaces.has(oldName)) { this.dhcpInterfaces.delete(oldName); this.dhcpInterfaces.add(newName); }
    const cid = this.dhcpClassIds.get(oldName);
    if (cid) { this.dhcpClassIds.delete(oldName); this.dhcpClassIds.set(newName, cid); }
    const cid6 = this.dhcpClassIds6.get(oldName);
    if (cid6) { this.dhcpClassIds6.delete(oldName); this.dhcpClassIds6.set(newName, cid6); }
    return true;
  }

  /** Routes IPv6 statiques (`netsh interface ipv6 add route`) — état par-instance, jamais réassigné. */
  private readonly ipv6Routes: WinIPv6RouteEntry[] = [];
  /** Proxy WinHTTP global (`netsh winhttp set proxy`) — état par-instance. */
  private winhttpProxyValue = '';
  /** État de configuration `netsh dhcpclient` (service installé, traçage, interfaces libérées) — état par-instance. */
  private readonly dhcpClientNetshState = {
    installed: true, tracingEnabled: true, tracingOutput: '', traceEnabled: false,
    releasedIfaces: new Set<string>(),
  };
  /** Magasin de politiques IPsec `netsh ipsec` (static + dynamic) — état par-instance. */
  private readonly ipsecNetshState: WinIpsecMutableState = {
    policies: [], filterLists: [], filterActions: [], rules: [],
    dynamic: { mmSecMethods: '', qmSecMethods: '', ikeLogging: 0, config: {} },
  };
  /** Magasins `netsh` de fonctionnalités (lan/wlan/http/bridge/namespace) — état par-instance. */
  private readonly netshFeatureState: WinNetshFeatureState = {
    lan: { profiles: [], tracingEnabled: true, autoconnect: new Map() },
    wlan: { profiles: [] },
    http: { ipListen: [], sslCerts: [] },
    bridge: { bridges: [] },
    nrpt: { policies: [] },
  };

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
    // Allow specifying server as second argument: nslookup domain server.
    // Queries travel over UDP/53 through the simulated network (EndHost
    // socket layer) — an unreachable server now times out for real.
    return executeNslookup(args, this.dnsQueryFn(), this.firstConfiguredDnsServer());
  }

  /** Wraps `queryDnsServer` in the `(server, name, type, timeoutMs)` shape
   *  `executeNslookup`/`NslookupSubShell` both expect — shared by the
   *  non-interactive `nslookup` command and its interactive REPL entry
   *  point below, so there is exactly one DNS query adapter for Windows. */
  private dnsQueryFn(): DnsQueryFn {
    return async (s, n, t, ms) => {
      let server: IPAddress;
      try { server = new IPAddress(s); } catch { return null; }
      return this.queryDnsServer(server, n, t, ms);
    };
  }

  /** First configured DNS server across any interface, or '' if none. */
  private firstConfiguredDnsServer(): string {
    for (const [ifName] of this.ports) {
      const servers = this.getDnsServers(ifName);
      if (servers.length > 0) return servers[0];
    }
    return '';
  }

  /**
   * Adapter for `nslookup`'s interactive REPL (PRD-Nslookup-Dig-Rndc-Runas.md
   * §2.1.1). Windows previously had no interactive mode at all — bare
   * `nslookup` just fell through to `executeNslookup`'s "Usage: ..." line.
   * Rather than reimplementing the REPL, this hands `WindowsTerminalSession`
   * the same `{query, initialServer}` shape `NslookupSubShell` already uses
   * for Linux, so both platforms share the exact same interactive
   * implementation. Returns `null` when the DNS Client service isn't
   * running, mirroring the non-interactive command's own gate above.
   */
  getInteractiveNslookupDeps(): { query: DnsQueryFn; initialServer: string } | null {
    if (this.svcMgr.getService('Dnscache')?.state !== 'Running') return null;
    return { query: this.dnsQueryFn(), initialServer: this.firstConfiguredDnsServer() };
  }

  // ─── User / Access Control ──────────────────────────────────────

  /** Switch current user context (for testing & runas). Always drops any active domain logon — `logonDomain` re-establishes it right after calling this. */
  setCurrentUser(name: string): void {
    this.domainSession = null;
    this.kerberosTicketCache.clear();
    if (this.userMgr.setCurrentUser(name)) {
      this.env.set('USERNAME', this.userMgr.currentUser);
      this.env.set('USERPROFILE', `C:\\Users\\${this.userMgr.currentUser}`);
      this.env.set('HOMEPATH', `\\Users\\${this.userMgr.currentUser}`);
    }
  }

  /** Override Equipment's hard-coded 'user' default so syncDeviceState
   *  reports the real currently-logged-in account on this Windows host. */
  getCurrentUser(): string { return this.userMgr.currentUser; }

  /** Get the service manager (for PowerShellExecutor and other integrations) */
  getServiceManager(): WindowsServiceManager { return this.svcMgr; }

  /**
   * Server Manager's role/feature model — null on a client (the
   * ServerManager module doesn't ship on Windows client), overridden by
   * `WindowsServer`. This null default is what makes
   * `Get/Install-WindowsFeature` fall through to "not recognized" on a
   * `windows-pc`, matching real Windows.
   */
  getRoleManager(): import('./windows/server/RoleManager').RoleManager | null { return null; }

  /**
   * AD DS directory (PRD-Windows-Server.md §5 P5) — null until
   * `Install-ADDSForest` promotes a `WindowsServer` to a domain
   * controller; always null on a client, overridden by `WindowsServer`.
   */
  getDirectoryStore(): import('./windows/server/ad/DirectoryStore').DirectoryStore | null { return null; }

  /**
   * DNS Server role (PRD-Windows-Server.md §5 P7) — null until
   * `Install-WindowsFeature DNS` on a `WindowsServer`; always null on a
   * client, overridden by `WindowsServer`.
   */
  getDnsServerRole(): import('./windows/server/dns/WindowsDnsServerRole').WindowsDnsServerRole | null { return null; }

  /**
   * DHCP Server role (PRD-Windows-Server.md §5 P8) — null until
   * `Install-WindowsFeature DHCP` on a `WindowsServer`; always null on a
   * client, overridden by `WindowsServer`.
   */
  getDhcpServerRole(): import('./windows/server/dhcp/WindowsDhcpServerRole').WindowsDhcpServerRole | null { return null; }

  /**
   * NPS (RADIUS) role (PRD-Windows-Server.md §5 P9) — null until
   * `Install-WindowsFeature NPAS` on a `WindowsServer`; always null on a
   * client, overridden by `WindowsServer`.
   */
  getNpsRole(): import('./windows/server/nps/WindowsNpsRole').WindowsNpsRole | null { return null; }

  /**
   * Web Server (IIS) role (PRD-Windows-Server.md §5 P11) — null until
   * `Install-WindowsFeature Web-Server` on a `WindowsServer`; always null
   * on a client, overridden by `WindowsServer`.
   */
  getIisRole(): import('./windows/server/iis/WindowsIisRole').WindowsIisRole | null { return null; }

  /**
   * AD CS (Certificate Services) role (PRD-Windows-Server-Advanced.md §5
   * P13) — null until `Install-WindowsFeature AD-Certificate` on a
   * `WindowsServer`; always null on a client, overridden by `WindowsServer`.
   */
  getAdcsRole(): import('./windows/server/adcs/CaRole').WindowsAdcsRole | null { return null; }

  /**
   * DFS Namespaces role (PRD-Windows-Server-Advanced.md §5 P16) — null
   * until `Install-WindowsFeature FS-DFS-Namespace` on a `WindowsServer`;
   * always null on a client, overridden by `WindowsServer`.
   */
  getDfsNamespaceRole(): import('./windows/server/dfs/DfsNamespace').DfsNamespaceRegistry | null { return null; }

  /**
   * DFS Replication role (PRD-Windows-Server-Advanced.md §5 P16) — null
   * until `Install-WindowsFeature FS-DFS-Replication` on a `WindowsServer`
   * (also gates the TCP/5722 listener below); always null on a client,
   * overridden by `WindowsServer`.
   */
  getDfsrRole(): import('./windows/server/dfs/DfsReplicationGroup').WindowsDfsrRole | null { return null; }

  /**
   * WSFC cluster membership (PRD-Windows-Server-Advanced.md §5 P18) — null
   * until `New-Cluster` succeeds on a `WindowsServer`; always null on a
   * client, overridden by `WindowsServer`.
   */
  getClusterRole(): import('./windows/server/cluster/ClusterService').ClusterService | null { return null; }

  /**
   * WSUS role (PRD-Windows-Server-Advanced.md §5 P19) — null until
   * `Install-WindowsFeature UpdateServices` on a `WindowsServer`; always
   * null on a client, overridden by `WindowsServer`.
   */
  getWsusRole(): import('./windows/server/wsus/WsusRole').WindowsWsusRole | null { return null; }

  /**
   * Print and Document Services role (PRD-Windows-Server-Advanced.md §5
   * P20) — null until `Install-WindowsFeature Print-Services` on a
   * `WindowsServer`; always null on a client, overridden by `WindowsServer`.
   */
  getPrintServerRole(): import('./windows/server/print/PrintServerRole').WindowsPrintServerRole | null { return null; }

  /** `Get-WindowsUpdate` — this client's WSUS-approved updates for its configured target group (PRD-Windows-Server-Advanced.md §5 P19); empty if `Set-WUSettings -WUServer` was never run or the server can't be reached. */
  getWindowsUpdates(): WsusUpdate[] {
    if (!this.wsus.wuServer) return [];
    const res = queryWsusApprovedUpdates(this.getTcpStack(), this.wsus.wuServer, this.wsus.targetGroup ?? '');
    return res.ok ? res.updates : [];
  }

  /** Get the process manager (for PowerShellExecutor and other integrations) */
  getProcessManager(): WindowsProcessManager { return this.procMgr; }

  /** Adapts this device to `WinRunas.ts`'s narrow `RunasHost` contract. */
  private runasHost(): RunasHost {
    return {
      getUser: (name) => this.userMgr.getUser(name),
      getCurrentUser: () => this.userMgr.currentUser,
      setCurrentUser: (name) => this.setCurrentUser(name),
      executeCmdCommand: (command) => this.executeCmdCommand(command),
    };
  }

  /**
   * `runas` — non-interactive path (no password prompt: this is
   * `device.executeCommand()`, with no terminal to prompt through). The
   * real, password-verified interactive prompt lives in
   * `WindowsTerminalSession` (PRD-Nslookup-Dig-Rndc-Runas.md P11), which
   * calls {@link runAsUserVerified} after collecting and checking the
   * password via the same masked-prompt mechanism SSH's top-level password
   * challenge already uses.
   */
  private async cmdRunas(args: string[]): Promise<string> {
    return runRunasNonInteractive(this.runasHost(), args);
  }

  /** Runs `command` as `userName` — called by `WindowsTerminalSession` once the password has already been verified via `checkPassword`. */
  async runAsUserVerified(userName: string, command: string): Promise<string> {
    return runAsUser(this.runasHost(), userName, command);
  }

  /** `runas /netonly` — real semantics simplified to "run as the caller" (PRD-Nslookup-Dig-Rndc-Runas.md §2.2): the target account is never verified locally or switched into. */
  async runNetOnlyCommand(command: string): Promise<string> {
    return runAsUser(this.runasHost(), this.userMgr.currentUser, command);
  }

  /** `runas /savecred` vault passthrough — used by `WindowsTerminalSession` to skip re-prompting once a credential has been saved. */
  getSavedRunasCredential(userName: string): string | null {
    return this.userMgr.getSavedCredential(userName);
  }

  saveRunasCredential(userName: string, password: string): void {
    this.userMgr.saveCredential(userName, password);
  }

  /** Real TCP connect+close reachability probe, used by `nltest /dsgetdc:` — not a topology shortcut. */
  private probeTcpReachable(address: string, port: number): boolean {
    const socket = this.getTcpStack().connect(address, port);
    if (!socket || socket.state !== 'established') return false;
    socket.close();
    return true;
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

  /**
   * Public surface used by the topology-bypass SSH client: synthesize an
   * inbound TCP SYN to (dstIp, dstPort) coming from `srcIp` and feed it
   * through {@link firewallFilter}. The Windows Filtering Platform
   * silently drops blocked packets (no RST, no ICMP) so the client times
   * out — exactly like a real Windows host. The matching Security event
   * `5152` is still emitted via the bus → WindowsEventLogProjection.
   */
  inboundSshFirewallVerdict(srcIp: string, dstPort: number): 'accept' | 'drop' {
    const dstIp = this.getPorts().map(p => p.getIPAddress()?.toString()).find(Boolean) ?? '0.0.0.0';
    const tcp: TCPPacket = {
      type: 'tcp',
      sourcePort: 49152, destinationPort: dstPort,
      sequenceNumber: 0, acknowledgementNumber: 0,
      flags: { syn: true, ack: false, fin: false, rst: false, psh: false, urg: false },
      windowSize: 65535, checksum: 0, payload: null,
    };
    const ipPkt = createIPv4Packet(
      new IPAddress(srcIp), new IPAddress(dstIp),
      IP_PROTO_TCP, 64, tcp, 20,
    );
    const verdict = this.firewallFilter(this.getPorts()[0]?.getName() ?? 'eth0', ipPkt, 'in');
    return verdict === 'accept' ? 'accept' : 'drop';
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
