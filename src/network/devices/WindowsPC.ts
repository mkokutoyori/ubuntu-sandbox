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
import { LacpAgent } from '@/network/lacp/LacpAgent';
import type { NicTeam, TeamMember, TeamNic } from './windows/WindowsNicTeam';
import {
  lbAlgorithmToLoadBalance, primaryTeamNic, defaultTeamNicName,
} from './windows/WindowsNicTeam';
import { selectBundleMember } from '@/network/lacp/loadBalance';
import type { EthernetFrame } from '../core/types';
import { MACAddress } from '../core/types';
import { toDisplayName } from './windows/WindowsInterfaceNaming';
import { NetworkAdapter } from './host/hardware';
import {
  MULTIPLEXOR_DRIVER, adapterNameProblem, adapterNameTaken, identityOfPort,
  windowsInterfaceDescription,
} from './windows/netAdapter';
import { NtpAgent, type NtpHost } from '../ntp/NtpAgent';
import { W32TimeService } from './windows/W32TimeService';
import { DnsCache } from '../dns/resolver/DnsCache';
import { RRType } from '../dns/wire/RRType';
import type { ARecordData, PtrRecordData } from '../dns/wire/ResourceRecord';
import { ptrQName, resourceRecordToLegacyRecord } from '../dns/compat/DnsWireCompat';
import type { UserAccountHost } from '../equipment/HostCapabilities';
import { Port } from '../hardware/Port';
import { IPAddress, IPv6Address, SubnetMask, DeviceType, type IPv4Packet, type TCPPacket, IP_PROTO_TCP, IP_PROTO_UDP, IP_PROTO_ICMP, createIPv4Packet } from '../core/types';
import { WindowsSshServerContext } from '../protocols/ssh/server/WindowsSshServerContext';
import { SshServerHandler } from '../protocols/ssh/server/SshServerHandler';
import type { TcpStream } from '../tcp/types';
import type { TcpSocket } from '../tcp/TcpStack';
import { CrossVendorSshHost } from '../protocols/ssh/server/CrossVendorSshHost';
import { WindowsUserManagerAuthority } from './windows/network/WindowsUserManagerAuthority';
import { runWindowsSshClient } from './windows/network/WindowsSshClient';
import { runWindowsSftpClient } from './windows/network/WindowsSftpClient';
import { runWindowsScpClient } from './windows/network/WindowsScpClient';
import { splitCmdArgs } from './windows/cmdline';
import { WindowsAccountsPolicy } from './windows/security/WindowsAccountsPolicy';
import { DoskeyTable } from './windows/cli/DoskeyTable';
import { runPowerShellShim, createShimState, type PsShimState } from './windows/PowerShellCmdShim';
import { PSInterpreter, PSRuntimeError } from '@/powershell/interpreter/PSInterpreter';
import { createWindowsPSProviders } from '@/powershell/providers/WindowsPSProviders';
import type { VpnConnectionInfo } from '@/powershell/providers/PSProviders';
import type { WinCommandContext, RouteEntry, TracerouteHop } from './windows/WinCommandExecutor';
import type { WinFileCommandContext } from './windows/WinFileCommands';
import { WindowsFileSystem } from './windows/WindowsFileSystem';
import { HostsFile } from './HostsFile';
import { LlmnrAgent } from '../llmnr/LlmnrAgent';
import { LLMNR_RECORD_TTL } from '../llmnr/types';
import { MdnsAgent } from '../mdns/MdnsAgent';
import { MDNS_RECORD_TTL } from '../mdns/types';
import {
  isLlmnrEnabled, isMdnsEnabled, type DnsClientQueryOptions,
} from './windows/WinDnsClientPolicy';
import {
  isScriptBlockLoggingEnabled, isTranscriptionEnabled, transcriptDirectory,
  transcriptFileName, transcriptHeader, scriptBlockId,
  POWERSHELL_OPERATIONAL_LOG, POWERSHELL_PROVIDER, SCRIPT_BLOCK_LOGGED,
} from './windows/WinPowerShellLogging';
import { WindowsShellSession } from './windows/shell/WindowsShellSession';
import { WindowsUserManager } from './windows/WindowsUserManager';
import { WindowsSecurityAudit } from './windows/WindowsSecurityAudit';
import { WindowsSecurityAuditProjection } from './windows/WindowsSecurityAuditProjection';
import { WindowsEventLogProjection } from './windows/WindowsEventLogProjection';
import { WindowsServicePortProjection } from './windows/WindowsServicePortProjection';
import { PortProxyTable } from './windows/PortProxyTable';
import { PortProxySocketProjection } from './windows/PortProxySocketProjection';
import { WindowsServiceManager } from './windows/WindowsServiceManager';
import { WindowsAuditPolicy, cmdAuditpol } from './windows/WindowsAuditPolicy';
import { WindowsWinRmConfig, cmdWinrm } from './windows/WindowsWinRmConfig';
import { WindowsProcessManager } from './windows/WindowsProcessManager';
import { HostClock } from './host/lifecycle/HostClock';
import { PSRegistryProvider, WINDOWS_CLIENT_PRODUCT_IDENTITY, WINDOWS_SERVER_PRODUCT_IDENTITY, type RegistryValue, type RegistryValueChange } from './windows/PSRegistryProvider';
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
import { cmdNetUse, type NetUseEntry } from './windows/WinNetUse';
import { cmdNetShare } from './windows/WinNetShare';
import { SmbShareTable } from './windows/server/smb/SmbShareTable';
import { SmbSessionTable } from './windows/server/smb/SmbSessionTable';
import { SmbServerHandler } from './windows/server/smb/SmbServer';
import { dialSmbShare, type SmbDialResult } from './windows/server/smb/SmbClient';
import { WinRmServerHandler } from './windows/server/winrm/WinRmServer';
import { parseSubscriptionXml, type WecSubscription } from './windows/server/wec/WecSubscription';
import { LdapServerHandler } from './windows/server/ad/ldap/LdapServer';
import { selfSignedLdapCert } from './windows/server/ad/ldap/ldapStartTls';
import { dialLdap } from './windows/server/ad/ldap/LdapClient';
import { getForestForDomain } from './windows/server/ad/forest/Forest';
import { KdcSessionHandler } from '@/network/kerberos/KdcSession';
import { dialKdc } from '@/network/kerberos/KerberosClient';
import { principalName, PrincipalNameType } from '@/network/kerberos/types';
import { KerberosTicketCache } from '@/network/kerberos/KerberosTicketCache';
import { KerberosSignalStore } from '@/network/kerberos/observables';
import { KerberosSignalRefreshActor } from '@/network/kerberos/actors/KerberosSignalRefreshActor';
import {
  ReplicationServerHandler, AD_REPLICATION_PORT, pullReplication, notifySyncNow, queryRemoteReplicationStatus, triggerRemotePull, setRemoteOption,
  type ReplicationPullResult, type ReplicationLogEntry,
} from './windows/server/ad/replication/ReplicationSession';
import { encodeHighWatermarkVector } from './windows/server/ad/replication/HighWatermarkVector';
import { parseDN } from './windows/server/ad/ldap/LdapDN';
import { NTDS_OPTION_NAMES, type NtdsOption } from './windows/WinRepadmin';
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
import { dialWinRm, type WinRmDialResult, pushForwardedEvent } from './windows/server/winrm/WinRmClient';
// WEC collector discovery is an explicit non-objective of
// docs/PRD-Frame-Only-Refactor.md §2.2, inherited from docs/PRD-Wecutil.md
// §2.2. Not pending work.
// eslint-disable-next-line no-restricted-imports
import { EquipmentRegistry } from '../equipment/EquipmentRegistry';
import type { EventLogEntry } from './windows/PSEventLogProvider';
import { type DomainMembership, type DomainSession, parseDomainQualifiedUser } from './windows/domain/DomainTypes';
import { joinDomain, type DomainJoinResult } from './windows/domain/DomainJoinClient';
import { logonDomainUser } from './windows/domain/DomainLogonClient';
import { pullGroupPolicy } from './windows/domain/GpoPullClient';
import { resetComputerSecretOverWire, removeComputerAccountOverWire, renameComputerAccountOverWire } from './windows/domain/ComputerSecureChannelClient';
import { randomSessionKey } from '@/network/kerberos/crypto';
import { dialHttp as dialHttpClient, parseHttpUrl } from '@/network/http/HttpClient';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';
import type { GpoSettings } from './windows/server/ad/AdTypes';
import { cmdNltest, cmdDcdiag, cmdKlist } from './windows/WinDomainDiag';
import { cmdRepadmin, type RepadminContext } from './windows/WinRepadmin';
import { cmdDnscmd } from './windows/WinDnscmd';
import { cmdCertreq, cmdCertutil } from './windows/WinCertReq';
import { cmdDsregcmd } from './windows/WinDsregcmd';
import { WindowsCertStore } from './windows/CertStore';
import { DFSR_PORT, DfsrServerHandler } from './windows/server/dfs/DfsReplicationGroup';
import { WindowsRdpConfig } from './windows/WindowsRdpConfig';
import { cmdQuerySession, cmdLogoff } from './windows/WinRdpCommands';
import { RDP_PORT, RdpServerHandler, dialRdp, type RdpDialResult } from './windows/server/rdp/RdpSession';
import { WindowsWsusClientConfig } from './windows/WindowsWsusClientConfig';
import { WSUS_PORT, WsusServerHandler, queryWsusApprovedUpdates, type WsusUpdate } from './windows/server/wsus/WsusRole';
import { LPD_PORT, LpdServerHandler } from './windows/server/print/LpdTransport';
import { cmdLpr } from './windows/WinLpr';
import { WindowsLicensingState } from './windows/licensing/LicensingState';
import { cmdSlmgr } from './windows/WinSlmgr';
import { generateSelfSignedCertificate } from '@/network/pki/SelfSignedCertificate';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { CurlHost } from '@/network/http/curl/CurlHost';
import { runCurl } from '@/network/http/curl/CurlEngine';
import { linkNeighbourOf, type ScanHost } from '@/network/scan/nmap/NmapProbes';
import { runNmap } from '@/network/scan/nmap/NmapRun';
import { cmdPrint } from './windows/WinPrint';
import { runRunasNonInteractive, runAsUser } from './windows/WinRunas';
import type { RunasHost } from './windows/WinRunas';
import { executeNslookup } from './linux/LinuxDnsService';
import type { DnsQueryFn } from '../dns/compat/DnsWireCompat';
import { SessionWorkQueue } from './host/session/SessionWorkQueue';
import { SessionSwapWindow } from './host/session/SessionSwapWindow';
import * as WinSys from './windows/WinSystemCommands';
import { cmdReg as winCmdReg } from './windows/WinRegCommand';
import { cmdDir } from './windows/WinDir';
import { CrossVendorRemoteShell } from '@/shell/CrossVendorRemoteShell';
import type { NetIPAddressEntry } from './windows/netIpAddress';
import type { NetRouteEntry } from './windows/netRoute';
import {
  type FirewallPacketFacts, type NetFirewallRuleEntry,
  firewallRuleMatches, seedBuiltInFirewallRules,
} from './windows/netFirewallRule';
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

/** Le pas du planificateur de tâches — la minute, comme sous Windows. */
const TASK_TICK_MS = 60_000;

/**
 * `ReferenceId` a la mode Windows : l'adresse en hexadecimal suivie de
 * sa forme pointee — la meme adresse ecrite deux fois, pas deux faits.
 */
function w32ReferenceId(ref: string): string {
  if (!ref || ref === '.INIT.') return '0x00000000 (unspecified)';
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ref)) return `0x00000000 (${ref})`;
  const hex = ref.split('.')
    .map((o) => parseInt(o, 10).toString(16).toUpperCase().padStart(2, '0')).join('');
  return `0x${hex} (source IP:  ${ref})`;
}

function seededFirewallRules(): Map<string, NetFirewallRuleEntry> {
  const store = new Map<string, NetFirewallRuleEntry>();
  seedBuiltInFirewallRules(store);
  return store;
}

export class WindowsPC extends EndHost implements UserAccountHost {
  protected readonly defaultTTL = 128;

  protected override registersOwnForwardDns(): boolean { return true; }

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
  getEnvVars(): Map<string, string> {
    const merged = this.wellKnownEnv();
    for (const [k, v] of this.env) merged.set(k.toUpperCase(), v);
    return merged;
  }

  setEnvVar(name: string, value: string): void { this.env.set(name.toUpperCase(), value); }

  removeEnvVar(name: string): void { this.env.delete(name.toUpperCase()); }
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
  readonly dnsCache = new DnsCache();
  /** DHCP client trace flag */
  private dhcpTraceEnabled: boolean = false;
  /** Primary DNS suffix (set via netsh dnsclient set global) */
  private dnsSuffix: string = '';
  /** User and group manager (access control / privileges) */
  private userMgr: WindowsUserManager;
  /** Domain-join state (`Add-Computer`/`netdom join`) — null while this machine is in a workgroup (PRD-Windows-Server.md §5 P6). */
  private domainMembership: DomainMembership | null = null;
  /** `Install-ADServiceAccount`'s local cache — real Windows retrieves and caches the gMSA/sMSA's managed password locally once authorized; `Test-ADServiceAccount` reflects whether that succeeded on THIS machine, not global directory state. Keyed by sAMAccountName (`<name>$`), lowercased. */
  private readonly installedServiceAccounts = new Set<string>();
  /** The active domain logon (`LAB\alice`/`alice@lab.local`), if any — distinct from `userMgr.currentUser`, which domain logon also updates for prompt/env-var purposes. */
  private domainSession: DomainSession | null = null;
  /** Real Kerberos ticket cache (PRD-Windows-Server-Advanced.md §5 P2) — populated by an actual AS exchange as a side effect of domain logon, backing `klist`. */
  private readonly kerberosTicketCache: KerberosTicketCache = new KerberosTicketCache();
  /** One entry per `replicateFrom` cycle, annotated intra-/inter-site (PRD-Windows-Server-Advanced.md §5 P6) — this simulator's minimal stand-in for a real replication event log (full observability arrives at §5 P12). */
  private readonly replicationLog: ReplicationLogEntry[] = [];
  /** `repadmin /options` (PRD-Repadmin.md P8) — this DC's NTDS Settings flags. `DISABLE_OUTBOUND_REPL`/`DISABLE_INBOUND_REPL` have a real causal effect on `ReplicationServerHandler`/`replicateFrom`; `IS_GC`/`DISABLE_SPN_REGISTRATION` are declarative storage only (§2.1 P8). */
  private readonly ntdsOptions = new Set<NtdsOption>();
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
  /** `Cert:\LocalMachine\Root` — the anchors outbound TLS clients on this host verify against. */
  private readonly trustedCAs: X509Certificate[] = [];
  addTrustedCertificateAuthority(cert: X509Certificate): void {
    this.trustedCAs.push(cert);
  }
  getTrustedCertificateAuthorities(): readonly X509Certificate[] { return this.trustedCAs; }
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
      // No `shared` bag: the factory already defaults every store to this
      // device's own registry / event log / network tables, so `reg` and
      // the cmdlets cannot end up on two different copies of the machine.
      this.psInterpreter = new PSInterpreter(
        createWindowsPSProviders(this), { edition: this.getWindowsEdition() },
      );
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
  /** Windows Event Collector subscriptions (PRD-Wecutil.md §2.1 P3) — keyed by SubscriptionId, populated by `wecutil cs`. */
  private wecSubscriptions: Map<string, WecSubscription> = new Map();

  // ── Per-device transitional state (Phase 4 relocation) ──────────────────
  // These maps + provider instances used to live as private fields on
  // PowerShellExecutor. Moving them to the device makes them visible to
  // any consumer (the interpreter, future Get-* cmdlets, the executor's
  // own handlers via shared references) without going through the
  // executor as the source of truth.
  /** Additional IP addresses (added via New-NetIPAddress). */
  readonly extraIPs: Map<string, NetIPAddressEntry> = new Map();
  /** Extra routes (added via New-NetRoute). */
  readonly extraRoutes: Map<string, NetRouteEntry> = new Map();
  /** Dynamic firewall rules (added via New-NetFirewallRule). */
  readonly firewallRules: Map<string, NetFirewallRuleEntry> = seededFirewallRules();
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
    // One machine, one service configuration: the SCM writes its own keys
    // under `HKLM:\SYSTEM\CurrentControlSet\Services`, so `sc qc` and
    // `reg query` cannot end up describing the same service differently.
    this.svcMgr.attachRegistrySink(this.registry);
    this.procMgr = new WindowsProcessManager();
    this.procMgr.attachServiceManager(this.svcMgr, () => this.simulatedDate().getTime());
    // Une seule horloge pour la machine : celle que `Get-Date` lit est
    // celle qui horodate le journal, sans quoi un filtre temporel écarte
    // les événements que la machine vient d'écrire.
    this.eventLog.attachClock(() => this.simulatedDate().getTime());
    this.initDefaultSockets();
    this.wireReactiveProjections();
    this.auditPolicy.seedDefaults(type === 'windows-server' ? 'server' : 'client');
    this.registry.onValueChanged = (change) => {
      this.syncLinkLocalResponders();
      if (change) this.auditRegistryChange(change);
    };
  }

  // ─── LLMNR / mDNS (client DNS Windows) ──────────────────────────

  private _llmnrAgent: LlmnrAgent | null = null;
  private _mdnsAgent: MdnsAgent | null = null;

  /**
   * Les deux répondeurs de lien. Ce sont les mêmes agents que ceux de
   * systemd-resolved côté Linux — LLMNR est d'ailleurs une invention de
   * Microsoft, et un Windows le parle par défaut là où un Linux attend
   * qu'on le lui demande. Ils ne dépendent que de l'`EndHost` : rien à
   * spécialiser ici, seulement à brancher.
   */
  getLlmnrAgent(): LlmnrAgent {
    if (!this._llmnrAgent) this._llmnrAgent = new LlmnrAgent(this);
    return this._llmnrAgent;
  }

  getMdnsAgent(): MdnsAgent {
    if (!this._mdnsAgent) this._mdnsAgent = new MdnsAgent(this);
    return this._mdnsAgent;
  }

  /**
   * Aligne les deux répondeurs sur la stratégie du registre. Rappelé à
   * chaque écriture dans la base : sans cela, `reg add ... EnableMulticast
   * /d 0` annoncerait « opération réussie » et le port 5355 resterait
   * ouvert.
   */
  /**
   * 4657 — toute écriture dans la base laisse une trace auditée.
   *
   * Le seul chemin réellement audité jusqu'ici était le changement de
   * compte d'un service ; une valeur posée sous
   * `...\CurrentVersion\Run` — la persistance la plus classique qui
   * soit — ne produisait rien. Or ce n'est pas la clé qui doit décider,
   * c'est la stratégie d'audit : elle est consultée ici, et elle seule.
   */
  private auditRegistryChange(change: RegistryValueChange): void {
    if (!this.auditPolicy.isEnabled('Registry', 'success')) return;
    new WindowsSecurityAudit(this.eventLog).registryValueModified(
      `${change.path}\\${change.name}`,
      change.previous === undefined ? '' : String(change.previous),
      String(change.next),
      this.userMgr.currentUser || 'Administrator',
    );
  }

  /** 4698 — `Register-ScheduledTask` laisse désormais une trace. */
  auditScheduledTaskCreated(taskName: string, command: string): void {
    if (!this.auditPolicy.isEnabled('Other Object Access Events', 'success')) return;
    new WindowsSecurityAudit(this.eventLog).scheduledTaskCreated(
      taskName, command, this.userMgr.currentUser || 'Administrator');
  }

  /**
   * 1102 — l'effacement d'un journal s'inscrit dans le journal Security,
   * *après* le vidage. Sans cela, effacer ses traces ne laisserait
   * aucune trace, ce que Windows refuse par construction.
   */
  auditLogCleared(logName: string): void {
    new WindowsSecurityAudit(this.eventLog).auditLogCleared(
      logName, this.userMgr.currentUser || 'Administrator');
  }

  /**
   * 4663 — un objet audité vient d'être touché.
   *
   * Deux conditions, et les deux comptent : la sous-catégorie « File
   * System » doit être activée *et* l'objet doit porter une SACL qui
   * couvre cet accès. C'est ce couple qui fait de l'audit d'objets
   * quelque chose d'utilisable : activer la stratégie sans poser de
   * SACL noierait le journal sous chaque lecture de fichier du système.
   */
  auditObjectAccess(absPath: string, access: string, accessMask: string): void {
    if (!this.auditPolicy.isEnabled('File System', 'success')) return;
    const who = this.userMgr.currentUser || 'Administrator';
    if (!this.fs.isAudited(absPath, who, access)) return;
    new WindowsSecurityAudit(this.eventLog).objectAccessed(
      absPath, access, accessMask, who);
  }

  /**
   * 5142 — un partage réseau a été créé.
   *
   * Distinct de 5140, qui marque un *accès* à un partage : créer un
   * partage et l'atteindre sont deux événements différents, et les
   * confondre reviendrait à croire qu'un partage à peine créé a déjà
   * servi.
   */
  auditShareAdded(shareName: string, path: string): void {
    if (!this.auditPolicy.isEnabled('File Share', 'success')) return;
    new WindowsSecurityAudit(this.eventLog).shareAdded(
      shareName, path, this.userMgr.currentUser || 'Administrator');
  }

  /** 5140 — un client a atteint un partage. */
  auditShareAccessed(shareName: string, path: string, user: string, sourceAddress: string): void {
    if (!this.auditPolicy.isEnabled('File Share', 'success')) return;
    new WindowsSecurityAudit(this.eventLog).shareAccessed(
      shareName, path, user, sourceAddress);
  }

  /** 4670 — les permissions d'un objet du système de fichiers ont changé. */
  auditPermissionChange(absPath: string, identity: string, permissions: string): void {
    if (!this.auditPolicy.isEnabled('File System', 'success')) return;
    new WindowsSecurityAudit(this.eventLog).permissionChanged(
      absPath, identity, permissions, this.userMgr.currentUser || 'Administrator');
  }

  /** Quand la transcription de cette machine a commencé, et où. */
  private transcriptStartedAt: Date | null = null;

  /**
   * Ce que PowerShell journalise d'une commande exécutée : le bloc dans
   * le canal Operational (4104) si la stratégie l'exige, et la
   * transcription sur disque si elle est demandée.
   *
   * Le bloc est journalisé *tel qu'il s'exécute*. C'est ce qui rend
   * 4104 utile face à une obfuscation : un `-EncodedCommand` doit être
   * décodé pour tourner, et c'est la forme décodée qui atterrit ici.
   */
  recordPowerShellExecution(scriptBlock: string, output: string): void {
    const text = scriptBlock.trim();
    if (!text) return;
    if (isScriptBlockLoggingEnabled(this.registry)) {
      this.eventLog.writeEventLog(
        POWERSHELL_OPERATIONAL_LOG, POWERSHELL_PROVIDER, SCRIPT_BLOCK_LOGGED,
        'Information',
        `Creating Scriptblock text (1 of 1):\n${text}\n\n`
        + `ScriptBlock ID: ${scriptBlockId(text)}\nPath: `,
        {
          MessageNumber: '1', MessageTotal: '1',
          ScriptBlockText: text, ScriptBlockId: scriptBlockId(text), Path: '',
        });
    }
    if (isTranscriptionEnabled(this.registry)) this.appendTranscript(text, output);
  }

  /**
   * Ajoute une commande et sa sortie à la transcription en cours, en
   * créant le fichier — en-tête compris — à la première écriture.
   */
  private appendTranscript(command: string, output: string): void {
    const dir = transcriptDirectory(this.registry);
    if (!this.transcriptStartedAt) this.transcriptStartedAt = this.simulatedDate();
    const path = `${dir}\\${transcriptFileName(this.getHostname(), this.transcriptStartedAt)}`;
    const existing = this.fs.readFile(path);
    const head = existing.ok && existing.content !== undefined
      ? existing.content
      : transcriptHeader(
        this.getHostname(), this.userMgr.currentUser || 'Administrator',
        this.transcriptStartedAt);
    this.fs.mkdirp(dir);
    this.fs.createFile(path, `${head}PS> ${command}\n${output ? `${output}\n` : ''}`);
  }

  protected override linkLocalAutoconfigurationEnabled(): boolean {
    const values = this.registry.getItemPropertyValues(
      'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters');
    if (!values) return true;
    for (const [name, value] of Object.entries(values)) {
      if (name.toLowerCase() !== 'ipautoconfigurationenabled') continue;
      return String(value).trim() !== '0';
    }
    return true;
  }

  /**
   * `ProcessCreationIncludeCmdLine_Enabled` — la stratégie qui décide si
   * 4688 porte la ligne de commande. Elle existe parce qu'une ligne de
   * commande peut contenir un secret ; l'auditer est un choix, pas un
   * défaut, et c'est ce choix qui rend visible une obfuscation
   * `-EncodedCommand`.
   */
  isCommandLineAuditEnabled(): boolean {
    const values = this.registry.getItemPropertyValues(
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System\\Audit');
    if (!values) return false;
    for (const [name, value] of Object.entries(values)) {
      if (name.toLowerCase() !== 'processcreationincludecmdline_enabled') continue;
      return String(value).trim() !== '0' && String(value).trim() !== '';
    }
    return false;
  }

  syncLinkLocalResponders(): void {
    if (!this.getIsPoweredOn()) return;
    const llmnr = this.getLlmnrAgent();
    const mdns = this.getMdnsAgent();
    if (isLlmnrEnabled(this.registry)) llmnr.start(); else llmnr.stop();
    if (isMdnsEnabled(this.registry)) mdns.start(); else mdns.stop();
  }

  override powerOn(): void {
    super.powerOn();
    this.syncLinkLocalResponders();
    this.startScheduledTaskTicker();
  }

  override powerOff(): void {
    this._llmnrAgent?.stop();
    this._mdnsAgent?.stop();
    if (this.taskTimer !== null) {
      this.hostTimers.clear(this.taskTimer);
      this.taskTimer = null;
    }
    super.powerOff();
  }

  private taskTimer: symbol | null = null;

  /**
   * Le pendant de `startCronTicker` côté Linux, qui manquait.
   *
   * Le moteur existait — `fireDueScheduledTasks` relance vraiment le
   * programme et réarme la tâche — mais il n'était atteint que par
   * `advanceTime`, appelé nulle part hors des tests. Une tâche planifiée
   * ne partait donc jamais d'elle-même : c'était de la planification sans
   * horloge.
   *
   * La minute est la granularité du planificateur Windows comme de cron ;
   * elle borne aussi le nombre de réveils dans un lab qui tourne long.
   *
   * Le tour fait avancer `HostClock` d'autant, et c'est indispensable :
   * cette horloge ne bouge que sur `advance()`, si bien qu'un minuteur qui
   * se contenterait d'appeler `fireDueScheduledTasks` relirait éternellement
   * la même heure et ne trouverait jamais rien à faire. `simulatedDate()`
   * reste ainsi la seule heure de la machine — celle qui déclenche et celle
   * que `schtasks /query` affiche.
   */
  private startScheduledTaskTicker(): void {
    if (this.taskTimer !== null) return;
    this.taskTimer = this.hostTimers.setInterval(() => this.scheduledTaskTick(), TASK_TICK_MS);
  }

  /** Un tour d'horloge du planificateur. Exposé pour que les tests le
   *  battent sans attendre une minute, comme `cronTick` côté Linux. */
  scheduledTaskTick(): void {
    this.advanceTime(TASK_TICK_MS);
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
      () => this.isCommandLineAuditEnabled(),
    );
    this.eventLogProjection?.dispose();
    this.eventLog.attachBus(bus, this.id);
    this.eventLog.attachForwarder((logName, entry) => this.tryForwardMatchingEvent(logName, entry));
    this.eventLogProjection = new WindowsEventLogProjection(bus, this.eventLog, this.id, this.auditPolicy);
    this.servicePortProjection?.dispose();
    this.servicePortProjection = new WindowsServicePortProjection(bus, this.id, this.socketTable);
    this.portProxySocketProjection = new PortProxySocketProjection(bus, this.id, this.socketTable, this.getTcpStack());
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

  private initDefaultSockets(): void {
    // Les quatre `socketTable.bind()` qui ouvraient cette méthode sont
    // partis (docs/PRD-Sockets-Une-Seule-Verite.md §P2) : trois d'entre
    // eux doublaient un `listen()` situé quelques lignes plus bas, et
    // leur identité voyage désormais avec l'écoute elle-même. Le
    // quatrième, le 139, n'écoutait nulle part — il l'a maintenant.

    // Persist SSH server config + host key under C:\ProgramData\ssh\ on
    // first boot so OpenSSH-for-Windows files are visible from the shell.
    this.getSshServerContext();

    // TCP SSH server on port 22 — handles SSH auth + SFTP subsystem.
    this.getTcpStack().listen(22, {
      identity: { pid: 1088, processName: 'sshd.exe' },
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
    const serveSmb = (socket: TcpSocket): void => {
      if (this.svcMgr.getService('LanmanServer')?.state !== 'Running') {
        socket.close();
        return;
      }
      const clientHost = this.reverseLookupClient(socket.remoteIp);
      this.getSmbServerHandler().register(socket as unknown as TcpStream, socket.remoteIp, clientHost);
    };
    this.getTcpStack().listen(445, {
      identity: { pid: 4, processName: 'System' },
      onAccept: serveSmb,
    });

    // NetBIOS Session Service — le transport hérité du même LanmanServer,
    // que `ss`/`netstat` annonçaient depuis toujours sans que rien ne
    // réponde derrière (docs/PRD-Sockets-Une-Seule-Verite.md §P2). Il
    // sert le même SMB que le 445, et s'éteint avec le même service.
    // Ce que ce raccourci NE fait pas : le préambule NetBIOS
    // (session request/positive response, RFC 1002 §4.3) — aucune couche
    // NBSS n'existe ici, et un client qui l'attendrait n'existe pas non
    // plus. Un port joignable qui parle le bon protocole vaut mieux
    // qu'un port affiché qui ne parle rien.
    this.getTcpStack().listen(139, {
      identity: { pid: 4, processName: 'System' },
      onAccept: serveSmb,
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
        new KdcSessionHandler({
          store, deviceId: this.getHostname(), bus: this.getBus(),
          writeSecurityEvent: (eventId, entryType, message, data) =>
            this.eventLog.writeEventLog('Security', 'Microsoft-Windows-Security-Auditing', eventId, entryType, message, data),
        }).register(socket);
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
        const ownIp = this.getInterfaces().map(p => p.getIPAddress()).find((ip): ip is NonNullable<typeof ip> => ip !== null)?.toString();
        new ReplicationServerHandler(
          store, this.getHostname(), this.getBus(), ownIp,
          (partnerIp) => this.replicateFrom(partnerIp),
          () => this.getReplicationSignals().log.get(),
          () => this.ntdsOptions.has('DISABLE_OUTBOUND_REPL'),
          (sourceIp) => this.replicateFrom(sourceIp),
          (dn) => {
            try { return store.getTree().getByDn(parseDN(dn))?.replMeta ?? null; } catch { return null; }
          },
          (option, enabled) => {
            if (!NTDS_OPTION_NAMES.includes(option as NtdsOption)) return false;
            if (enabled) this.ntdsOptions.add(option as NtdsOption); else this.ntdsOptions.delete(option as NtdsOption);
            return true;
          },
        ).register(socket);
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
      identity: { pid: 1096, processName: 'svchost.exe' },
      onAccept: (socket) => {
        if (!this.rdp.enabled) { socket.close(); return; }
        new RdpServerHandler({
          tlsConfig: { serverCert: this.getRdpTlsCertificate()!, serverPrivateKey: this.rdpTlsIdentity!.privateKey },
          sessions: this.rdp.sessions,
          auth: {
            // logonType 10 (RemoteInteractive) — real Windows value for
            // RDP. publishOnSuccess=false, publishOnFailure=false:
            // reportLogon below is now the single publisher for every
            // RDP logon outcome, local or domain (domain auth via
            // tryDomainAuth never self-publishes at all) — the same fix
            // P1 made for SSH (PRD-Winlogon.md §2.1 P4).
            checkLocal: (u, p) => Boolean(this.userMgr.getUser(u)?.enabled) && this.userMgr.checkPassword(u, p, 10, false, false),
            checkDomain: (u, p) => Boolean(this.tryDomainAuth(u, p)?.ok),
          },
          // 4624/4625, logonType 10 — single source of truth for both
          // the local and domain auth path (domain auth never
          // published one on its own).
          reportLogon: (user, success) => {
            this.getBus().publish({
              topic: 'windows.account.logon',
              payload: { deviceId: this.id, account: user, success, logonType: 10 },
            });
          },
          // 4778 — reconnection to an existing Disconnected session.
          reportReconnect: (user) => {
            this.getBus().publish({
              topic: 'windows.session.reconnected',
              payload: { deviceId: this.id, account: user, logonType: 10 },
            });
          },
          // 4779 — transport dropped with no explicit logoff.
          reportDisconnect: (user) => {
            this.getBus().publish({
              topic: 'windows.session.disconnected',
              payload: { deviceId: this.id, account: user, logonType: 10 },
            });
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
    const result = pullReplication(this.getTcpStack(), partnerIp, store, {
      inboundReplDisabled: this.ntdsOptions.has('DISABLE_INBOUND_REPL'),
    });

    // Explicit site assignment (Move-ADDirectoryServer) takes precedence
    // over the subnet-derived guess for both ends, same precedence as
    // `resolveIpToSite`/`Get-ADDomainController` (forest/sites.ts header).
    const ownIp = this.getInterfaces().map(p => p.getIPAddress()).find((ip): ip is NonNullable<typeof ip> => ip !== null)?.toString();
    const ownSite = store.siteForDc(this.getHostname()) ?? (ownIp ? store.siteForIp(ownIp) : null);
    const partnerDcName = store.dcForIp(partnerIp);
    const partnerSite = (partnerDcName ? store.siteForDc(partnerDcName) : null) ?? store.siteForIp(partnerIp);
    const siteRelation: 'intra-site' | 'inter-site' =
      ownSite !== null && partnerSite !== null && ownSite !== partnerSite ? 'inter-site' : 'intra-site';
    const logEntry: ReplicationLogEntry = {
      timestamp: Math.floor(Date.now() / 1000), partnerAddress: partnerIp, applied: result.applied, ok: result.ok, siteRelation, direction: 'inbound',
      error: result.error, remoteInvocationId: result.responderInvocationId,
    };
    this.replicationLog.push(logEntry);
    this.getBus().publish(
      result.ok
        ? {
            topic: 'replication.pull.completed',
            payload: {
              deviceId: this.getHostname(), invocationId: store.getInvocationId(), partnerAddress: partnerIp,
              applied: result.applied, siteRelation, remoteInvocationId: result.responderInvocationId,
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
    return this.resolveAddressName(ip) ?? ip;
  }

  /**
   * Le nom d'une adresse, dans l'ordre du client Windows : fichier hosts,
   * puis cache du resolveur. C'est la moitie qui n'attend rien, donc la
   * seule qu'un appelant synchrone puisse lire ; `resolveAddressNameAsync`
   * y ajoute l'interrogation PTR. Une seule ecriture derriere les trois
   * appelants, sans quoi cette machine nommerait un poste ici et pas la.
   */
  private dnsCacheValue(qname: string, qtype: number): string | null {
    const hit = this.dnsCache.lookup(qname, qtype);
    if (hit.kind !== 'hit') return null;
    for (const rr of hit.records) {
      const legacy = resourceRecordToLegacyRecord(rr);
      if (legacy) return legacy.value;
    }
    return null;
  }

  resolveAddressName(ip: string): string | null {
    const fromHosts = this.readHostsFile().reverse(ip)?.canonicalName;
    if (fromHosts) return fromHosts;
    return this.dnsCacheValue(ptrQName(ip), RRType.PTR);
  }

  /** La meme question, avec le droit d'interroger un serveur DNS. */
  async resolveAddressNameAsync(ip: string): Promise<string | null> {
    const local = this.resolveAddressName(ip);
    if (local) return local;
    const arpa = ptrQName(ip);
    const seen = new Set<string>();
    for (const [ifName] of this.ports) {
      for (const server of this.effectiveDnsServers(ifName)) {
        if (seen.has(server)) continue;
        seen.add(server);
        let response;
        try { response = await this.queryDnsServer(new IPAddress(server), arpa, 'PTR'); }
        catch { continue; }
        const ptr = response?.answers.find((rr) => rr.data.type === RRType.PTR);
        if (ptr) {
          this.dnsCache.storePositive(response!.answers, arpa);
          return (ptr.data as PtrRecordData).ptrdname;
        }
      }
    }
    return null;
  }

  /** Build a fresh ISshServerContext bound to this machine's NTFS / users. */
  getSshServerContext(): WindowsSshServerContext {
    return new WindowsSshServerContext(this.fs, this.userMgr, this.hostname, {}, {
      executeCmdCommand: (line: string) => this.executeCmdCommand(line),
      getCwd: () => this.getCwd(),
      createVtyShell: (user: string) => this.createVtyShell(user),
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
    return new WinRmServerHandler({
      userMgr: this.userMgr,
      domainAuth: (u, p) => this.tryDomainAuth(u, p),
      wec: { receiveForwardedEvent: (subscriptionId, sourceMachine, event) => this.receiveForwardedEvent(subscriptionId, sourceMachine, event) },
    });
  }

  // ─── Domain join / logon (PRD-Windows-Server.md §5 P6) ──────────────

  getDomainMembership(): DomainMembership | null { return this.domainMembership; }
  getDomainSession(): DomainSession | null { return this.domainSession; }

  /**
   * `Add-Computer -DomainName`/`netdom join` — real LDAP `AddRequest`
   * dialogue against the DC at `dcAddress` (no DNS SRV discovery yet,
   * P7 dependency — callers resolve the DC address themselves).
   */
  joinDomainNow(
    domainName: string, dcAddress: string, credentialUser: string, credentialPassword: string,
    opts: { ouPath?: string; newName?: string } = {},
  ): DomainJoinResult {
    if (this.domainMembership) {
      return { ok: false, message: `The computer '${this.getHostname()}' is already joined to a domain.` };
    }
    const computerName = opts.newName || this.getHostname();
    const result = joinDomain({
      tcpStack: this.getTcpStack(),
      computerName,
      domainName,
      dcAddress,
      credentialUser,
      credentialPassword,
      ouPath: opts.ouPath,
    });
    if (result.ok && result.membership) {
      this.domainMembership = result.membership;
      if (opts.newName) this.setHostname(opts.newName);
    }
    return result;
  }

  markServiceAccountInstalled(sam: string): void { this.installedServiceAccounts.add(sam.toLowerCase()); }
  hasServiceAccountInstalled(sam: string): boolean { return this.installedServiceAccounts.has(sam.toLowerCase()); }

  /**
   * `Test-ComputerSecureChannel`/`netdom verify` (docs/PRD-Netdom.md §2.1
   * P1) — a real LDAP bind against this machine's own DC using its
   * computer-account credentials (`<hostname>$` / the machine secret
   * recorded at join time). `false` both when never joined and when the
   * bind genuinely fails (DC unreachable or the secret is out of sync),
   * matching real Windows' single boolean result.
   */
  testSecureChannel(): boolean {
    if (!this.domainMembership) return false;
    const conn = dialLdap(this.getTcpStack(), this.domainMembership.dcAddress);
    if (!conn.ok || !conn.client) return false;
    const bind = conn.client.bind(`${this.getHostname()}$`, this.domainMembership.machineSecret);
    conn.client.unbind();
    return bind.ok;
  }

  /**
   * `netdom reset`/`netdom resetpwd` (docs/PRD-Netdom.md §2.1 P2/P3) —
   * generates a fresh machine secret and pushes it to the DC via a real
   * LDAP `ModifyRequest` (`ComputerSecureChannelClient`, § 1.3
   * grounding), then updates `domainMembership` in place so a
   * subsequent `testSecureChannel()`/`netdom verify` reflects the new
   * secret immediately — both sides change together, or neither does.
   */
  resetSecureChannel(credentialUser: string, credentialPassword: string, dcAddressOverride?: string): { ok: boolean; message: string } {
    if (!this.domainMembership) return { ok: false, message: 'The computer is not joined to a domain.' };
    const newSecret = randomSessionKey();
    const result = resetComputerSecretOverWire(
      this.getTcpStack(), dcAddressOverride || this.domainMembership.dcAddress, this.domainMembership.dnsName,
      this.getHostname(), newSecret, credentialUser, credentialPassword,
    );
    if (!result.ok) return result;
    this.domainMembership = { ...this.domainMembership, machineSecret: newSecret };
    return { ok: true, message: '' };
  }

  /**
   * `netdom remove` (docs/PRD-Netdom.md §2.1 P4) — deletes this
   * machine's computer account on the DC via a real LDAP `DelRequest`
   * (real AD deletes the object outright, it doesn't just disable it),
   * then clears `domainMembership` so the machine is back in a
   * workgroup, symmetric with `joinDomainNow()`.
   */
  removeFromDomain(credentialUser: string, credentialPassword: string): { ok: boolean; message: string } {
    if (!this.domainMembership) return { ok: false, message: 'The computer is not joined to a domain.' };
    const result = removeComputerAccountOverWire(
      this.getTcpStack(), this.domainMembership.dcAddress, this.domainMembership.dnsName,
      this.getHostname(), credentialUser, credentialPassword,
    );
    if (!result.ok) return result;
    this.domainMembership = null;
    this.domainSession = null;
    return { ok: true, message: '' };
  }

  /**
   * `Rename-Computer`/`netdom renamecomputer`/`netdom computername
   * /MakePrimary` (docs/PRD-Netdom.md §2.1 P5/P6) — renames this
   * machine both locally (`setHostname()`, existing) and on the DC's AD
   * computer object (`sAMAccountName`/`servicePrincipalName`/
   * `dNSHostName`, via a real LDAP `ModifyDNRequest`+`ModifyRequest`,
   * § 1.3 grounding) — unlike the join-time `-NewName` rename, this is
   * the first path that updates the AD side of an ALREADY-joined
   * machine's name. On a workgroup machine (not domain-joined), only
   * the local rename happens — no AD object to update.
   */
  renameComputer(newName: string, credential?: { username: string; password: string }): { ok: boolean; message: string } {
    if (!this.domainMembership) {
      this.setHostname(newName);
      return { ok: true, message: '' };
    }
    if (!credential) {
      return { ok: false, message: 'Cannot process command because of one or more missing mandatory parameters: Credential.' };
    }
    const oldName = this.getHostname();
    const result = renameComputerAccountOverWire(
      this.getTcpStack(), this.domainMembership.dcAddress, this.domainMembership.dnsName,
      oldName, newName, credential.username, credential.password,
    );
    if (!result.ok) return result;
    this.setHostname(newName);
    return { ok: true, message: '' };
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
   * Domain-then-local credential resolution (PRD-Winlogon.md §1.3) —
   * the same order `WindowsTerminalSession.verifyRemoteCredentials`
   * already uses for SSH/RDP: `tryDomainAuth` first (only meaningful
   * for a domain-qualified name on a joined machine), `checkPassword`
   * local as the fallback. Shared by that method and by
   * `unlockWorkstation` so the two never drift apart.
   */
  resolveLocalOrDomainCredentials(user: string, password: string, logonType = 2, publishOnSuccess = true): { ok: boolean; sam: string } {
    const domainResult = this.tryDomainAuth(user, password);
    if (domainResult !== null) return { ok: domainResult.ok, sam: domainResult.sam };
    const ok = this.userMgr.checkPassword(user, password, logonType, publishOnSuccess);
    return { ok, sam: user };
  }

  isLocked(): boolean { return this.locked; }

  /**
   * SAS-equivalent lock (PRD-Winlogon.md §2.1 P2/P3) — `rundll32
   * user32.dll,LockWorkStation`, the `lock` console convenience, or a
   * password-protected screensaver (`origin: 'screensaver'`) all funnel
   * here. Idempotent: locking an already-locked workstation is a no-op,
   * matching real Winlogon (no second 4800 for a redundant lock).
   */
  lockWorkstation(origin: 'user' | 'screensaver' = 'user'): void {
    if (this.locked) return;
    this.locked = true;
    this.lockedBy = this.getCurrentUser();
    this.lockOrigin = origin;
    this.getBus().publish({
      topic: 'windows.workstation.locked',
      payload: { deviceId: this.id, account: this.lockedBy, origin },
    });
  }

  /**
   * Real credential check to leave the locked state — no scripted
   * success. A wrong password leaves `locked` true and generates a 4625
   * (via `checkPassword`'s own publish, logonType 7 = Unlock) exactly
   * like any other failed authentication.
   */
  unlockWorkstation(user: string, password: string): { ok: boolean; message: string } {
    if (!this.locked) return { ok: true, message: '' };
    // logonType 7 (Unlock); publishOnSuccess=false — a successful
    // unlock resumes the already-open session (4801 covers it), it
    // does not open a fresh one (PRD-Winlogon.md §2.1 P2). A wrong
    // password still publishes its own 4625 from inside checkPassword.
    const result = this.resolveLocalOrDomainCredentials(user, password, 7, false);
    if (!result.ok) {
      return { ok: false, message: 'The user name or password is incorrect.' };
    }
    const origin = this.lockOrigin ?? 'user';
    this.locked = false;
    this.lockedBy = null;
    this.lockOrigin = null;
    this.getBus().publish({
      topic: 'windows.workstation.unlocked',
      payload: { deviceId: this.id, account: result.sam, origin },
    });
    return { ok: true, message: '' };
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

  /**
   * `Send-MailMessage` — a real outbound SMTP client transaction against
   * `-SmtpServer:-Port` (this machine's own `TcpStack`, real DNS
   * resolution, the same `SmtpClientSession` used by `relay.ts`/the
   * Exchange transport pipeline, docs/PRD-SMTP.md §0.2 — no second SMTP
   * engine). `-UseSsl` really attempts `STARTTLS`; since this device has
   * no trusted-root store wired yet for outbound clients (unlike
   * `LinuxMachine.trustedCAs`), a self-signed/AD-CS-issued peer
   * certificate won't validate and the send genuinely fails closed —
   * an honest limitation, not a shortcut that pretends success.
   */
  sendMailMessage(opts: {
    from: string; to: readonly string[]; cc?: readonly string[]; bcc?: readonly string[];
    subject: string; body: string; smtpServer: string; port?: number;
    useSsl?: boolean; credential?: { username: string; password: string };
  }): { ok: boolean; error?: string } {
    const ips = this.resolveDnsSync(opts.smtpServer);
    const targetIp = ips[0] ?? IPAddress.tryParse(opts.smtpServer)?.toString();
    if (!targetIp) return { ok: false, error: `Send-MailMessage : Unable to resolve the SMTP server '${opts.smtpServer}'.` };
    const iface = this.getInterfaces().find(p => p.getIPAddress() !== null);
    if (!iface) return { ok: false, error: 'Send-MailMessage : No network interface with an IP address is available.' };
    const localIp = iface.getIPAddress()!.toString();
    const port = opts.port ?? 25;

    const tlsConfig = opts.useSsl ? { verifier: new CertificateVerifier({ trustAnchors: [] }) } : undefined;
    const session = new SmtpClientSession(this.getTcpStack(), targetIp, localIp, port, tlsConfig);
    const banner = session.connect();
    if (!banner || banner.code !== 220) {
      return { ok: false, error: `Send-MailMessage : Unable to connect to the remote server ('${opts.smtpServer}:${port}').` };
    }
    session.sendCommand({ verb: 'EHLO', argument: this.getHostname() });

    if (opts.useSsl) {
      session.startTls();
      if (!session.isTlsActive()) {
        session.close();
        return { ok: false, error: `Send-MailMessage : The SMTP server '${opts.smtpServer}' does not support (or this client does not trust) a secure connection.` };
      }
      session.sendCommand({ verb: 'EHLO', argument: this.getHostname() });
    }

    if (opts.credential) {
      const auth = session.authPlain(opts.credential.username, opts.credential.password);
      if (!auth || auth.code !== 235) {
        session.close();
        return { ok: false, error: 'Send-MailMessage : Mailbox unavailable. The server response was: authentication failed.' };
      }
    }

    const mail = session.sendCommand({ verb: 'MAIL', argument: `FROM:<${opts.from}>` });
    if (!mail || mail.code >= 400) {
      session.close();
      return { ok: false, error: `Send-MailMessage : ${mail?.lines.join(' ') ?? 'The MAIL FROM command was rejected.'}` };
    }
    const to = opts.to;
    const cc = opts.cc ?? [];
    const bcc = opts.bcc ?? [];
    for (const recipient of [...to, ...cc, ...bcc]) {
      const rcpt = session.sendCommand({ verb: 'RCPT', argument: `TO:<${recipient}>` });
      if (!rcpt || rcpt.code >= 400) {
        session.close();
        return { ok: false, error: `Send-MailMessage : ${rcpt?.lines.join(' ') ?? `The recipient '${recipient}' was rejected.`}` };
      }
    }
    const dataReply = session.sendCommand({ verb: 'DATA' });
    if (!dataReply || dataReply.code !== 354) {
      session.close();
      return { ok: false, error: 'Send-MailMessage : The server refused to accept the message body.' };
    }
    const headerLines = [
      `From: ${opts.from}`,
      `To: ${to.join(', ')}`,
      ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []),
      `Subject: ${opts.subject}`,
      `Date: ${this.simulatedDate().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
    ];
    const rawMessage = `${headerLines.join('\r\n')}\r\n\r\n${opts.body}`;
    const final = session.sendDataBody(rawMessage);
    session.close();
    if (final && final.code >= 200 && final.code < 300) return { ok: true };
    return { ok: false, error: `Send-MailMessage : ${final?.lines.join(' ') ?? 'The message was rejected by the server.'}` };
  }

  // ─── Group Policy (PRD-Windows-Server.md §5 P10) ────────────────────

  private gpoAppliedNames: string[] = [];
  private gpoLastAppliedAt: Date | null = null;
  private gpoLogonBanner: { title: string; text: string } | null = null;

  // ─── Workstation lock (PRD-Winlogon.md §2.1 P2/P3) ──────────────────
  private locked = false;
  private lockedBy: string | null = null;
  private lockOrigin: 'user' | 'screensaver' | null = null;
  private gpoStartupScript: string | null = null;

  /** Set only while a `runas`-wrapped command runs (PRD-Winlogon.md §2.1 P5) — see `runasHost()`. */
  private pendingElevation: 'full' | null = null;

  /**
   * What TokenElevationType a process `start`ed right now should carry
   * (PRD-Winlogon.md §2.1 P5 — the %%1938 case). A real `runas`
   * elevation always wins; otherwise, an Administrators-group member is
   * running *without* having elevated — the actual UAC filtered-token
   * case, previously unmodeled entirely. The built-in `Administrator`/
   * `SYSTEM` accounts are UAC-exempt in real Windows (no split token to
   * filter), so they're excluded here and fall through to
   * `processCreated`'s own name-based heuristic instead, which already
   * resolves them to %%1937 — this method returning `undefined` for
   * them is what preserves that existing behavior unchanged.
   */
  private resolveElevationForCurrentUser(): 'full' | 'default' | 'limited' | undefined {
    if (this.pendingElevation) return this.pendingElevation;
    const current = this.userMgr.currentUser;
    const leaf = current.slice(current.indexOf('\\') + 1).toLowerCase();
    if (leaf === 'administrator' || leaf === 'system') return undefined;
    return this.userMgr.isCurrentUserAdmin() ? 'limited' : undefined;
  }

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
    const localStore = this.getDirectoryStore();
    if (!this.domainMembership && !localStore) {
      return { ok: false, message: 'gpupdate : This computer is not joined to a domain.' };
    }
    // A domain user (not a local/built-in account) currently logged on —
    // real gpupdate resolves User Configuration policy (folder redirection,
    // HKCU registry policy, …) against THIS object's own OU, independently
    // of where the computer object sits (PRD AD roaming-profiles gap).
    const currentUser = this.userMgr.currentUser;
    const userSam = currentUser.includes('\\') ? currentUser.split('\\').pop() : currentUser;
    let appliedGpoNames: string[];
    let settings: GpoSettings;
    if (localStore) {
      const rsop = localStore.resultantSetOfPolicy(this.getHostname(), userSam);
      appliedGpoNames = rsop.appliedGpoNames;
      settings = rsop.settings;
    } else {
      const result = pullGroupPolicy(this.getTcpStack(), this.domainMembership, this.getHostname(), userSam);
      if (!result.ok) return { ok: false, message: `gpupdate : ${result.message}` };
      appliedGpoNames = result.appliedGpoNames;
      settings = result.settings;
    }
    if (settings.accountPolicy) this.accountsPolicy.applyGpoOverrides(settings.accountPolicy);
    if (settings.logonBanner !== undefined) this.gpoLogonBanner = settings.logonBanner;
    if (settings.startupScript !== undefined) this.gpoStartupScript = settings.startupScript;
    if (settings.auditPolicy !== undefined) {
      for (const [subcategory, setting] of Object.entries(settings.auditPolicy)) {
        this.auditPolicy.set(subcategory, setting);
      }
    }
    if (settings.registryPolicy !== undefined) {
      for (const entry of settings.registryPolicy) {
        const type = (['String', 'DWord', 'QWord', 'ExpandString', 'MultiString', 'Binary'] as const).includes(entry.type as never)
          ? entry.type as RegistryValue['type'] : 'String';
        const value = type === 'DWord' || type === 'QWord' ? Number(entry.value) : entry.value;
        this.registry.applyGpoRegistryValue(entry.key, entry.valueName, value, type);
      }
    }
    this.gpoAppliedNames = appliedGpoNames;
    this.gpoLastAppliedAt = new Date();
    return { ok: true, message: '' };
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
      sourceDevice: this,
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
      sourceDevice: this,
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

  /**
   * `telnet host [port]` — real TCP/23 handshake via `tcpConnect`, then
   * the socket is closed immediately. No nested interactive session is
   * pushed the way `cmdSsh` does (see the Telnet note in CLAUDE.md's
   * Terminal emulation section).
   */
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
    const nics: NetworkAdapter[] = [];
    for (let i = 0; i < 4; i++) {
      const port = new Port(`eth${i}`, 'ethernet');
      this.addPort(port);
      nics.push(new NetworkAdapter({
        name: `eth${i}`,
        macAddress: port.getMAC().toString(),
        speedMbps: port.getNegotiatedSpeed(),
      }));
    }
    this.hardware.adapters = nics;
  }

  adapterAlias(portName: string): string {
    return this.getPort(portName)?.getAlias() ?? toDisplayName(portName);
  }

  setAdapterAlias(portName: string, alias: string): void {
    this.getPort(portName)?.setAlias(alias);
  }

  interfaceDescriptionOf(portName: string): string {
    const model = this.driverModelOf(portName);
    const ordinal = this.getPorts()
      .filter(p => this.driverModelOf(p.getName()) === model)
      .findIndex(p => p.getName() === portName) + 1;
    return windowsInterfaceDescription(model, ordinal);
  }

  private driverModelOf(portName: string): string {
    const port = this.getPort(portName);
    if (port === undefined || port.isCarrierless()) return MULTIPLEXOR_DRIVER;
    return this.hardware.adapters.find(a => a.name === portName)?.model ?? MULTIPLEXOR_DRIVER;
  }

  protected logonDomainNames(): { netbios: string; dns: string } | null {
    const m = this.domainMembership;
    if (!this.domainSession || !m) return null;
    return { netbios: m.netbiosName, dns: m.dnsName };
  }

  wellKnownEnv(): Map<string, string> {
    const u = this.userMgr.currentUser || 'User';
    const host = this.hostname;
    const domain = this.logonDomainNames();
    const out = new Map<string, string>([
      ['ALLUSERSPROFILE', 'C:\\ProgramData'],
      ['APPDATA', `C:\\Users\\${u}\\AppData\\Roaming`],
      ['COMPUTERNAME', host],
      ['COMSPEC', 'C:\\Windows\\System32\\cmd.exe'],
      ['HOMEDRIVE', 'C:'],
      ['HOMEPATH', `\\Users\\${u}`],
      ['LOCALAPPDATA', `C:\\Users\\${u}\\AppData\\Local`],
      ['LOGONSERVER', `\\\\${host}`],
      ['NUMBER_OF_PROCESSORS', '4'],
      ['OS', 'Windows_NT'],
      ['PATH', 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem;C:\\Windows\\System32\\WindowsPowerShell\\v1.0'],
      ['PATHEXT', '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PS1'],
      ['PROCESSOR_ARCHITECTURE', 'AMD64'],
      ['PROGRAMDATA', 'C:\\ProgramData'],
      ['PROGRAMFILES', 'C:\\Program Files'],
      ['PROGRAMFILES(X86)', 'C:\\Program Files (x86)'],
      ['PSMODULEPATH', `C:\\Users\\${u}\\Documents\\WindowsPowerShell\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules`],
      ['PUBLIC', 'C:\\Users\\Public'],
      ['SESSIONNAME', 'Console'],
      ['SYSTEMDRIVE', 'C:'],
      ['SYSTEMROOT', 'C:\\Windows'],
      ['TEMP', `C:\\Users\\${u}\\AppData\\Local\\Temp`],
      ['TMP', `C:\\Users\\${u}\\AppData\\Local\\Temp`],
      ['USERDOMAIN', domain ? domain.netbios : host],
      ['USERNAME', u],
      ['USERPROFILE', `C:\\Users\\${u}`],
      ['WINDIR', 'C:\\Windows'],
    ]);
    if (domain) {
      out.set('USERDNSDOMAIN', domain.dns.toUpperCase());
      out.set('USERDOMAIN_ROAMINGPROFILE', domain.netbios);
    }
    return out;
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
    const [dnsIp] = this.resolveDnsSync(name);
    if (dnsIp) {
      try { return new IPAddress(dnsIp); } catch { return null; }
    }
    return null;
  }

  /**
   * Le nom relève-t-il de mDNS et de lui seul ?
   *
   * `.local` ne part jamais vers un serveur DNS unicast (RFC 6762 §3),
   * et Windows respecte cette règle depuis la version 1703. Envoyer un
   * `.local` au DNS reviendrait à demander à un serveur de trancher sur
   * un espace de noms qui appartient au lien.
   */
  private isMdnsName(name: string): boolean {
    const lower = name.toLowerCase().replace(/\.$/, '');
    return lower.endsWith('.local') && lower.split('.').length === 2;
  }

  /** Un nom sans point : le domaine de LLMNR (RFC 4795 §2.1). */
  private isLlmnrName(name: string): boolean {
    const lower = name.toLowerCase().replace(/\.$/, '');
    return lower !== '' && !lower.includes('.');
  }

  /**
   * Le dernier recours du client DNS Windows : les deux protocoles de
   * lien. `.local` va à mDNS, un nom mono-label à LLMNR — jamais
   * l'inverse. Chacun n'est consulté que si la stratégie du registre le
   * laisse actif ; c'est la même porte que celle qui décide de tenir le
   * port, donc `EnableMulticast /d 0` ferme la résolution en même temps
   * que le répondeur.
   */
  private resolveLinkLocalSync(name: string): string[] {
    if (this.isMdnsName(name)) {
      return isMdnsEnabled(this.registry) ? this.getMdnsAgent().resolveSync(name) : [];
    }
    if (this.isLlmnrName(name)) {
      return isLlmnrEnabled(this.registry) ? this.getLlmnrAgent().resolveSync(name) : [];
    }
    return [];
  }

  private async resolveLinkLocal(name: string): Promise<string[]> {
    if (this.isMdnsName(name)) {
      return isMdnsEnabled(this.registry) ? this.getMdnsAgent().resolve(name) : [];
    }
    if (this.isLlmnrName(name)) {
      return isLlmnrEnabled(this.registry) ? this.getLlmnrAgent().resolve(name) : [];
    }
    return [];
  }

  /**
   * Une réponse de lien entre dans le cache du client DNS, avec son TTL.
   * Sans cela `ipconfig /displaydns` et `Get-DnsClientCache` ne
   * verraient jamais un nom que `ping` vient pourtant de résoudre — deux
   * commandes du même système se contrediraient.
   */
  private cacheLinkLocalAnswer(name: string, addresses: readonly string[]): void {
    if (addresses.length === 0) return;
    const ttl = this.isMdnsName(name) ? MDNS_RECORD_TTL : LLMNR_RECORD_TTL;
    this.dnsCache.storePositive(addresses.map((ip) => ({
      name, ttl, rrClass: 1, data: { type: RRType.A, address: new IPAddress(ip) },
    })), name);
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
      const cached = this.dnsCacheValue(qname, RRType.A);
      if (cached) {
        try { return new IPAddress(cached); } catch { void 0; }
      }
    }
    if (!this.isMdnsName(name)) {
      for (const { server, qname } of this.dnsResolutionAttempts(name)) {
        const response = await this.queryDnsServer(server, qname, 'A');
        const aRecords = response?.answers.filter((rr) => rr.data.type === RRType.A) ?? [];
        if (aRecords.length > 0) {
          this.dnsCache.storePositive(response!.answers, qname);
          return (aRecords[0].data as ARecordData).address;
        }
      }
    }

    // 5. Le lien, quand le DNS n'a rien su dire.
    const linkLocal = await this.resolveLinkLocal(name);
    if (linkLocal.length > 0) {
      this.cacheLinkLocalAnswer(name, linkLocal);
      try { return new IPAddress(linkLocal[0]); } catch { return null; }
    }
    return null;
  }

  /**
   * L'ordre du client DNS Windows, avec les restrictions que
   * `Resolve-DnsName` sait poser : fichier hosts, cache, serveurs DNS,
   * puis le lien. Chaque commutateur retire une étape — c'est ainsi que
   * l'opérateur découvre *qui* a répondu, puisque la cmdlet ne le dit
   * pas d'elle-même.
   */
  resolveDnsSync(name: string, options: DnsClientQueryOptions = {}): string[] {
    const linkOnly = options.llmnrOnly === true;
    if (!options.noHostsFile && !linkOnly) {
      const hostsIp = this.readHostsFile().resolve(name, 4);
      if (hostsIp) return [hostsIp];
    }
    if (!linkOnly) {
      for (const qname of this.dnsSearchCandidates(name)) {
        const cached = this.dnsCacheValue(qname, RRType.A);
        if (cached) return [cached];
      }
    }
    if (options.cacheOnly) return [];
    if (!this.isMdnsName(name) && !linkOnly) {
      for (const { server, qname } of this.dnsResolutionAttempts(name)) {
        const response = this.queryDnsServerSync(server, qname, 'A');
        const aRecords = response?.answers.filter((rr) => rr.data.type === RRType.A) ?? [];
        if (aRecords.length > 0) {
          this.dnsCache.storePositive(response!.answers, qname);
          return aRecords.map((rr) => (rr.data as ARecordData).address.toString());
        }
      }
    }
    if (options.dnsOnly) return [];
    const linkLocal = this.resolveLinkLocalSync(name);
    if (linkLocal.length > 0) this.cacheLinkLocalAnswer(name, linkLocal);
    return linkLocal;
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

  /** CrashOnAuditFail (PRD-Auditpol.md §2.1 P10): once enabled, a full Security log with DoNotOverwrite retention halts every non-administrative command until an admin clears the log or disables the option. */
  private isAuditFailBlocked(): boolean {
    return this.auditPolicy.getOption('CrashOnAuditFail') === true && this.eventLog.isFullAndProtected('Security');
  }

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

    // Workstation lock (PRD-Winlogon.md §2.1 P2/P3), checked before
    // anything else — mirrors CrashOnAuditFail's gate just below.
    // `unlock <user> <password>` is the one command that still runs
    // while locked. Real Windows shows a graphical lock screen instead
    // of a command prompt at all; this simulator is command-line-only,
    // so a literal `unlock` command is the deliberate, documented
    // substitute for typing into a masked password field — the
    // password does appear in command echo/history as a result, a
    // known and bounded simplification (§2.2 of the PRD).
    const unlockMatch = /^unlock\s+(\S+)\s+(.+)$/i.exec(trimmed);
    if (unlockMatch) {
      const [, unlockUser, unlockPassword] = unlockMatch;
      return this.unlockWorkstation(unlockUser, unlockPassword).message
        || 'The workstation was unlocked successfully.';
    }
    if (this.locked) {
      const banner = this.gpoLogonBanner
        ? `${this.gpoLogonBanner.title}\n\n${this.gpoLogonBanner.text}\n\n`
        : '';
      return `${banner}This computer is locked.\nOnly ${this.lockedBy} or an administrator can unlock this computer.\nType UNLOCK <username> <password> to continue.`;
    }
    if (/^rundll32(?:\.exe)?\s+user32\.dll\s*,\s*LockWorkStation\s*$/i.test(trimmed) || /^lock$/i.test(trimmed)) {
      this.lockWorkstation('user');
      return '';
    }

    if (this.isAuditFailBlocked() && !this.userMgr.isCurrentUserAdmin()) {
      return 'STOP: C0000244 {Audit Failed}\nAn attempt to generate a security audit failed.\nAn administrator must clear the Security event log or disable CrashOnAuditFail to continue.';
    }

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

    // Handle piped commands (but not inside redirects). A `|` inside double
    // quotes is a literal, exactly as in real cmd.exe — `splitCmdChain`
    // above already tracks quoting for `||`, and reading this one blind
    // made `curl -w "%{http_code}|%{size_download}" URL` look like a
    // pipeline whose right-hand side was a format string.
    if (WindowsPC.hasUnquotedPipe(trimmed) && !trimmed.match(/[>]/)) {
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

    // UNC (`\\srv\share\...`) / net-use-mapped-drive access for dir/copy/type
    // (PRD-Windows-Server.md §5 P3) — real SMB traffic, not the local VFS.
    if (cmd === 'dir' || cmd === 'copy' || cmd === 'type') {
      const uncResult = await this.tryUncFileCommand(cmd, args);
      if (uncResult !== null) return uncResult;
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
        { serviceManager: this.svcMgr, processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin(), currentUser: this.userMgr.currentUser }, args);
      case 'auditpol':
      case 'auditpol.exe': return cmdAuditpol(this.auditPolicy, args, this.userMgr.isCurrentUserAdmin(), {
        resolvePath: (p) => fileCtx.fs.normalizePath(p, fileCtx.cwd),
        readFile: (p) => { const r = fileCtx.fs.readFile(p); return r.ok ? (r.content ?? '') : null; },
        writeFile: (p, c) => fileCtx.fs.createFile(p, c).ok,
      }, fileCtx.hostname);
      case 'winrm':   return cmdWinrm(this.winrm, args);
      case 'netstat': return cmdNetstat(fileCtx, args, this.socketTable, this.buildNetContext());
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
      case 'powershell.exe':
      case 'pwsh':
      case 'pwsh.exe':
        return runPowerShellShim({
          executeCmdCommand: (l) => this.executeCmdCommand(l),
          shimState: this.psShimState,
          runFullPs: (code) => {
            try {
              return this.getPowerShellInterpreter().execute(code);
            } catch (e) {
              if (e instanceof PSRuntimeError) return e.message;
              throw e;
            }
          },
        }, args, splitCmdArgs(expanded, true).slice(1));
      case 'ver':     return WindowsPC.VER_STRING;
      case 'hostname': return this.hostname;
      case 'systeminfo': return this.cmdSysteminfo();
      case 'whoami':  return cmdWhoami({ hostname: this.hostname, logonDomain: this.getEnvVars().get('USERDOMAIN'), userManager: this.userMgr, domainSession: this.domainSession }, args);
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
      case 'lpr':      return cmdLpr({ hostname: this.getHostname(), owner: this.userMgr.currentUser, fs: this.getFileSystem(), tcpStack: this.getTcpStack() }, args);
      case 'slmgr':
      case 'slmgr.vbs':
        return cmdSlmgr({
          productName: this.getDeviceType() === 'windows-server' ? WINDOWS_SERVER_PRODUCT_IDENTITY.productName : WINDOWS_CLIENT_PRODUCT_IDENTITY.productName,
          licensing: this.licensing,
        }, args);
      case 'nbtstat': return this.cmdNbtstat(args);
      case 'w32tm':   return this.cmdW32tm(args);
      case 'wmic':    return this.cmdWmic(args);
      case 'reg':     return this.cmdReg(args);
      case 'nltest':  return cmdNltest({
        domainMembership: this.domainMembership,
        probeDc: (address) => this.probeTcpReachable(address, 389),
      }, args);
      case 'dcdiag': {
        const store = this.getDirectoryStore();
        return cmdDcdiag({
          hostname: this.hostname,
          dnsName: store?.dnsName ?? '',
          isDc: store !== null,
          servicesRunning: {
            ntds: this.svcMgr.getService('NTDS')?.state === 'Running',
            netlogon: this.svcMgr.getService('Netlogon')?.state === 'Running',
            kdc: this.svcMgr.getService('Kdc')?.state === 'Running',
          },
          sysvolShareExists: this.smbShares.get('SYSVOL') !== undefined,
          replicationHealthy: this.getReplicationSignals().log.get().every(e => e.ok),
        });
      }
      case 'repadmin': {
        const store = this.getDirectoryStore();
        if (!store) return "'repadmin' requires this computer to be a domain controller.";
        const resolveNameToIp = (name: string): string | null => this.resolveHostnameSync(name)?.toString() ?? null;
        const ctx: RepadminContext = {
          hostname: this.hostname,
          fqdn: `${this.hostname}.${store.dnsName}`,
          domainDn: store.getDomainDn(),
          invocationId: store.getInvocationId(),
          log: this.getReplicationSignals().log.get(),
          outboundVector: encodeHighWatermarkVector(store.getOutboundHighWatermark()),
          knownDcFqdns: store.listDomainControllers()
            .filter(c => c.name.toLowerCase() !== this.hostname.toLowerCase())
            .map(c => `${c.name}.${store.dnsName}`),
          // `dcForIp` (recorded at site-assignment time) is tried before
          // the hosts-file reverse lookup — DNS isn't replicated between
          // DCs here, so a partner's name is otherwise unresolvable
          // unless a hosts entry happens to exist (forest/sites.ts header).
          resolveIpToName: (ip) => store.dcForIp(ip) ?? this.reverseLookupClient(ip),
          // A DC's explicit site assignment (Move-ADDirectoryServer) takes
          // precedence over the subnet-derived guess — matching real AD's
          // own reason that cmdlet exists (forest/sites.ts header).
          // `dcForIp` looks the partner up by its recorded address rather
          // than DNS (unreliable cross-DC here — same header).
          resolveIpToSite: (ip) => {
            const dcName = store.dcForIp(ip);
            const explicit = dcName ? store.siteForDc(dcName) : null;
            return explicit ?? store.siteForIp(ip);
          },
          pullFrom: (ip) => this.replicateFrom(ip),
          pushTo: (ip) => notifySyncNow(this.getTcpStack(), ip),
          resolveNameToIp,
          usnForInvocation: (invocationId) => store.highestKnownUsnFor(invocationId),
          getObjectReplMeta: (dn) => {
            try {
              const entry = store.getTree().getByDn(parseDN(dn));
              return entry?.replMeta ?? null;
            } catch { return null; }
          },
          options: this.ntdsOptions,
          setOption: (opt, enabled) => { if (enabled) this.ntdsOptions.add(opt); else this.ntdsOptions.delete(opt); },
          setRemoteOption: (targetIp, opt, enabled) => setRemoteOption(this.getTcpStack(), targetIp, opt, enabled),
          triggerRemoteReplicate: (destIp, sourceIp) => triggerRemotePull(this.getTcpStack(), destIp, sourceIp),
          resolveTarget: (name, objectDn) => {
            const isSelf = name.toLowerCase() === ctx.fqdn.toLowerCase() || name.toLowerCase() === this.hostname.toLowerCase();
            if (isSelf) {
              return {
                ok: true, fqdn: ctx.fqdn, hostname: this.hostname, invocationId: store.getInvocationId(),
                log: this.getReplicationSignals().log.get(), outboundVector: encodeHighWatermarkVector(store.getOutboundHighWatermark()),
                objectMeta: objectDn !== undefined ? ctx.getObjectReplMeta(objectDn) : undefined,
              };
            }
            const targetIp = resolveNameToIp(name);
            if (!targetIp) return { ok: false, error: `Unable to contact target: ${name}`, fqdn: '', hostname: '', invocationId: '', log: [], outboundVector: [] };
            const start = Date.now();
            const remote = queryRemoteReplicationStatus(this.getTcpStack(), targetIp, objectDn);
            const latencyMs = Date.now() - start;
            if (!remote) return { ok: false, error: `Unable to contact target: ${name}`, fqdn: '', hostname: '', invocationId: '', log: [], outboundVector: [] };
            return {
              ok: true, fqdn: remote.fqdn, hostname: remote.fqdn.split('.')[0], invocationId: remote.invocationId,
              log: remote.log, outboundVector: remote.outboundVector, latencyMs, objectMeta: remote.objectMeta,
            };
          },
        };
        return cmdRepadmin(ctx, args);
      }
      case 'klist':   return cmdKlist({ ticketCache: this.kerberosTicketCache });
      case 'netdom':  return this.cmdNetdom(args);
      case 'wecutil': return this.cmdWecutil(args);
      case 'dnscmd':  return cmdDnscmd({ dns: this.getDnsServerRole() }, args);
      case 'certreq': return cmdCertreq({ adcs: this.getAdcsRole(), certStore: this.certStore }, args);
      case 'certutil': return cmdCertutil({ adcs: this.getAdcsRole(), certStore: this.certStore }, args);
      case 'query': {
        if ((args[0] ?? '').toLowerCase() === 'session') return cmdQuerySession({ sessions: this.rdp.sessions });
        return `'${args[0] ?? ''}' is not a recognized query type.`;
      }
      case 'qwinsta': return cmdQuerySession({ sessions: this.rdp.sessions });
      case 'logoff':
      case 'rwinsta': {
        // 4634 (PRD-Winlogon.md §2.1 P4) — the session's userName has to
        // be read before cmdLogoff removes the row from the table.
        const targetSessionId = Number(args[0]);
        const target = this.rdp.sessions.get(targetSessionId);
        const out = cmdLogoff({ sessions: this.rdp.sessions }, args);
        if (target && out === '') {
          this.getBus().publish({
            topic: 'windows.account.logoff',
            payload: { deviceId: this.id, account: target.userName, logonType: 10 },
          });
        }
        return out;
      }
      case 'gpupdate': {
        const res = this.gpupdateForce();
        return res.ok
          ? 'Updating policy...\n\nComputer Policy update has completed successfully.'
          : res.message;
      }
      case 'gpresult': return this.cmdGpresult();
      case 'dsregcmd': {
        const whfb = this.registry.getItemPropertyValues('HKLM\\SOFTWARE\\Policies\\Microsoft\\PassportForWork');
        const helloEnabledByPolicy = Number(whfb?.['Enabled'] ?? 0) === 1;
        return cmdDsregcmd({
          domainJoined: this.domainMembership !== null,
          domainNetbiosName: this.domainMembership?.netbiosName ?? null,
          domainDnsName: this.domainMembership?.dnsName ?? null,
          hostname: this.getHostname(),
          currentUser: this.userMgr.currentUser,
          helloEnabledByPolicy,
        }, args);
      }
      case 'iisreset': {
        const iis = this.getIisRole();
        if (!iis) return "'iisreset' is not recognized as an internal or external command,\noperable program or batch file.";
        iis.iisreset();
        return `Attempting stop...\nInternet services successfully stopped\nAttempting start...\nInternet services successfully restarted`;
      }
    }

    // net user / net localgroup / net start / net stop / net help
    if (cmd === 'net') {
      if (args.length === 0) {
        return 'The syntax of this command is:\n\nNET\n    [ ACCOUNTS | COMPUTER | CONFIG | CONTINUE | FILE | GROUP | HELP |\n      HELPMSG | LOCALGROUP | PAUSE | SESSION | SHARE | START |\n      STATISTICS | STOP | TIME | USE | USER | VIEW ]';
      }
      const subCmd = args[0].toLowerCase();
      const subArgs = args.slice(1);
      const netCtx2 = { hostname: this.hostname, userManager: this.userMgr, directoryStore: this.getDirectoryStore() };
      if (subCmd === 'user') return cmdNetUser(netCtx2, subArgs);
      if (subCmd === 'localgroup') return cmdNetLocalgroup(netCtx2, subArgs);
      const netSvcCtx = { serviceManager: this.svcMgr, processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin() };
      if (subCmd === 'start') return cmdNetStart(netSvcCtx, subArgs);
      if (subCmd === 'stop') return cmdNetStop(netSvcCtx, subArgs);
      if (subCmd === 'use') return cmdNetUse(this.buildNetContext(), subArgs);
      if (subCmd === 'share') return cmdNetShare(this.buildNetContext(), subArgs);
      if (subCmd === 'session') return this.cmdNetSession(subArgs);
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
      case 'curl':
      case 'curl.exe': return this.cmdCurl(args);
      case 'nmap':
      case 'nmap.exe': return this.cmdNmap(args);
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
  private static hasUnquotedPipe(line: string): boolean {
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQuote = !inQuote; continue; }
      if (c === '|' && !inQuote) return true;
    }
    return false;
  }

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
      return this.getEnvVars().get(upper) ?? match;
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

  private buildFileContext(): WinFileCommandContext {
    return {
      fs: this.fs,
      cwd: this.cwd,
      hostname: this.hostname,
      env: this.getEnvVars(),
      setEnv: (name: string, value: string) => this.setEnvVar(name, value),
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
    // The gateway is read through a getter, not snapshotted: `ipconfig
    // /renew` obtains the lease and then re-displays the adapter within the
    // same context, so a value captured at dispatch time would always show
    // the addressing the command has just replaced.
    const host = this;
    return {
      hostname: this.hostname,
      ports: this.ports,
      get defaultGateway() { return host.defaultGateway?.toString() || null; },
      get defaultGateway6() { return host.getDefaultGateway6()?.toString() || null; },
      arpTable: this.arpTable,
      getNeighborCache: () => this.getNeighborCache(),

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

      resolvePingEgress: (target: IPAddress) => {
        const route = this.resolveRoute(target);
        if (!route) return null;
        // On-link means the next hop is the destination itself: the ARP
        // that follows is for the target, and its failure is the target's
        // silence rather than a broken path.
        return { port: route.port, onLink: route.nextHopIP.toString() === target.toString() };
      },
      executePingSequence: (target: IPAddress, count: number, timeout?: number, ttl?: number,
        opts?: { dataSize?: number; df?: boolean }) =>
        this.executePingSequence(target, count, timeout, ttl, opts),
      executeTraceroute: (target: IPAddress, maxHops?: number, timeoutMs?: number) =>
        this.executeTraceroute(target, maxHops, timeoutMs ?? 500) as Promise<TracerouteHop[]>,

      reverseLookup: (ip: string): string | null => this.resolveAddressName(ip),

      listMulticastGroups: (ifName?: string) => this.listMulticastGroups(ifName),

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
      renameInterface: (portName: string, newName: string): boolean => {
        if (!this.ports.has(portName)) return false;
        if (adapterNameProblem(newName) !== null) return false;
        const identities = this.getPorts().map(identityOfPort);
        if (adapterNameTaken(identities, newName, portName)) return false;
        this.setAdapterAlias(portName, newName);
        return true;
      },

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
      firewallRules: this.firewallRules,
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

  /**
   * Les identifiants que le client DHCP de Windows pose dans le journal
   * Système. Repris tels quels du rendu que `wevtutil` fabriquait
   * autrefois, pour que la transition ne déplace aucun numéro.
   */
  private static readonly DHCP_EVENT_IDS: Record<string, number> = {
    INIT: 1000, DISCOVER: 1001, OFFER: 1002, REQUEST: 1003,
    ACK: 1004, RELEASE: 1005, NAK: 1006, RENEW: 1007, RESET: 1008,
  };

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
    const timestamp = this.simulatedDate().toISOString();
    this.dhcpEventLog.push(`[${timestamp}] DHCP ${type}: ${message}`);
    // Et dans le journal Système, pour de vrai. `wevtutil` synthétisait
    // auparavant ces lignes à la volée dès que la ligne de commande
    // contenait le mot « dhcp » ; désormais une requête XPath sur le
    // fournisseur `Dhcp-Client` les trouve parce qu'elles y sont —
    // c'est la même information, mais atteignable pour la bonne raison,
    // et visible aussi de `Get-WinEvent` et de l'Observateur.
    this.eventLog.writeEventLog(
      'System', 'Dhcp-Client', WindowsPC.DHCP_EVENT_IDS[type] ?? 1000, 'Information',
      message, { DhcpEventType: type });
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
        { serviceManager: this.svcMgr, processManager: this.procMgr, isAdmin: this.userMgr.isCurrentUserAdmin(), currentUser: this.userMgr.currentUser },
        args,
      );
    }
    if (lower === 'auditpol' || lower === 'auditpol.exe') {
      return cmdAuditpol(this.auditPolicy, args, this.userMgr.isCurrentUserAdmin(), {
        resolvePath: (p) => this.fs.normalizePath(p, this.cwd),
        readFile: (p) => { const r = this.fs.readFile(p); return r.ok ? (r.content ?? '') : null; },
        writeFile: (p, c) => this.fs.createFile(p, c).ok,
      }, this.hostname);
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
      elevationContext: () => this.resolveElevationForCurrentUser(),
      onTaskRegistered: (t) => this.logTaskRegistered(t.taskName),
      onTaskDeleted: (name) => this.logTaskDeleted(name),
      runTaskNow: (t) => this.runScheduledTaskNow(t),
    };
  }

  /**
   * `Microsoft-Windows-TaskScheduler/Operational` — les quatre moments
   * de la vie d'une tâche que Windows y consigne, et qu'on vient lire
   * pour savoir pourquoi elle n'a pas fait ce qu'on croyait.
   *
   * Les identifiants et le texte suivent la documentation Microsoft ;
   * faute de Windows sur la machine de mesure, ils n'ont pas pu être
   * relevés sur un vrai journal.
   */
  private taskEvent(eventId: number, message: string, data: Record<string, string>): void {
    this.eventLog.writeEventLog(
      'Microsoft-Windows-TaskScheduler/Operational', 'Microsoft-Windows-TaskScheduler',
      eventId, 'Information', message, data);
  }

  private logTaskRegistered(taskName: string): void {
    this.taskEvent(106, `User "${this.userMgr.currentUser}" registered Task Scheduler task "\\${taskName}"`,
      { TaskName: `\\${taskName}`, UserContext: this.userMgr.currentUser });
  }

  private logTaskDeleted(taskName: string): void {
    this.taskEvent(141, `User "${this.userMgr.currentUser}" deleted Task Scheduler task "\\${taskName}"`,
      { TaskName: `\\${taskName}`, UserName: this.userMgr.currentUser });
  }

  /**
   * Démarrer une tâche à la main — `schtasks /run` et
   * `Start-ScheduledTask` passent tous deux par ici, pour que l'un ne
   * puisse pas faire ce que l'autre ne fait pas.
   */
  runScheduledTaskNow(task: WinSys.WinScheduledTask): void {
    WinSys.runScheduledProgram(task, this.procMgr, this.simulatedDate());
    this.runScheduledPowerShellScript(task.command);
    if (task.command) this.logTaskRan(task.taskName, task.command);
  }

  /** 200 puis 201 : l'action démarre, l'action se termine. */
  private logTaskRan(taskName: string, command: string): void {
    this.taskEvent(200, `Task Scheduler launched action "${command}" in instance "\\${taskName}"`,
      { TaskName: `\\${taskName}`, ActionName: command });
    this.taskEvent(201, `Task Scheduler successfully completed task "\\${taskName}", action "${command}" with return code 0.`,
      { TaskName: `\\${taskName}`, ActionName: command, ResultCode: '0' });
    this.taskEvent(102, `Task Scheduler successfully finished "\\${taskName}" instance.`,
      { TaskName: `\\${taskName}` });
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

  /**
   * Une occurrence dont l'heure passe pendant que le planificateur est
   * arrêté est **manquée** : personne n'était là pour la lancer. C'est
   * exactement ce que compte le `NumberOfMissedRuns` de
   * `Get-ScheduledTaskInfo`, qui rendait zéro faute de quoi que ce soit
   * qui les compte.
   *
   * Les occurrences sont comptées puis l'échéance est réarmée en avant,
   * plutôt que laissées dans le passé : sans cela la reprise du service
   * les rejouerait toutes d'un coup, ce qu'un vrai Windows ne fait pas
   * — la case « exécuter dès que possible après un démarrage manqué »
   * est décochée par défaut, et une occurrence ratée est perdue, pas
   * différée.
   *
   * Une tâche **désactivée** ne compte rien : elle n'a pas d'horaire en
   * vigueur, il n'y a donc rien à manquer.
   */
  private sweepMissedScheduledRuns(now: Date): void {
    for (const task of this.scheduledTasks.values()) {
      if (task.state === 'Disabled' || !task.runAt || !task.intervalMs) continue;
      let guard = 0;
      while (task.runAt.getTime() <= now.getTime() && guard++ < 20_000) {
        task.missedRuns = (task.missedRuns ?? 0) + 1;
        task.runAt = new Date(task.runAt.getTime() + task.intervalMs);
      }
    }
  }

  private fireDueScheduledTasks(): void {
    if (this.svcMgr.getService('Schedule')?.state !== 'Running') {
      this.sweepMissedScheduledRuns(this.simulatedDate());
      return;
    }
    const now = this.simulatedDate();
    for (const task of this.scheduledTasks.values()) {
      // Désactiver une tâche coupe ses déclencheurs — c'est le sens de
      // `schtasks /change /disable`. Un `/run` manuel reste possible.
      if (task.state === 'Disabled') continue;
      let guard = 0;
      while (task.runAt && task.runAt.getTime() <= now.getTime() && guard++ < 20_000) {
        WinSys.runScheduledProgram(task, this.procMgr, now);
        this.runScheduledPowerShellScript(task.command);
        if (task.command) this.logTaskRan(task.taskName, task.command);
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

  /**
   * The account's own spelling for a login name. Windows logins are
   * case-insensitive, but the profile directory and the prompt carry the
   * canonical casing — so `ssh user@host` belongs in `C:\\Users\\User`.
   * Returns undefined for a name no account matches, leaving the caller's
   * own fallback in place.
   */
  resolveAccountName(name: string): string | undefined {
    return this.userMgr.getUser(name)?.name;
  }

  /**
   * A stacked CLI session for one SSH channel — cmd at the bottom, with
   * `powershell` and friends pushed on top. The stack lives here, on the
   * server side of the wire, so an SSH client only ever exchanges lines
   * and a prompt (docs/PRD-SSH-Unification.md §4bis B2).
   */
  createVtyShell(user: string): {
    execute(rawInput: string): Promise<string>;
    getPrompt(): string;
    getCompletions(line: string): string[];
    isNested(): boolean;
    lastClearedScreen(): boolean;
    lastPendingInput(): { kind: 'password' | 'text'; promptText: string } | null;
    lastEndedSession(): boolean;
    handleInput(value: string): Promise<string>;
  } | null {
    let stack: CrossVendorRemoteShell;
    try {
      stack = new CrossVendorRemoteShell({
        device: this, user, remoteHost: this.hostname, primaryKind: 'cmd',
      });
    } catch {
      // No shell registered for 'cmd' (bare unit fixtures): fall back to
      // the flat one-shot executor rather than failing the session.
      return null;
    }
    // `cls` is a screen wipe, and the screen belongs to the client — so
    // the intent is remembered here and reported over the wire rather
    // than silently dropped (docs/PRD-SSH-Unification.md §4bis B4).
    let cleared = false;
    let pending: { kind: 'password' | 'text'; promptText: string } | null = null;
    // `exit` at the bottom cmd logs the channel out. The exit word is the
    // remote's own, so the remote is what says the session is over — a
    // client cannot tell that from the text alone.
    let ended = false;
    const absorb = (result: { output: readonly string[]; clearScreen?: boolean; exit?: boolean;
      pendingInput?: { kind: 'password' | 'text'; promptText: string } }) => {
      cleared = result.clearScreen === true;
      pending = result.pendingInput ?? null;
      ended = result.exit === true;
      return result.output.join('\n');
    };
    return {
      execute: async (rawInput: string) => absorb(await stack.processLine(rawInput)),
      handleInput: async (value: string) => absorb(await stack.handleInput(value)),
      getPrompt: () => stack.getPrompt(),
      getCompletions: (line: string) => [...stack.getCompletions(line)],
      isNested: () => stack.depth > 1,
      lastClearedScreen: () => cleared,
      lastPendingInput: () => pending,
      lastEndedSession: () => ended,
    };
  }
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
    if (args.join(' ').toLowerCase().includes('logicaldisk')) {
      const drives = this.fs.listDrives();
      return ['Name  ', ...drives.map((d) => d.padEnd(6))].join('\n');
    }
    return WinSys.cmdWmic(this.buildSystemContext(), args);
  }

  private cmdReg(args: string[]): string {
    return winCmdReg(this.registry, args);
  }

  private curlHost(): CurlHost {
    return {
      resolveHostname: async (name: string): Promise<string | null> => {
        const ip = await this.resolveHostname(name);
        return ip ? ip.toString() : null;
      },
      tcpStack: () => this.getTcpStack(),
      trustAnchors: () => this.trustedCAs,
      readFile: (path: string): string | null => {
        const r = this.fs.readFile(this.fs.normalizePath(path, this.cwd));
        return r.ok && r.content !== undefined ? r.content : null;
      },
      writeFile: (target: string, content: string): boolean =>
        this.fs.createFile(this.fs.normalizePath(target, this.cwd), content).ok,
    };
  }

  async cmdCurl(args: string[]): Promise<string> {
    const result = await runCurl(this.curlHost(), args);
    return [result.output, result.stderr].filter((s) => s.length > 0).join('\n');
  }

  async runCurlWithStatus(args: string[]): Promise<{ output: string; exitCode: number; stderr: string }> {
    return runCurl(this.curlHost(), args);
  }

  private scanHost(): ScanHost {
    return {
      device: this,
      readFile: (p) => {
        const r = this.fs.readFile(this.fs.normalizePath(p, this.cwd));
        return r.ok ? r.content : null;
      },
      ping: (ip, timeoutMs) => (ip.includes(':')
        ? this.executePing6Sequence(new IPv6Address(ip), 1, timeoutMs)
        : this.executePingSequence(new IPAddress(ip), 1, timeoutMs)),
      tcpOutcome: (ip, port) => (ip.includes(':')
        ? this.tcpConnectOutcome6(new IPv6Address(ip), port)
        : this.tcpConnectOutcome(new IPAddress(ip), port)),
      grabGreeting: (ip, port) => this.getTcpStack().grabGreeting(ip, port),
      sendUdpProbe: (ip, port, sourcePort, options) =>
        this.sendUdpDatagram(new IPAddress(ip), port, sourcePort, null, 0, options),
      scanProbe: (ip, port, flags, shape) =>
        this.getTcpStack().scanProbe(ip, port, flags, shape),
      linkNeighbour: (ip) => linkNeighbourOf(this, ip),
      reverseName: (ip) => this.resolveAddressNameAsync(ip),
      resolveName: async (name) => (await this.resolveHostname(name))?.toString() ?? null,
      tracePath: async (ip) => (await this.executeTraceroute(new IPAddress(ip)))
        .map((h) => ({ ttl: h.hop, ip: h.ip, rttMs: h.rttMs })),
    };
  }

  async cmdNmap(args: string[]): Promise<string> {
    const result = await runNmap(this.scanHost(), args);
    if (result.outputNormalPath) {
      this.fs.createFile(
        this.fs.normalizePath(result.outputNormalPath, this.cwd), result.normal + '\n');
    }
    if (result.outputGreppablePath && result.greppable !== null) {
      this.fs.createFile(
        this.fs.normalizePath(result.outputGreppablePath, this.cwd), result.greppable + '\n');
    }
    if (result.outputXmlPath && result.xml !== null) {
      this.fs.createFile(
        this.fs.normalizePath(result.outputXmlPath, this.cwd), result.xml + '\n');
    }
    return result.output;
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
    this.userMgr.setCurrentUser(name);
  }

  /** Override Equipment's hard-coded 'user' default so syncDeviceState
   *  reports the real currently-logged-in account on this Windows host. */
  getCurrentUser(): string { return this.userMgr.currentUser; }

  /** Get the service manager (for PowerShellExecutor and other integrations) */
  private lacpAgentInstance: LacpAgent | null = null;
  private readonly nicTeams = new Map<string, NicTeam>();
  private readonly teamSavedMacs = new Map<string, string>();

  getLacpAgent(): LacpAgent {
    if (!this.lacpAgentInstance) {
      this.lacpAgentInstance = new LacpAgent(
        {
          id: this.id, name: this.name,
          getHostname: () => this.getHostname(),
          getPort: (n: string) => this.getPort(n),
          getPorts: () => this.getPorts(),
          sendOnLink: (request) => this.getLinkLayer().send(request),
        },
        () => this.getBus(),
        this.getPorts()[0]?.getMAC().toString() ?? '00:00:00:00:00:00',
      );
      this.lacpAgentInstance.start();
    }
    return this.lacpAgentInstance;
  }

  getNicTeams(): ReadonlyMap<string, NicTeam> { return this.nicTeams; }

  getNicTeam(name: string): NicTeam | undefined {
    for (const [nom, t] of this.nicTeams) {
      if (nom.toLowerCase() === name.toLowerCase()) return t;
    }
    return undefined;
  }

  createNicTeam(team: NicTeam): string {
    if (this.getNicTeam(team.name)) return `A team named '${team.name}' already exists.`;
    for (const m of team.members) {
      if (!this.getPort(m.name)) return `The network adapter '${m.name}' was not found.`;
      const deja = this.teamOwning(m.name);
      if (deja) return `The network adapter '${m.name}' is already a member of team '${deja.name}'.`;
    }
    const primaire = this.getPort(team.members[0]?.name ?? '');
    const nic = new Port(primaryTeamNic(team), 'ethernet',
      primaire ? new MACAddress(primaire.getMAC().toString()) : undefined,
      { carrierless: true });
    nic.setUp(false);
    this.addPort(nic);
    this.nicTeams.set(team.name, team);
    for (const m of team.members) this.adoptTeamMember(team, m);
    this.applyNicTeam(team.name);
    return '';
  }

  removeNicTeam(name: string): boolean {
    const team = this.getNicTeam(name);
    if (!team) return false;
    for (const m of [...team.members]) this.releaseTeamMember(m.name);
    for (const n of team.teamNics) {
      this.ports.delete(n.name);
      this.unregisterVlanSubInterface(n.name);
    }
    return this.nicTeams.delete(team.name);
  }

  addNicTeamNic(teamName: string, vlanId: number, name?: string): string {
    const team = this.getNicTeam(teamName);
    if (!team) return `The team '${teamName}' was not found.`;
    if (!Number.isInteger(vlanId) || vlanId < 0 || vlanId >= 4095) {
      return `The VLAN ID '${vlanId}' is not valid. VlanID values must meet the criteria 0 <= VlanID < 4095.`;
    }
    if (team.teamNics.some(n => n.vlanId === vlanId)) {
      return `A team interface with VLAN ID ${vlanId} already exists on team '${team.name}'.`;
    }
    const nom = name ?? defaultTeamNicName(team.name, vlanId);
    if (this.getPort(nom)) return `An interface named '${nom}' already exists.`;
    const parent = this.getPort(primaryTeamNic(team));
    const nic = new Port(nom, 'ethernet',
      parent ? new MACAddress(parent.getMAC().toString()) : undefined,
      { carrierless: true });
    nic.setUp(true);
    this.addPort(nic);
    this.registerVlanSubInterface(nom, primaryTeamNic(team), vlanId);
    team.teamNics.push({ name: nom, vlanId, primary: false });
    return '';
  }

  removeNicTeamNic(teamName: string, vlanId: number): string {
    const team = this.getNicTeam(teamName);
    if (!team) return `The team '${teamName}' was not found.`;
    const nic = team.teamNics.find(n => n.vlanId === vlanId);
    if (!nic) return `No team interface with VLAN ID ${vlanId} exists on team '${team.name}'.`;
    if (nic.primary) return 'The default team interface cannot be removed.';
    this.ports.delete(nic.name);
    this.unregisterVlanSubInterface(nic.name);
    team.teamNics = team.teamNics.filter(n => n !== nic);
    return '';
  }

  findNicTeamNic(name: string): { team: NicTeam; nic: TeamNic } | null {
    for (const team of this.nicTeams.values()) {
      const nic = team.teamNics.find(n => n.name.toLowerCase() === name.toLowerCase());
      if (nic) return { team, nic };
    }
    return null;
  }

  setNicTeamNic(name: string, patch: { vlanId?: number; isDefault?: boolean }): string {
    const trouve = this.findNicTeamNic(name);
    if (!trouve) return `The team interface '${name}' was not found.`;
    const { team, nic } = trouve;
    if (patch.isDefault) {
      if (!nic.primary) {
        return 'Only the team interface that was created with the team can be set to Default mode.';
      }
      return this.renameTeamNic(team, nic, team.name, null);
    }
    if (patch.vlanId === undefined) return '';
    const vlanId = patch.vlanId;
    if (!Number.isInteger(vlanId) || vlanId < 0 || vlanId >= 4095) {
      return `The VLAN ID '${vlanId}' is not valid. VlanID values must meet the criteria 0 <= VlanID < 4095.`;
    }
    if (team.teamNics.some(n => n !== nic && n.vlanId === vlanId)) {
      return `A team interface with VLAN ID ${vlanId} already exists on team '${team.name}'.`;
    }
    return this.renameTeamNic(team, nic, defaultTeamNicName(team.name, vlanId), vlanId);
  }

  private renameTeamNic(
    team: NicTeam, nic: TeamNic, nouveau: string, vlanId: number | null,
  ): string {
    const ancien = nic.name;
    if (nouveau.toLowerCase() !== ancien.toLowerCase()) {
      if (this.getPort(nouveau)) return `An interface named '${nouveau}' already exists.`;
      if (!this.renamePort(ancien, nouveau)) {
        return `The team interface '${ancien}' was not found.`;
      }
      this.renameInterfaceReferences(ancien, nouveau);
    }
    this.unregisterVlanSubInterface(nouveau);
    nic.name = nouveau;
    nic.vlanId = vlanId;
    if (!nic.primary && vlanId !== null) {
      this.registerVlanSubInterface(nouveau, primaryTeamNic(team), vlanId);
    }
    if (nic.primary) {
      for (const autre of team.teamNics) {
        if (autre.primary || autre.vlanId === null) continue;
        this.unregisterVlanSubInterface(autre.name);
        this.registerVlanSubInterface(autre.name, nouveau, autre.vlanId);
      }
    }
    return '';
  }

  private renameInterfaceReferences(ancien: string, nouveau: string): void {
    const pareil = (n: string) => n.toLowerCase() === ancien.toLowerCase();
    for (const route of this.routingTable) {
      if (pareil(route.iface)) route.iface = nouveau;
    }
    for (const [cle, entree] of this.extraIPs) {
      if (pareil(entree.ifAlias)) this.extraIPs.set(cle, { ...entree, ifAlias: nouveau });
    }
    const sub = this.getVlanSubInterface(ancien);
    if (sub) {
      this.unregisterVlanSubInterface(ancien);
      this.registerVlanSubInterface(nouveau, sub.parent, sub.vid);
    }
  }

  addNicTeamMember(teamName: string, member: TeamMember): string {
    const team = this.getNicTeam(teamName);
    if (!team) return `The team '${teamName}' was not found.`;
    if (!this.getPort(member.name)) return `The network adapter '${member.name}' was not found.`;
    const deja = this.teamOwning(member.name);
    if (deja) return `The network adapter '${member.name}' is already a member of team '${deja.name}'.`;
    team.members.push(member);
    this.adoptTeamMember(team, member);
    this.applyNicTeam(team.name);
    return '';
  }

  removeNicTeamMember(memberName: string): string {
    const team = this.teamOwning(memberName);
    if (!team) return `The network adapter '${memberName}' is not a member of any team.`;
    team.members = team.members.filter(m => m.name !== memberName);
    this.releaseTeamMember(memberName);
    this.applyNicTeam(team.name);
    return '';
  }

  teamOwning(nic: string): NicTeam | null {
    for (const t of this.nicTeams.values()) {
      if (t.members.some(m => m.name.toLowerCase() === nic.toLowerCase())) return t;
    }
    return null;
  }

  private adoptTeamMember(team: NicTeam, member: TeamMember): void {
    const nic = this.getPort(primaryTeamNic(team));
    const port = this.getPort(member.name);
    if (!nic || !port) return;
    this.teamSavedMacs.set(member.name, port.getMAC().toString());
    port.setMAC(new MACAddress(nic.getMAC().toString()));
    port.onLinkChange((state) => {
      this.refreshTeamCarrier(team.name);
      if (state !== 'down' || this.teamOwning(member.name)?.name !== team.name) return;
      this.eventLog.writeEventLog(
        'System', 'Microsoft-Windows-MsLbfoSysEvtProvider', 16949, 'Warning',
        `Member Nic ${toDisplayName(member.name)} Disconnected.`,
        { Team: team.name, MemberNic: toDisplayName(member.name) });
    });
  }

  private releaseTeamMember(memberName: string): void {
    this.getLacpAgent().removePort(memberName);
    const rendue = this.teamSavedMacs.get(memberName);
    if (rendue) {
      this.getPort(memberName)?.setMAC(new MACAddress(rendue));
      this.teamSavedMacs.delete(memberName);
    }
  }

  applyNicTeam(name: string): void {
    const team = this.getNicTeam(name);
    if (!team) return;
    const agent = this.getLacpAgent();
    agent.setFastRate(team.lacpTimer === 'Fast');
    for (const m of team.members) {
      if (!this.getPort(m.name)) continue;
      if (team.teamingMode !== 'LACP' || m.adminMode === 'Standby') {
        agent.removePort(m.name);
        continue;
      }
      agent.addPortToGroup(m.name, 1, 'active');
    }
    this.refreshTeamCarrier(name);
  }

  private refreshTeamCarrier(name: string): void {
    const team = this.getNicTeam(name);
    const nic = team ? this.getPort(primaryTeamNic(team)) : undefined;
    if (!team || !nic) return;
    nic.setUp(this.activeTeamMembers(team).length > 0);
  }

  activeTeamMembers(team: NicTeam): string[] {
    const agent = this.getLacpAgent();
    return team.members
      .filter(m => m.adminMode === 'Active')
      .map(m => m.name)
      .filter(n => this.getPort(n)?.isOperationallyUp())
      .filter(n => team.teamingMode !== 'LACP' || agent.getPortInfo(n)?.bundled === true);
  }

  aggregateLinkSpeedMbps(portName: string): number | null {
    const team = [...this.nicTeams.values()]
      .find(t => primaryTeamNic(t).toLowerCase() === portName.toLowerCase());
    if (!team) return null;
    return this.activeTeamMembers(team)
      .reduce((total, n) => total + (this.getPort(n)?.getNegotiatedSpeed() ?? 0), 0);
  }

  protected override aggregateMemberFor(
    portName: string, frame: EthernetFrame,
  ): string | null | undefined {
    const team = [...this.nicTeams.values()]
      .find(t => primaryTeamNic(t).toLowerCase() === portName.toLowerCase());
    if (!team) return undefined;
    return selectBundleMember(this.activeTeamMembers(team), frame,
      lbAlgorithmToLoadBalance(team.loadBalancingAlgorithm));
  }

  protected override aggregateIngressPort(portName: string): string | undefined {
    const team = this.teamOwning(portName);
    return team ? primaryTeamNic(team) : undefined;
  }

  protected override receiveSlowProtocol(portName: string, frame: EthernetFrame): void {
    if (this.nicTeams.size === 0) return;
    this.getLacpAgent().handleFrame(portName, frame);
    for (const nom of this.nicTeams.keys()) this.refreshTeamCarrier(nom);
  }

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
   * Exchange organization membership (docs/PRD-Exchange.md §2.1 P1) —
   * null until `Install-ExchangeServer` on a `WindowsServer`; always null
   * on a client, overridden by `WindowsServer`.
   */
  getExchangeOrganizationName(): string | null { return null; }

  installExchangeServer(_organizationName: string, _roles?: readonly string[]): { ok: boolean; message: string } {
    return { ok: false, message: 'Install-ExchangeServer : Exchange Server setup cannot run on this computer.' };
  }

  getExchangeServer(_hostname?: string): import('./windows/server/exchange/ExchangeOrganization').ExchangeServerRecord | null { return null; }

  listExchangeServers(): import('./windows/server/exchange/ExchangeOrganization').ExchangeServerRecord[] { return []; }

  getMailboxStore(): import('./windows/server/exchange/MailboxStore').MailboxStore | null { return null; }

  enableMailbox(_identity: string): { ok: boolean; message: string } {
    return { ok: false, message: 'Enable-Mailbox : Exchange Server has not been installed on this computer.' };
  }

  newMailbox(_sam: string, _password: string): { ok: boolean; message: string } {
    return { ok: false, message: 'New-Mailbox : Exchange Server has not been installed on this computer.' };
  }

  disableMailbox(_identity: string): { ok: boolean; message: string } {
    return { ok: false, message: 'Disable-Mailbox : Exchange Server has not been installed on this computer.' };
  }

  removeMailbox(_identity: string): { ok: boolean; message: string } {
    return { ok: false, message: 'Remove-Mailbox : Exchange Server has not been installed on this computer.' };
  }

  getDistributionGroupStore(): import('./windows/server/exchange/DistributionGroupStore').DistributionGroupStore | null { return null; }

  newDistributionGroup(_sam: string, _type?: 'Distribution' | 'SecurityMailEnabled'): { ok: boolean; message: string } {
    return { ok: false, message: 'New-DistributionGroup : Exchange Server has not been installed on this computer.' };
  }

  setDistributionGroupPrimarySmtpAddress(_identity: string, _address: string): { ok: boolean; message: string } {
    return { ok: false, message: 'Set-DistributionGroup : Exchange Server has not been installed on this computer.' };
  }

  addDistributionGroupMember(_identity: string, _memberSam: string): { ok: boolean; message: string } {
    return { ok: false, message: 'Add-DistributionGroupMember : Exchange Server has not been installed on this computer.' };
  }

  getDistributionGroupMembers(_identity: string): string[] | null { return null; }

  deliverToRecipient(_recipientAddress: string, _from: string, _subject: string, _rawMessage: string, _receivedAt: number): import('./windows/server/exchange/MailboxStore').DeliverResult[] {
    return [{ delivered: false, reason: 'not-found' }];
  }

  getGlobalAddressList(): import('./windows/server/exchange/GlobalAddressList').GalEntry[] { return []; }

  resolveRecipientAddress(_query: string): string | null { return null; }

  newReceiveConnector(_def: import('./windows/server/exchange/TransportConnector').ReceiveConnectorDef): { ok: boolean; message: string } {
    return { ok: false, message: 'New-ReceiveConnector : Exchange Server has not been installed on this computer.' };
  }

  getReceiveConnector(_name: string): import('./windows/server/exchange/TransportConnector').ReceiveConnectorDef | null { return null; }

  listReceiveConnectors(): import('./windows/server/exchange/TransportConnector').ReceiveConnectorDef[] { return []; }

  newSendConnector(_def: import('./windows/server/exchange/TransportConnector').SendConnectorDef): { ok: boolean; message: string } {
    return { ok: false, message: 'New-SendConnector : Exchange Server has not been installed on this computer.' };
  }

  getSendConnector(_name: string): import('./windows/server/exchange/TransportConnector').SendConnectorDef | null { return null; }

  listSendConnectors(): import('./windows/server/exchange/TransportConnector').SendConnectorDef[] { return []; }

  getTransportRuleStore(): import('./windows/server/exchange/TransportRuleEngine').TransportRuleStore | null { return null; }

  newTransportRule(_rule: import('./windows/server/exchange/TransportRuleEngine').TransportRule): { ok: boolean; message: string } {
    return { ok: false, message: 'New-TransportRule : Exchange Server has not been installed on this computer.' };
  }

  getTransportRule(_name: string): import('./windows/server/exchange/TransportRuleEngine').TransportRule | null { return null; }

  listTransportRules(): import('./windows/server/exchange/TransportRuleEngine').TransportRule[] { return []; }

  getDeliveryQueue(): import('@/network/smtp/queue').DeliveryQueue | null { return null; }

  getAutodiscoverResponse(_emailAddress: string): import('./windows/server/exchange/Autodiscover').AutodiscoverResponse | null { return null; }

  addMailboxPermission(_identity: string, _user: string): { ok: boolean; message: string } {
    return { ok: false, message: 'Add-MailboxPermission : Exchange Server has not been installed on this computer.' };
  }

  addRecipientPermission(_identity: string, _trustee: string): { ok: boolean; message: string } {
    return { ok: false, message: 'Add-RecipientPermission : Exchange Server has not been installed on this computer.' };
  }

  getMailboxPermissions(_identity: string, _rights: 'FullAccess' | 'SendAs'): string[] { return []; }

  userHasMailboxAccess(_identity: string, _userSam: string, _rights: 'FullAccess' | 'SendAs'): boolean { return false; }

  getMailboxContentsAsUser(_identity: string, _requestingUserSam: string): readonly import('./windows/server/exchange/MailboxStore').StoredMailItem[] | null { return null; }

  newJournalRule(_journalEmailAddress: string): { ok: boolean; message: string } {
    return { ok: false, message: 'New-JournalRule : Exchange Server has not been installed on this computer.' };
  }

  getJournalRule(): import('./windows/server/exchange/TransportRuleEngine').TransportRule | null { return null; }

  newDatabaseAvailabilityGroup(_name: string): { ok: boolean; message: string } {
    return { ok: false, message: 'New-DatabaseAvailabilityGroup : Exchange Server has not been installed on this computer.' };
  }

  addDatabaseAvailabilityGroupServer(_dagName: string, _server: string): { ok: boolean; message: string } {
    return { ok: false, message: 'Add-DatabaseAvailabilityGroupServer : Exchange Server has not been installed on this computer.' };
  }

  addMailboxDatabaseCopy(_dagName: string, _database: string, _server: string): { ok: boolean; message: string } {
    return { ok: false, message: 'Add-MailboxDatabaseCopy : Exchange Server has not been installed on this computer.' };
  }

  updateMailboxDatabaseCopy(_dagName: string, _database: string, _server: string): { ok: boolean; message: string } {
    return { ok: false, message: 'Update-MailboxDatabaseCopy : Exchange Server has not been installed on this computer.' };
  }

  getMailboxDatabaseCopyStatus(_dagName: string, _database?: string): import('./windows/server/exchange/DatabaseAvailabilityGroup').MailboxDatabaseCopy[] { return []; }

  testServiceHealth(): import('./WindowsServer').ServiceHealthCheck[] { return []; }

  testMailflow(fromIdentity: string, toIdentity: string): import('./WindowsServer').MailflowTestResult {
    return { success: false, fromMailbox: fromIdentity, toMailbox: toIdentity, latencyMs: 0, failureReason: 'Exchange Server has not been installed on this computer.' };
  }

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
      getUser: (name) => this.userMgr.getUser(name) ?? this.getDomainUserForRunas(name),
      getCurrentUser: () => this.userMgr.currentUser,
      setCurrentUser: (name) => this.setCurrentUser(name),
      // TokenElevationType %%1937 (PRD-Winlogon.md §2.1 P5) — any
      // process a `start`-family command spawns while running under a
      // real runas elevation carries `elevation: 'full'` instead of
      // falling back to the name-based heuristic. Restored to null even
      // if the wrapped command throws, so a failure never leaks
      // elevation into whatever runs next.
      executeCmdCommand: async (command) => {
        this.pendingElevation = 'full';
        try {
          return await this.executeCmdCommand(command);
        } finally {
          this.pendingElevation = null;
        }
      },
      onLogon: (userName, subject) => {
        this.getBus().publish({
          topic: 'windows.account.logon',
          payload: { deviceId: this.id, account: userName, success: true, logonType: 2 },
        });
        // 4648 (PRD-Winlogon.md §2.1 P5) — real explicit-credentials
        // logon, dynamically generated with the actual caller/target
        // pair instead of the one static demo entry seeded at boot.
        this.getBus().publish({
          topic: 'windows.account.explicit-credentials',
          payload: { deviceId: this.id, subject, target: userName },
        });
      },
    };
  }

  /**
   * `runas /user:DOMAIN\sam` — the local WindowsUserManager only knows
   * local accounts. When this device is itself the DC (its own
   * DirectoryStore is right here, no network round-trip needed), a
   * domain-qualified name matching its own domain is resolved against
   * the real directory instead of being unconditionally "not recognized".
   * A name qualified with a *different* domain is checked as a real
   * cross-realm Kerberos referral request against this device's own DC
   * (`crossRealmRunasCheck`) — that DC's own real `TrustRegistry` is the
   * sole authority on whether it succeeds.
   */
  private getDomainUserForRunas(name: string): RunasUserLookup | undefined {
    const backslash = name.indexOf('\\');
    if (backslash === -1) return undefined;
    const domainPart = name.slice(0, backslash);
    const sam = name.slice(backslash + 1);
    const store = this.getDirectoryStore();
    const ownNetbiosName = store?.netbiosName ?? this.domainMembership?.netbiosName;
    if (ownNetbiosName && domainPart.toUpperCase() === ownNetbiosName.toUpperCase()) {
      const u = store?.getUser(sam);
      return u ? { name: sam, enabled: u.enabled } : undefined;
    }
    return this.crossRealmRunasCheck(domainPart, sam);
  }

  /**
   * `runas /user:<foreign-realm>\<sam>` on a domain-joined machine
   * (docs — scenario-ad-trust-relationships gap 2): performs a genuine
   * AS-REQ (as this computer's own machine account) then a TGS-REQ with
   * `targetRealm = <foreign-realm>` against this device's own DC —
   * exactly the real inter-realm referral request a workstation's KDC
   * chase produces (`KdcSession.handleTgsReq`'s `isOutboundReferral`
   * branch, which only succeeds if that DC's own `TrustRegistry` actually
   * has a matching Outbound/Bidirectional trust — real 4769 auditing on
   * that DC included). Documented simplification: this does not chase the
   * referral all the way to the foreign realm's own KDC to fully
   * authenticate as `sam` there — verifying the real referral succeeds is
   * as far as this simulator's cross-realm model goes.
   */
  private crossRealmRunasCheck(targetRealm: string, sam: string): RunasUserLookup | undefined {
    if (!this.domainMembership) return undefined;
    const kdcConn = dialKdc(this.getTcpStack(), this.domainMembership.dcAddress);
    if (!kdcConn.ok || !kdcConn.client) return undefined;
    const ownSam = `${this.hostname}$`;
    const realm = this.domainMembership.dnsName.toUpperCase();
    const asResult = kdcConn.client.asExchange(ownSam, this.domainMembership.machineSecret, realm);
    if (!asResult.ok || !asResult.ticket || !asResult.sessionKey) return undefined;
    const cname = principalName(PrincipalNameType.NT_PRINCIPAL, ownSam);
    const tgsResult = kdcConn.client.tgsExchange(asResult.ticket, asResult.sessionKey, cname, realm, ownSam, targetRealm.toLowerCase());
    if (!tgsResult.ok) return undefined;
    return { name: sam, enabled: true };
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

  /** Runs `command` as `userName` — called by `WindowsTerminalSession` once the password has already been verified via `checkPassword`/`tryDomainAuth`. A domain-qualified `userName` also acquires a real Kerberos TGT, so `klist` sees it afterward — acquired only once `runAsUser` (and its internal `setCurrentUser` impersonate/revert, which always drops any cached ticket) has fully returned, matching `logonDomain`'s cache-survives-the-call contract. */
  async runAsUserVerified(userName: string, command: string, password?: string): Promise<string> {
    if (password !== undefined && this.domainMembership) {
      const parsed = parseDomainQualifiedUser(userName, this.domainMembership);
      if (parsed) {
        const output = await runAsUser(this.runasHost(), parsed.sam, command);
        this.acquireKerberosTgt(parsed.sam, password);
        return output;
      }
    }
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

  /** `netdom join`/`netdom trust`/`netdom verify` — cmd-level equivalents of `Add-Computer -DomainName`/`New-ADTrust`/`Test-ComputerSecureChannel`, same real wire dialogue underneath. */
  /**
   * A collector-side lookup (docs/PRD-Wecutil.md §2.1 P4): the first
   * `Enabled` `SourceInitiated` subscription whose `Query` matches
   * `(logName, eventId)`, provided `Wecsvc` is actually running — never
   * a match against a subscription nobody would currently service.
   */
  findMatchingActiveWecSubscription(logName: string, eventId: number): WecSubscription | null {
    if (this.svcMgr.getService('Wecsvc')?.state !== 'Running') return null;
    for (const sub of this.wecSubscriptions.values()) {
      if (!sub.enabled) continue;
      if (sub.query.logName && sub.query.logName.toLowerCase() !== logName.toLowerCase()) continue;
      if (sub.query.eventIds.length > 0 && !sub.query.eventIds.includes(eventId)) continue;
      return sub;
    }
    return null;
  }

  /**
   * Collector-side landing point for a real `wecPush` (docs/PRD-Wecutil.md
   * §2.1 P4), invoked by `WinRmServerHandler` once the pushing source has
   * authenticated. Materializes into this device's own `ForwardedEvents`
   * log with `MachineName` set to the real source, via the same
   * `writeEventLog()` every other event on this device already goes
   * through (no second, forwarding-only code path).
   */
  receiveForwardedEvent(subscriptionId: string, sourceMachine: string, event: {
    eventId: number; timeGenerated: string; message: string; sourceLogName: string;
  }): { ok: boolean; message: string } {
    const sub = this.wecSubscriptions.get(subscriptionId);
    if (!sub || !sub.enabled) return { ok: false, message: `The specified subscription "${subscriptionId}" does not exist or is disabled.` };
    this.eventLog.writeEventLog(
      sub.logFile, event.sourceLogName, event.eventId, 'Information',
      event.message, { MachineName: sourceMachine },
    );
    return { ok: true, message: '' };
  }

  /**
   * Source-side hook (docs/PRD-Wecutil.md §2.1 P4), fired after every
   * local `writeEventLog()`: finds domain-joined collectors reachable on
   * the network with a matching active subscription and pushes the event
   * to each, by a real dial per event (§1.3 — same one-shot pattern as
   * `Send-MailMessage`). A local write never blocks on this — exactly
   * like real Windows, which never fails a local audit write because a
   * forwarding collector happens to be unreachable.
   *
   * Discovery of "which machines are collectors" and their IP is an
   * in-process `EquipmentRegistry` scan (the same established precedent
   * ARP/DNS/`netdom query dc` already use) rather than a simulation of
   * the GPO `SubscriptionManager` push that would normally tell a real
   * source where to forward — out of scope, documented in
   * docs/PRD-Wecutil.md §2.2.
   */
  private tryForwardMatchingEvent(logName: string, entry: EventLogEntry): void {
    if (!this.domainMembership) return;
    const myRealm = this.domainMembership.dnsName.toLowerCase();
    for (const eq of EquipmentRegistry.getInstance().getAll()) {
      if (eq === this || !(eq instanceof WindowsPC)) continue;
      const collectorMembership = eq.getDomainMembership();
      if (!collectorMembership || collectorMembership.dnsName.toLowerCase() !== myRealm) continue;
      const sub = eq.findMatchingActiveWecSubscription(logName, entry.eventId);
      if (!sub) continue;
      const collectorIp = eq.getPorts().map(p => p.getIPAddress()).find((ip): ip is IPAddress => ip !== null);
      if (!collectorIp) continue;
      pushForwardedEvent({
        tcpStack: this.getTcpStack(),
        targetIp: collectorIp.toString(),
        // UPN form ("<hostname>$@<realm>") — `tryDomainAuth`'s
        // `parseDomainQualifiedUser` requires an explicit domain
        // qualifier (NetBIOS\ or @dns); a bare "<hostname>$" isn't a
        // recognized form even though it's a valid Kerberos principal.
        username: `${this.hostname}$@${this.domainMembership.dnsName}`,
        password: this.domainMembership.machineSecret,
        subscriptionId: sub.subscriptionId,
        sourceMachine: this.hostname,
        event: { eventId: entry.eventId, timeGenerated: entry.timeGenerated.toISOString(), message: entry.message, sourceLogName: logName },
      });
    }
  }

  /**
   * `wecutil` (docs/PRD-Wecutil.md) — Windows Event Collector CLI.
   * P1: `qc` only. P3 adds `cs`/`gs`/`ds`/`es`/`rs`/`ss`.
   */
  private cmdWecutil(args: string[]): string {
    const sub = (args[0] ?? '').toLowerCase();
    const rest = args.slice(1);
    if (sub === 'qc') return this.cmdWecutilQc(rest);
    if (sub === 'cs') return this.cmdWecutilCs(rest);
    if (sub === 'gs') return this.cmdWecutilGs(rest);
    if (sub === 'ds') return this.cmdWecutilDs(rest);
    if (sub === 'es') return this.cmdWecutilEs();
    if (sub === 'rs') return this.cmdWecutilRs(rest);
    if (sub === 'ss') return this.cmdWecutilSs(rest);
    return `wecutil: '${sub || ''}' is not a valid sub-command. Valid sub-commands are: es, gs, gr, ss, cs, rs, ds, qc.`;
  }

  /**
   * `wecutil cs <path>` (docs/PRD-Wecutil.md §2.1 P3) — reads the
   * subscription XML from this machine's own filesystem (the file a
   * prior `Out-File`/`scp` already wrote there) and registers it in
   * `wecSubscriptions`, keyed by `SubscriptionId`.
   */
  private cmdWecutilCs(args: string[]): string {
    const path = args[0];
    if (!path) return 'wecutil: cs: missing <FilePath>.';
    const abs = this.fs.normalizePath(path, this.getCwd());
    const read = this.fs.readFile(abs);
    if (!read.ok || read.content === undefined) {
      return `Error querying for the source file (Error = 2). File "${path}"`;
    }
    const parsed = parseSubscriptionXml(read.content);
    if (!parsed.ok) return `wecutil: ${parsed.error}`;
    if (this.wecSubscriptions.has(parsed.subscription.subscriptionId)) {
      return `Subscription "${parsed.subscription.subscriptionId}" already exists.`;
    }
    this.wecSubscriptions.set(parsed.subscription.subscriptionId, parsed.subscription);
    // Real Wecsvc auto-starts on the first configured subscription
    // (Microsoft docs) rather than requiring a separate `wecutil qc`
    // first — mirrored here so `cs` alone is enough to make the
    // subscription observably Active (§1.3 same effect as `qc`, §2.1 P1).
    // Real `wecutil qc`/`cs` also enables the WinRM HTTP listener the
    // subscription is pushed over (Microsoft docs: "enabling the ability
    // to receive HTTP requests") — without it, a source's real dial to
    // this collector's port 5985 would be refused at negotiate.
    this.svcMgr.setStartType('Wecsvc', 'Automatic', true);
    this.svcMgr.startService('Wecsvc', true);
    this.winrm.enable();
    return `Subscription "${parsed.subscription.subscriptionId}" created successfully.`;
  }

  /**
   * `wecutil gs <SubscriptionId>` — a subscription is `Active` only when
   * it is `Enabled` *and* `Wecsvc` is actually running (§2.1 P1/P3) —
   * never a status independent of the real service state.
   */
  private cmdWecutilGs(args: string[]): string {
    const id = args[0];
    if (!id) return 'wecutil: gs: missing <SubscriptionId>.';
    const sub = this.wecSubscriptions.get(id);
    if (!sub) return `The specified subscription "${id}" does not exist.`;
    const wecsvcRunning = this.svcMgr.getService('Wecsvc')?.state === 'Running';
    const active = sub.enabled && wecsvcRunning;
    const status = active ? 'Active' : 'Disabled';
    return [
      `Subscription Id: ${sub.subscriptionId}`,
      `SubscriptionType: ${sub.subscriptionType}`,
      `Description: ${sub.description}`,
      `Enabled: ${sub.enabled}`,
      `Status: ${status}`,
      `RunTimeStatus: ${active ? 'Active' : 'Disabled'}`,
      `LogFile: ${sub.logFile}`,
    ].join('\n');
  }

  private cmdWecutilDs(args: string[]): string {
    const id = args[0];
    if (!id) return 'wecutil: ds: missing <SubscriptionId>.';
    if (!this.wecSubscriptions.has(id)) return `The specified subscription "${id}" does not exist.`;
    this.wecSubscriptions.delete(id);
    return '';
  }

  private cmdWecutilEs(): string {
    return [...this.wecSubscriptions.keys()].join('\n');
  }

  /**
   * `wecutil rs <SubscriptionId>` — real `wecutil` retries delivery of
   * queued-but-undelivered events. This simulator pushes each event
   * synchronously, by real dial, the moment it is generated (§1.3 —
   * same one-shot-dial pattern as `Send-MailMessage`) — there is never a
   * pending queue to retry, so `rs` is an honest no-op, not a silent
   * fake success (docs/PRD-Wecutil.md §2.2, same treatment as
   * `repadmin /queue`).
   */
  private cmdWecutilRs(args: string[]): string {
    const id = args[0];
    if (!id) return 'wecutil: rs: missing <SubscriptionId>.';
    if (!this.wecSubscriptions.has(id)) return `The specified subscription "${id}" does not exist.`;
    return `No events are queued for retry on subscription "${id}" (this simulator forwards synchronously — see PRD-Wecutil.md §2.2).`;
  }

  /**
   * `wecutil ss <SubscriptionId> [/e:true|false] [/l:<LogFile>]` — only
   * the enabled toggle and log-file target are supported (§2.2, the rest
   * of the real flag surface is out of scope).
   */
  private cmdWecutilSs(args: string[]): string {
    const id = args[0];
    if (!id) return 'wecutil: ss: missing <SubscriptionId>.';
    const sub = this.wecSubscriptions.get(id);
    if (!sub) return `The specified subscription "${id}" does not exist.`;
    for (const arg of args.slice(1)) {
      const m = /^\/([a-z]+):(.*)$/i.exec(arg);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key === 'e') sub.enabled = m[2].toLowerCase() === 'true';
      else if (key === 'l') sub.logFile = m[2];
    }
    return '';
  }

  /**
   * `wecutil qc [/q|/quiet]` (docs/PRD-Wecutil.md §2.1 P1) — sets Wecsvc
   * to Automatic and starts it, the exact same two effects a plain
   * `Set-Service -StartupType Automatic; Start-Service` already produce
   * generically (§1.3) — no duplicate service-state logic here.
   */
  private cmdWecutilQc(_args: string[]): string {
    const isAdmin = this.userMgr.isCurrentUserAdmin();
    if (!isAdmin) return 'Access is denied.\nThe command failed to complete successfully.';
    this.svcMgr.setStartType('Wecsvc', 'Automatic', isAdmin);
    const err = this.svcMgr.startService('Wecsvc', isAdmin);
    if (err && !err.includes('already running')) {
      return `${err}\nThe command failed to complete successfully.`;
    }
    this.winrm.enable();
    return [
      'Windows Event Collector service was configured to start automatically with the Wecsvc service.',
      'The subscriptions store has been created.',
      'Windows Event Collector service is now configured correctly.',
    ].join('\n');
  }

  private cmdNetdom(args: string[]): string {
    const sub = args[0]?.toLowerCase();
    if (sub === 'trust') return this.cmdNetdomTrust(args.slice(1));
    if (sub === 'verify') return this.cmdNetdomVerify(args.slice(1));
    if (sub === 'reset') return this.cmdNetdomReset(args.slice(1));
    if (sub === 'resetpwd') return this.cmdNetdomResetpwd(args.slice(1));
    if (sub === 'remove') return this.cmdNetdomRemove(args.slice(1));
    if (sub === 'renamecomputer') return this.cmdNetdomRenameComputer(args.slice(1));
    if (sub === 'computername') return this.cmdNetdomComputerName(args.slice(1));
    if (sub === 'add') return this.cmdNetdomAdd(args.slice(1));
    if (sub === 'query') return this.cmdNetdomQuery(args.slice(1));
    if (args.length === 0 || sub !== 'join') {
      return 'NETDOM JOIN /Domain:<Domain> /UserD:<User> /PasswordD:<Password> [/Server:<DC>]';
    }
    let domain = '';
    let server = '';
    let userD = '';
    let passwordD = '';
    for (const arg of args.slice(1)) {
      const m = /^\/([a-z]+):(.*)$/i.exec(arg);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key === 'domain') domain = m[2];
      else if (key === 'server') server = m[2];
      else if (key === 'userd') userD = m[2];
      else if (key === 'passwordd') passwordD = m[2];
    }
    if (!domain || !userD) {
      return 'NETDOM JOIN /Domain:<Domain> /UserD:<User> /PasswordD:<Password> [/Server:<DC>]';
    }
    const dcAddress = server || this.resolveHostnameSync(domain)?.toString() || '';
    if (!dcAddress) {
      return `The specified domain either does not exist or could not be contacted.\nThe command failed to complete successfully.`;
    }
    const result = this.joinDomainNow(domain, dcAddress, userD, passwordD);
    if (!result.ok) return `${result.message}\nThe command failed to complete successfully.`;
    return `The computer name '${this.getHostname()}' has been successfully joined to the domain '${domain}'.\nThe command completed successfully.`;
  }

  /**
   * `netdom add <MachineName> /Domain:<Domain> /UserD:<User>
   * /PasswordD:<Password> [/OU:<OUPath>] [/Server:<DC>]` (docs/PRD-
   * Netdom.md §2.1 P8) — pre-stages a computer account without joining
   * THIS machine: the exact same real wire dialogue as `netdom join`
   * (`joinDomain()`, real Kerberos AS+TGS+AP-REQ, § 1.3 grounding), just
   * for a DIFFERENT machine name, and without ever assigning the result
   * to this device's own `domainMembership`.
   */
  private cmdNetdomAdd(args: string[]): string {
    let domain = '';
    let server = '';
    let userD = '';
    let passwordD = '';
    let ouPath: string | undefined;
    const positional: string[] = [];
    for (const arg of args) {
      const m = /^\/([a-z]+):(.*)$/i.exec(arg);
      if (!m) { if (!arg.startsWith('/')) positional.push(arg); continue; }
      const key = m[1].toLowerCase();
      if (key === 'domain') domain = m[2];
      else if (key === 'server') server = m[2];
      else if (key === 'userd') userD = m[2];
      else if (key === 'passwordd') passwordD = m[2];
      else if (key === 'ou') ouPath = m[2];
    }
    const machineName = positional[0] || '';
    if (!machineName || !domain || !userD) {
      return 'NETDOM ADD <MachineName> /Domain:<Domain> /UserD:<User> /PasswordD:<Password> [/OU:<OUPath>] [/Server:<DC>]';
    }
    const dcAddress = server || this.resolveHostnameSync(domain)?.toString() || '';
    if (!dcAddress) {
      return `The specified domain either does not exist or could not be contacted.\nThe command failed to complete successfully.`;
    }
    const result: DomainJoinResult = joinDomain({
      tcpStack: this.getTcpStack(), computerName: machineName, domainName: domain,
      dcAddress, credentialUser: userD, credentialPassword: passwordD, ouPath,
    });
    if (!result.ok) return `${result.message}\nThe command failed to complete successfully.`;
    return `The account for the workstation '${machineName}' has been successfully pre-created.\nThe command completed successfully.`;
  }

  /**
   * `netdom trust <TrustingDomain> /Domain:<TrustedDomain> [/Verify] |
   * netdom trust /d:<RemoteRealm> /Direction:<Inbound|Outbound|Bidirectional>
   * /Server:<RemoteDC> /UserD:<User> /PasswordD:<Password> [/Transitive:No]`
   * — cmd-level equivalent of `New-ADTrust`/`Get-ADTrust` (PRD-Windows-
   * Server-Advanced.md §5 P9). Real `netdom trust` accepts the trusted
   * domain as either a positional `TrustingDomain` + `/Domain:` pair
   * (the create/verify form) or the older `/d:` flag (this simulator's
   * original create-only form) — both map onto the same `DirectoryStore`
   * trust registry, no second implementation. `/Verify` doesn't create
   * anything: it just confirms an existing trust's secure channel, so it
   * looks the trust up instead of calling `newADTrust`. Server-only: a
   * no-op stub on a plain workstation.
   */
  private cmdNetdomTrust(args: string[]): string {
    let remoteRealm = '';
    let server = '';
    let userD = '';
    let passwordD = '';
    let direction: 'Inbound' | 'Outbound' | 'Bidirectional' = 'Bidirectional';
    let transitive = true;
    let verify = false;
    let removeTrust = false;
    let resetTrust = false;
    const positional: string[] = [];
    for (const arg of args) {
      const m = /^\/([a-z]+):(.*)$/i.exec(arg);
      if (!m) {
        const flag = arg.toLowerCase();
        if (flag === '/verify') { verify = true; continue; }
        if (flag === '/remove') { removeTrust = true; continue; }
        if (flag === '/reset') { resetTrust = true; continue; }
        if (flag === '/force') { continue; } // accepted, no additional observable effect (docs/PRD-Netdom.md §2.2)
        if (!arg.startsWith('/')) positional.push(arg);
        continue;
      }
      const key = m[1].toLowerCase();
      if (key === 'd' || key === 'domain') remoteRealm = m[2];
      else if (key === 'server') server = m[2];
      else if (key === 'userd') userD = m[2];
      else if (key === 'passwordd') passwordD = m[2];
      else if (key === 'direction' && (m[2] === 'Inbound' || m[2] === 'Outbound' || m[2] === 'Bidirectional')) direction = m[2];
      else if (key === 'transitive') transitive = m[2].toLowerCase() !== 'no';
    }
    const trustingDomain = positional[0] ?? '';

    if (verify) {
      if (!remoteRealm) {
        return 'NETDOM TRUST <TrustingDomain> /Domain:<TrustedDomain> /Verify';
      }
      const store = this.getDirectoryStore();
      if (!store) return 'The trust could not be verified. This computer is not a domain controller.\nThe command failed to complete successfully.';
      const trust = store.getTrust(remoteRealm);
      if (!trust) return `The secure channel between '${trustingDomain || store.dnsName}' and '${remoteRealm}' was not verified.\nThe command failed to complete successfully.`;
      return `The secure channel from '${trustingDomain || store.dnsName}' to the domain '${remoteRealm}' has been verified.\nThe command completed successfully.`;
    }

    if (removeTrust) {
      if (!remoteRealm) return 'NETDOM TRUST <TrustingDomain> /Domain:<TrustedDomain> /Remove [/Server:<RemoteDC> /UserD:<User> /PasswordD:<Password>]';
      const server2_ = this as unknown as { removeADTrust?: (r: string, s?: string, u?: string, p?: string) => { ok: boolean; message: string } };
      if (typeof server2_.removeADTrust !== 'function') {
        return 'The trust could not be removed. This computer is not a domain controller.\nThe command failed to complete successfully.';
      }
      const result = server2_.removeADTrust(remoteRealm, server || undefined, userD || undefined, passwordD || undefined);
      if (!result.ok) return `${result.message}\nThe command failed to complete successfully.`;
      return `The trust with '${remoteRealm}' has been successfully removed.\nThe command completed successfully.`;
    }

    if (resetTrust) {
      if (!remoteRealm) return 'NETDOM TRUST <TrustingDomain> /Domain:<TrustedDomain> /Reset [/Server:<RemoteDC> /UserD:<User> /PasswordD:<Password>]';
      const server3_ = this as unknown as { resetADTrust?: (r: string, s?: string, u?: string, p?: string) => { ok: boolean; message: string } };
      if (typeof server3_.resetADTrust !== 'function') {
        return 'The trust could not be reset. This computer is not a domain controller.\nThe command failed to complete successfully.';
      }
      const result = server3_.resetADTrust(remoteRealm, server || undefined, userD || undefined, passwordD || undefined);
      if (!result.ok) return `${result.message}\nThe command failed to complete successfully.`;
      return `The trust with '${remoteRealm}' has been successfully reset.\nThe command completed successfully.`;
    }

    if (!remoteRealm || !server || !userD) {
      return 'NETDOM TRUST /d:<RemoteRealm> /Server:<RemoteDC> /UserD:<User> /PasswordD:<Password> [/Direction:<Inbound|Outbound|Bidirectional>] [/Transitive:No]';
    }
    const server_ = this as unknown as { newADTrust?: (r: string, s: string, d: typeof direction, t: boolean, u: string, p: string) => { ok: boolean; message: string } };
    if (typeof server_.newADTrust !== 'function') {
      return 'The trust could not be established. This computer is not a domain controller.\nThe command failed to complete successfully.';
    }
    const result = server_.newADTrust(remoteRealm, server, direction, transitive, userD, passwordD);
    if (!result.ok) return `${result.message}\nThe command failed to complete successfully.`;
    return `The trust with '${remoteRealm}' has been successfully established.\nThe command completed successfully.`;
  }

  /**
   * `netdom verify <MachineName> [/Domain:<Domain>]` (docs/PRD-Netdom.md
   * §2.1 P1) — verifies the LOCAL machine's own secure channel to its
   * domain via `testSecureChannel()` (§ 1.3 grounding: same primitive
   * `Test-ComputerSecureChannel` already uses, no second implementation).
   * `MachineName`/`/Domain:` are accepted (real `netdom verify` can
   * target a remote machine given credentials) but only checked against
   * this machine's own hostname/domain — this simulator has no remote
   * dial for a THIRD machine's secure channel, only its own.
   */
  private cmdNetdomVerify(args: string[]): string {
    let domain = '';
    const positional: string[] = [];
    for (const arg of args) {
      const m = /^\/([a-z]+):(.*)$/i.exec(arg);
      if (!m) { if (!arg.startsWith('/')) positional.push(arg); continue; }
      if (m[1].toLowerCase() === 'domain') domain = m[2];
    }
    const machineName = positional[0] || this.getHostname();
    if (!this.domainMembership) {
      return `The secure channel between the workstation and the primary domain failed.\nThe command failed to complete successfully.`;
    }
    const targetDomain = domain || this.domainMembership.dnsName;
    if (targetDomain.toLowerCase() !== this.domainMembership.dnsName.toLowerCase()) {
      return `NetGetAnyDCName failed: Status = 1355 0x54b ERROR_NO_SUCH_DOMAIN\nThe command failed to complete successfully.`;
    }
    if (!this.testSecureChannel()) {
      return `The secure channel between '${machineName}' and the domain '${targetDomain}' failed.\nThe command failed to complete successfully.`;
    }
    return `The secure channel from '${machineName}' to the domain '${targetDomain}' has been verified.\nThe command completed successfully.`;
  }

  /**
   * `netdom reset <MachineName> /Domain:<Domain> /UserO:<User>
   * /PasswordO:<Password>` (docs/PRD-Netdom.md §2.1 P2) — regenerates
   * and repushes this machine's own secure-channel secret via
   * `resetSecureChannel()`. `MachineName`/`/Domain:` are accepted for
   * fidelity with real `netdom` syntax but, like `verify` (P1), only
   * this machine's own channel can actually be reset.
   */
  private cmdNetdomReset(args: string[]): string {
    let userO = '';
    let passwordO = '';
    const positional: string[] = [];
    for (const arg of args) {
      const m = /^\/([a-z]+):(.*)$/i.exec(arg);
      if (!m) { if (!arg.startsWith('/')) positional.push(arg); continue; }
      const key = m[1].toLowerCase();
      if (key === 'usero' || key === 'userd') userO = m[2];
      else if (key === 'passwordo' || key === 'passwordd') passwordO = m[2];
    }
    const machineName = positional[0] || this.getHostname();
    if (!userO) {
      return 'NETDOM RESET <MachineName> /Domain:<Domain> /UserO:<User> /PasswordO:<Password>';
    }
    const result = this.resetSecureChannel(userO, passwordO);
    if (!result.ok) return `${result.message}\nThe command failed to complete successfully.`;
    return `The secure channel from '${machineName}' to the domain has been reset.\nThe command completed successfully.`;
  }

  /**
   * `netdom resetpwd /Server:<DC> /UserD:<User> /PasswordD:<Password>`
   * (docs/PRD-Netdom.md §2.1 P3) — the DC-only variant of `reset` (P2):
   * repairs THIS server's own computer-account secure channel, dialing
   * a DIFFERENT DC (`/Server:`) than the one it would otherwise use,
   * which is the whole point when the usual DC is the one that's
   * unreachable/broken. Same underlying primitive as P2, not a second
   * mechanism.
   */
  private cmdNetdomResetpwd(args: string[]): string {
    let server = '';
    let userD = '';
    let passwordD = '';
    for (const arg of args) {
      const m = /^\/([a-z]+):(.*)$/i.exec(arg);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key === 'server') server = m[2];
      else if (key === 'userd') userD = m[2];
      else if (key === 'passwordd') passwordD = m[2];
    }
    if (!server || !userD) {
      return 'NETDOM RESETPWD /Server:<DC> /UserD:<User> /PasswordD:<Password>';
    }
    const result = this.resetSecureChannel(userD, passwordD, server);
    if (!result.ok) return `${result.message}\nThe command failed to complete successfully.`;
    return `The password has been set successfully.\nThe command completed successfully.`;
  }

  /**
   * `netdom remove <MachineName> /Domain:<Domain> /UserD:<User>
   * /PasswordD:<Password>` (docs/PRD-Netdom.md §2.1 P4) — unjoins this
   * machine via `removeFromDomain()` (real LDAP `DelRequest`, § 1.3).
   * Same limitation as `verify`/`reset`: only this machine's own
   * membership can be removed, `MachineName`/`/Domain:` are accepted
   * for syntax fidelity but not used to target a third machine.
   */
  private cmdNetdomRemove(args: string[]): string {
    let userD = '';
    let passwordD = '';
    for (const arg of args) {
      const m = /^\/([a-z]+):(.*)$/i.exec(arg);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key === 'userd') userD = m[2];
      else if (key === 'passwordd') passwordD = m[2];
    }
    if (!userD) {
      return 'NETDOM REMOVE <MachineName> /Domain:<Domain> /UserD:<User> /PasswordD:<Password>';
    }
    const result = this.removeFromDomain(userD, passwordD);
    if (!result.ok) return `${result.message}\nThe command failed to complete successfully.`;
    return `The computer '${this.getHostname()}' has been removed from the domain.\nThe command completed successfully.`;
  }

  /**
   * `netdom renamecomputer <MachineName> /NewName:<NewName>
   * [/UserD:<User> /PasswordD:<Password>]` (docs/PRD-Netdom.md §2.1 P5)
   * — renames this machine via `renameComputer()` (local + AD object).
   */
  private cmdNetdomRenameComputer(args: string[]): string {
    let newName = '';
    let userD = '';
    let passwordD = '';
    for (const arg of args) {
      const m = /^\/([a-z]+):(.*)$/i.exec(arg);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key === 'newname') newName = m[2];
      else if (key === 'userd') userD = m[2];
      else if (key === 'passwordd') passwordD = m[2];
    }
    if (!newName) {
      return 'NETDOM RENAMECOMPUTER <MachineName> /NewName:<NewName> [/UserD:<User> /PasswordD:<Password>]';
    }
    const result = this.renameComputer(newName, this.domainMembership ? { username: userD, password: passwordD } : undefined);
    if (!result.ok) return `${result.message}\nThe command failed to complete successfully.`;
    return `The computer name has been successfully changed to '${newName}'.\nThe command completed successfully.`;
  }

  /**
   * `netdom computername <MachineName> /Enumerate | /MakePrimary:<Name>`
   * (docs/PRD-Netdom.md §2.1 P6) — `/Enumerate` lists the single
   * primary name this simulator models (no alternate-name bookkeeping,
   * § 2.2 non-objective); `/MakePrimary` is a full rename, same
   * primitive as `renamecomputer` (P5).
   */
  private cmdNetdomComputerName(args: string[]): string {
    if (args.some(a => a.toLowerCase() === '/enumerate')) {
      return [`Primary name:  ${this.getHostname()}`, 'The command completed successfully.'].join('\n');
    }
    const makePrimary = args.find(a => /^\/makeprimary:/i.exec(a));
    if (!makePrimary) {
      return 'NETDOM COMPUTERNAME <MachineName> /Enumerate | /MakePrimary:<Name>';
    }
    const newName = makePrimary.slice(makePrimary.indexOf(':') + 1);
    let userD = '';
    let passwordD = '';
    for (const arg of args) {
      const m = /^\/([a-z]+):(.*)$/i.exec(arg);
      if (!m) continue;
      if (m[1].toLowerCase() === 'userd') userD = m[2];
      else if (m[1].toLowerCase() === 'passwordd') passwordD = m[2];
    }
    const result = this.renameComputer(newName, this.domainMembership ? { username: userD, password: passwordD } : undefined);
    if (!result.ok) return `${result.message}\nThe command failed to complete successfully.`;
    return `The primary computer name has been successfully changed to '${newName}'.\nThe command completed successfully.`;
  }

  /**
   * Le fuseau de la machine, pour `Get-TimeZone`/`Set-TimeZone`.
   *
   * Il n'y a PAS de second magasin : `EndHost` porte deja une
   * `SystemIdentity` qui tient le fuseau, et c'est celle que
   * `timedatectl` lit cote Linux. Cet accesseur ne fait que l'exposer,
   * parce que le champ est protege — sans quoi une machine Windows et
   * une machine Linux du meme laboratoire donneraient deux fuseaux
   * differents pour la meme configuration.
   */
  getTimezoneStore(): { readonly timezone: string; setTimezone(n: string): void } {
    return this.identity;
  }

  /** L'agent NTP de cette machine — le MEME moteur que Cisco et Linux. */
  private _ntpAgent: NtpAgent | null = null;
  getNtpAgent(): NtpAgent {
    if (!this._ntpAgent) {
      this._ntpAgent = new NtpAgent(this as unknown as NtpHost, () => this.getBus());
    }
    return this._ntpAgent;
  }

  /** Le service W32Time de cette machine (`PRD-NTP-Tutoriel.md` §5). */
  private _w32time: W32TimeService | null = null;
  getW32Time(): W32TimeService {
    if (!this._w32time) {
      this._w32time = new W32TimeService({
        ntp: () => this.getNtpAgent(),
        sourceDomaine: () => {
          const store = this.getDirectoryStore();
          const pdc = store?.getDomainFsmoRoleOwner('PDCEmulator') ?? '';
          return store && pdc ? `${pdc}.${store.dnsName}` : null;
        },
      });
    }
    return this._w32time;
  }

  /** Le nom de la source affichee : une adresse, un FQDN, ou l'horloge locale. */
  private w32Source(): string {
    const cfg = this.getNtpAgent().getConfig();
    if (cfg.refIdentifier && cfg.refIdentifier !== '.INIT.' && this.getNtpAgent().isSynced()) {
      return cfg.refIdentifier;
    }
    const w32 = this.getW32Time();
    if (w32.getFlags() === 'domhier') {
      const store = this.getDirectoryStore();
      const pdc = store?.getDomainFsmoRoleOwner('PDCEmulator') ?? '';
      if (store && pdc) return `${pdc}.${store.dnsName},0x9`;
    }
    const premier = w32.getPeers()[0];
    return premier ? `${premier.hote},${premier.drapeau}` : 'Local CMOS Clock';
  }

  /**
   * `w32tm` (`docs/PRD-NTP-Tutoriel.md` §5).
   *
   * La commande etait un talon d'une seule branche : toute sous-commande
   * autre que `/query /status` renvoyait la CHAINE LITTERALE
   * `w32tm /query /status`, et `/query /status` lui-meme etait un bloc
   * fixe ou `Stratum: 3` etait ecrit en dur sur une machine
   * n'interrogeant personne.
   */
  private cmdW32tm(args: string[]): string {
    const bas = args.map((a) => a.toLowerCase());
    const w32 = this.getW32Time();
    const agent = this.getNtpAgent();

    if (bas[0] === '/query') return this.cmdW32tmQuery(bas.slice(1));

    if (bas[0] === '/config') {
      const lire = (nom: string): string | undefined => {
        const a = args.find((x) => x.toLowerCase().startsWith(`/${nom}:`));
        return a?.slice(nom.length + 2).replace(/^"|"$/g, '');
      };
      const r = w32.configure({
        manualpeerlist: lire('manualpeerlist'),
        syncfromflags: lire('syncfromflags'),
        reliable: lire('reliable'),
        update: bas.includes('/update'),
      });
      if (r.ok === false) return `${r.erreur}\n\nThe command failed to complete successfully.`;
      return 'The command completed successfully.';
    }

    if (bas[0] === '/resync') {
      const r = w32.resync();
      if (r.ok === false) return `${r.erreur}\n\nThe command failed to complete successfully.`;
      return 'Sending resync command to local computer\nThe command completed successfully.';
    }

    if (bas[0] === '/stripchart') {
      const cible = args.find((a) => a.toLowerCase().startsWith('/computer:'))?.slice(10);
      if (!cible) return 'The parameter is incorrect.';
      const nEch = parseInt(
        args.find((a) => a.toLowerCase().startsWith('/samples:'))?.slice(9) ?? '5', 10);
      return this.w32Stripchart(cible, Number.isFinite(nEch) ? nEch : 5);
    }

    if (bas[0] === '/monitor') {
      // Elle interroge TOUS les controleurs du domaine : sans domaine,
      // le vrai outil le dit plutot que de rendre une liste vide.
      const store = this.getDirectoryStore();
      if (!store) return 'Error: 0x800706BA - The RPC server is unavailable.';
      const pdc = store.getDomainFsmoRoleOwner('PDCEmulator') ?? '';
      return [
        `${pdc}.${store.dnsName} *** PDC ***[${'127.0.0.1'}:123]:`,
        `    ICMP: 0ms delay`,
        `    NTP: +0.0000000s offset from ${pdc}.${store.dnsName}`,
        `        RefID: ${agent.getConfig().refIdentifier || 'LOCL'}`,
        `        Stratum: ${agent.getStratum()}`,
      ].join('\n');
    }

    return [
      'w32tm [/? | /register | /unregister ]',
      '      /query [/computer:<target>] {/source | /configuration | /peers | /status}',
      '      /config [/computer:<target>] [/update] [/manualpeerlist:<peers>]',
      '              [/syncfromflags:<source>] [/reliable:(YES|NO)]',
      '      /resync [/computer:<target>] [/nowait] [/rediscover] [/force]',
      '      /stripchart /computer:<target> [/samples:<count>]',
      '      /monitor [/domain:<domain>]',
    ].join('\n');
  }

  /** Les quatre formes de `w32tm /query`, chacune une vue distincte. */
  private cmdW32tmQuery(sous: string[]): string {
    const agent = this.getNtpAgent();
    const w32 = this.getW32Time();
    const cfg = agent.getConfig();
    const quoi = sous.find((s) => s.startsWith('/')) ?? '';

    if (quoi === '/source') return this.w32Source();

    if (quoi === '/peers') {
      const pairs = w32.getPeers();
      if (pairs.length === 0) return '#Peers: 0';
      const blocs = pairs.map((p) => {
        const a = agent.getAssociation(p.hote);
        const joignable = (a?.reach ?? 0) !== 0;
        return [
          `Peer: ${p.hote},${p.drapeau}`,
          `State: ${joignable ? 'Active' : 'Pending'}`,
          `Time Remaining: ${(a?.pollSec ?? 64).toFixed(7)}s`,
          `Mode: ${p.mode === 'peer' ? '1 (Symmetric Active)' : '3 (Client)'}`,
          `Stratum: ${a && joignable ? `${a.stratum} (secondary reference - syncd by (S)NTP)` : '0 (unspecified)'}`,
          `PeerPoll Interval: ${Math.round(Math.log2(a?.pollSec ?? 64))} (${a?.pollSec ?? 64}s)`,
          `HostPoll Interval: ${Math.round(Math.log2(a?.pollSec ?? 64))} (${a?.pollSec ?? 64}s)`,
        ].join('\n');
      });
      return [`#Peers: ${pairs.length}`, '', ...blocs].join('\n');
    }

    if (quoi === '/configuration') {
      return [
        '[Configuration]',
        '',
        `EventLogFlags: 2 (Local)`,
        `AnnounceFlags: ${w32.isReliable() ? '5' : '10'} (Local)`,
        `TimeJumpAuditOffset: 28800 (Local)`,
        `MinPollInterval: 6 (Local)`,
        `MaxPollInterval: 10 (Local)`,
        '',
        '[TimeProviders]',
        '',
        'NtpClient (Local)',
        `DllName: C:\\WINDOWS\\SYSTEM32\\w32time.DLL (Local)`,
        `Enabled: 1 (Local)`,
        `InputProvider: 1 (Local)`,
        `NtpServer: ${w32.getPeers().map((p) => `${p.hote},${p.drapeau}`).join(' ') || '(none)'} (Local)`,
        `Type: ${w32.getFlags().toUpperCase() === 'MANUAL' ? 'NTP' : 'NT5DS'} (Local)`,
      ].join('\n');
    }

    // `/status`, et le defaut.
    const best = [...cfg.associations.values()].find((a) => a.preferred);
    const synced = agent.isSynced();
    return [
      `Leap Indicator: 0(no warning)`,
      `Stratum: ${synced ? cfg.localStratum : 0} (${synced ? 'secondary reference - syncd by (S)NTP' : 'unspecified'})`,
      `Precision: -23 (119.209ns per tick)`,
      `Root Delay: ${((best ? Math.abs(best.delayMs) : 0) / 1000).toFixed(7)}s`,
      `Root Dispersion: ${((best ? best.dispersionMs : 0) / 1000).toFixed(7)}s`,
      `ReferenceId: ${w32ReferenceId(cfg.refIdentifier)}`,
      `Last Successful Sync Time: ${cfg.lastSyncMs ? new Date(cfg.lastSyncMs).toUTCString() : 'unspecified'}`,
      `Source: ${this.w32Source()}`,
      `Poll Interval: ${Math.round(Math.log2(best?.pollSec ?? 64))} (${best?.pollSec ?? 64}s)`,
    ].join('\n');
  }

  /**
   * `w32tm /stripchart` — mesurer l'ecart en direct.
   *
   * Chaque echantillon est une VRAIE interrogation : l'ecart imprime est
   * celui que l'agent vient de calculer, pas une suite de nombres
   * plausibles. Une cible injoignable donne la ligne d'erreur du vrai
   * outil, ce qui est le seul resultat utile d'un test de connectivite.
   */
  private w32Stripchart(cible: string, nEchantillons: number): string {
    const agent = this.getNtpAgent();
    const deja = agent.getAssociation(cible) !== undefined;
    if (!deja) agent.addServer(cible);
    const lignes = [
      `Tracking ${cible} [${cible}:123].`,
      `Collecting ${nEchantillons} samples.`,
      `The current time is ${new Date().toUTCString()}.`,
    ];
    for (let i = 0; i < nEchantillons; i++) {
      agent.pollAll();
      const a = agent.getAssociation(cible);
      const h = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      const heure = `${p(h.getUTCHours())}:${p(h.getUTCMinutes())}:${p(h.getUTCSeconds())}`;
      if (!a || a.reach === 0) {
        lignes.push(`${heure}, error: 0x800705B4 - This operation returned because the timeout period expired.`);
      } else {
        const s = a.offsetMs / 1000;
        lignes.push(`${heure}, ${s >= 0 ? '+' : '-'}${Math.abs(s).toFixed(7)}s`);
      }
    }
    if (!deja) agent.removeServer(cible);
    return lignes.join('\n');
  }

  /**
   * `netdom query {fsmo|pdc|dc|dclist|ou}` (docs/PRD-Netdom.md §2.1 P7 —
   * `pdc`/`dc`/`dclist`/`ou` are the extension, `fsmo` pre-existing) —
   * every form is read-only formatting on data already real elsewhere
   * (`Get-ADDomain`/`Get-ADDomainController`/`Get-ADOrganizationalUnit`),
   * no second data collection.
   */
  private cmdNetdomQuery(args: string[]): string {
    const mode = args[0]?.toLowerCase();
    if (mode === 'fsmo') return this.cmdNetdomQueryFsmo();
    if (mode === 'pdc') return this.cmdNetdomQueryPdc();
    if (mode === 'dc' || mode === 'dclist') return this.cmdNetdomQueryDc();
    if (mode === 'ou') return this.cmdNetdomQueryOu();
    return 'NETDOM QUERY {FSMO | PDC | DC | DCLIST | OU}';
  }

  /** `netdom query fsmo` — the 5 real FSMO role owners, server-only (a plain workstation has no directory to query). */
  private cmdNetdomQueryFsmo(): string {
    const store = this.getDirectoryStore();
    if (!store) return 'This computer is not a domain controller.\nThe command failed to complete successfully.';
    const server_ = this as unknown as { getForest?: () => { getFsmoRoles(): { schemaMaster: string; domainNamingMaster: string } } | null };
    const forest = server_.getForest?.();
    const fqdn = (short: string) => short ? `${short}.${store.dnsName}` : '';
    const forestFsmo = forest?.getFsmoRoles() ?? { schemaMaster: '', domainNamingMaster: '' };
    return [
      `Schema owner          ${fqdn(forestFsmo.schemaMaster)}`,
      `Domain role owner     ${fqdn(forestFsmo.domainNamingMaster)}`,
      `PDC                   ${fqdn(store.getDomainFsmoRoleOwner('PDCEmulator'))}`,
      `RID pool manager      ${fqdn(store.getDomainFsmoRoleOwner('RIDMaster'))}`,
      `Infrastructure        ${fqdn(store.getDomainFsmoRoleOwner('InfrastructureMaster'))}`,
      'The command completed successfully.',
    ].join('\n');
  }

  /** `netdom query pdc` — the domain's PDC Emulator FQDN. */
  private cmdNetdomQueryPdc(): string {
    const store = this.getDirectoryStore();
    if (!store) return 'This computer is not a domain controller.\nThe command failed to complete successfully.';
    const pdc = store.getDomainFsmoRoleOwner('PDCEmulator');
    return [pdc ? `${pdc}.${store.dnsName}` : '', 'The command completed successfully.'].join('\n');
  }

  /** `netdom query dc`/`netdom query dclist` — every DC known to the local domain's directory. */
  private cmdNetdomQueryDc(): string {
    const store = this.getDirectoryStore();
    if (!store) return 'This computer is not a domain controller.\nThe command failed to complete successfully.';
    const dcs = store.listDomainControllers();
    return [
      `List of domain controllers with accounts in the domain:`,
      ...dcs.map(dc => dc.name),
      'The command completed successfully.',
    ].join('\n');
  }

  /** `netdom query ou` — every organizational unit in the local domain's directory. */
  private cmdNetdomQueryOu(): string {
    const store = this.getDirectoryStore();
    if (!store) return 'This computer is not a domain controller.\nThe command failed to complete successfully.';
    const ous = store.listOrgUnits();
    return [
      `List of OUs in the domain:`,
      ...ous.map(ou => ou.dn),
      'The command completed successfully.',
    ].join('\n');
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
    const deviceEnv = this.getEnvVars();
    const user = init?.user ?? (deviceEnv.get('USERNAME') ?? 'User');
    const profile = deviceEnv.get('USERPROFILE') ?? 'C:\\Users\\User';
    const env = new Map(init?.env ?? deviceEnv);
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
    if (direction === 'forward') return 'accept';
    const facts = this.firewallFactsFor(ipPkt, direction);
    const matching = [...this.firewallRules.values()].filter(r => firewallRuleMatches(r, facts));
    for (const rule of matching) {
      if (rule.action !== 'Block') continue;
      this.getBus().publish({
        topic: 'windows.firewall.drop',
        payload: {
          deviceId: this.id, hostname: this.getHostname(),
          ruleName: rule.name,
          sourceIp: ipPkt.sourceIP.toString(),
          destinationIp: ipPkt.destinationIP.toString(),
          sourcePort: facts.direction === 'Inbound' ? facts.remotePort : facts.localPort,
          destinationPort: facts.direction === 'Inbound' ? facts.localPort : facts.remotePort,
          protocol: rule.protocol, direction: facts.direction,
        },
      });
      return 'drop';
    }
    return 'accept';
  }

  private firewallFactsFor(ipPkt: IPv4Packet, direction: 'in' | 'out'): FirewallPacketFacts {
    const ports = this.extractPorts(ipPkt);
    const inbound = direction === 'in';
    return {
      direction: inbound ? 'Inbound' : 'Outbound',
      protocolNumber: ipPkt.protocol,
      localAddress: inbound ? ipPkt.destinationIP : ipPkt.sourceIP,
      remoteAddress: inbound ? ipPkt.sourceIP : ipPkt.destinationIP,
      localPort: inbound ? ports.dstPort : ports.srcPort,
      remotePort: inbound ? ports.srcPort : ports.dstPort,
      profile: 'Any',
    };
  }
}
