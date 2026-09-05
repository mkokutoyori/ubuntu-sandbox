/**
 * WindowsPSProviders — Device-backed implementation of PSProviders.
 *
 * Wraps a WindowsPC's managers (filesystem, services, processes, users) so the
 * PSInterpreter can read/write the same simulated state as the rest of the
 * device (and as the legacy PowerShellExecutor). Phase 1 of the executor →
 * interpreter migration: this lets the interpreter access device state via
 * its existing PSProviders DI bag instead of going through the legacy
 * string-based PowerShellExecutor.
 *
 * Network / event-log surfaces are partial — only the calls needed by the
 * core cmdlets that are already migrated. The rest throw `NotImplemented`
 * which the cmdlet layer treats as a fallback signal.
 */


import type { WindowsPC } from '@/network/devices/WindowsPC';
import type { ServiceStartType } from '@/network/devices/windows/WindowsServiceManager';
import type { WindowsServer } from '@/network/devices/WindowsServer';
import type { DirectoryStore } from '@/network/devices/windows/server/ad/DirectoryStore';
import { MAIL_FOLDER_NAMES, type Mailbox as MailboxRecord } from '@/network/devices/windows/server/exchange/MailboxStore';
import { domainOf } from '@/network/smtp/relay';
import { RemoteAccessVpnClient } from '@/network/ipsec/RemoteAccessVpnClient';
import { PSRegistryProvider, WINDOWS_CLIENT_PRODUCT_IDENTITY, WINDOWS_SERVER_PRODUCT_IDENTITY } from '@/network/devices/windows/PSRegistryProvider';
import { PSEventLogProvider } from '@/network/devices/windows/PSEventLogProvider';
import {
  LOOPBACK_IFINDEX, adapterIfIndex, toDisplayName, toPortName, formatLinkSpeedMbps,
} from '@/network/devices/windows/WindowsInterfaceNaming';
import { NO_MATCHING_INTERFACE } from '@/network/devices/windows/netIpAddress';
import { type DnsCacheRow, dnsCacheRowsOf } from '@/network/devices/windows/dnsClientCache';
import { resolveAdapter, resolveAdapterPortName } from '@/network/devices/windows/netAdapter';
import {
  memberFailureReason, memberStatus, normaliseAdminMode, normaliseLacpTimer,
  normaliseLbAlgorithm, normaliseTeamingMode, teamStatus, type TeamMember,
} from '@/network/devices/windows/WindowsNicTeam';
import { IPAddress, IPv6Address, MACAddress, SubnetMask } from '@/network/core/types';
import type { NetNeighborPlan, NetNeighborState } from '@/network/devices/windows/netNeighbor';
import { isValidIPv4 } from '@/network/core/ip';
import { findHostByAddress } from '@/network/devices/linux/network/HostLookup';
import { discoverDcHostname, rootDnOf } from '@/network/devices/windows/domain/DcHostnameDiscovery';
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import type { PSScriptBlock } from '@/powershell/parser/PSASTNode';

/**
 * Map a Port's IPv4 provenance to the Windows PrefixOrigin/SuffixOrigin pair
 * reported by Get-NetIPAddress. The RFC 3927 link-local fallback (APIPA) is
 * WellKnown/Link, matching a real host that failed to reach a DHCP server.
 */
function mapV4Origin(origin: 'manual' | 'dhcp' | 'link-local'): { prefixOrigin: string; suffixOrigin: string } {
  switch (origin) {
    case 'dhcp':       return { prefixOrigin: 'Dhcp', suffixOrigin: 'Dhcp' };
    case 'link-local': return { prefixOrigin: 'WellKnown', suffixOrigin: 'Link' };
    default:           return { prefixOrigin: 'Manual', suffixOrigin: 'Manual' };
  }
}
import { JobProvider } from '@/powershell/providers/JobProvider';
import { generateSelfSignedCertificate } from '@/network/pki/SelfSignedCertificate';
import { WINDOWS_LOOPBACK_ROUTES, LOOPBACK_IFALIAS } from '@/network/devices/windows/WindowsLoopbackRoutes';
import type {
  PSProviders,
  IFileSystemProvider, IRegistryProvider, IServiceProvider,
  INetworkProvider, IProcessProvider, IUserProvider, IEventLogProvider,
  IVpnProvider, IScheduledTaskProvider, IDiskProvider, IEnvironmentProvider,
  IRemotingProvider, IRemoteComputer,
  IRoleProvider, WindowsFeatureInfo,
  ISmbProvider, SmbShareInfo, SmbSessionInfo,
  IAdProvider, AdUserInfo, AdGroupInfo, AdComputerInfo, AdOrgUnitInfo, AdOpResult, AdSiteInfo,
  AdSubnetInfo, AdSiteLinkInfo, AdUpToDatenessVectorRowInfo,
  AdKdsRootKeyInfo, AdServiceAccountInfo,
  AdGenericObjectInfo, AdOptionalFeatureInfo, AddGroupMemberOptions, AdMemberLink, NetIPAddressOptions, NetIPAddressUpdate, NetRouteAttributes,
  AdAttributeSchemaInfo, AdObjectClassSchemaInfo, AdForestInfo, AdDomainInfo, AdTrustInfo,
  AdReplicationConnectionInfo, AdReplicationFailureInfo, AdPasswordPolicyInfo, AdFineGrainedPasswordPolicyInfo, AdAccessRuleInfo,
  IComputerProvider, DomainMembershipInfo,
  IGpoProvider, GpoInfo, GpLinkOptions, GpoLinkResultInfo,
  IIisProvider, IisOpResult, WebsiteInfo, AppPoolInfo, NewAppPoolOptions, WebModuleInfo,
  IExchangeProvider, ExchangeOpResult, ExchangeServerInfo,
  MailboxOpResult, MailboxInfo, MailboxStatisticsInfo, MailFolderName,
  DistributionGroupInfo, GalEntryInfo, ReceiveConnectorInfo, SendConnectorInfo, TransportRuleInfo, QueueInfo, MailboxDatabaseCopyInfo,
  ServiceHealthCheckInfo, MailflowTestResultInfo,
  IAdcsProvider, AdcsOpResult, CaTemplateInfo, CertificateRequestResultInfo,
  IPkiProvider, IssuedCertInfo,
  IDfsProvider, DfsOpResult, DfsTargetInfo, DfsFolderInfo, DfsrSyncResultInfo,
  DfsReferralPriorityClassInfo, DfsrGroupInfoView, DfsrMembershipInfoView,
  IRdpProvider, RdpOpResult, RdpSessionInfo,
  IClusterProvider, ClusterOpResult, ClusterNodeInfo, ClusterPeerInfo, ClusterGroupInfo,
  IWsusProvider, WsusOpResult, WsusUpdateInfo, WsusApprovalActionInfo,
  IWindowsUpdateProvider,
  IPrintProvider, PrintOpResult, PrintJobInfo,
  ILicensingProvider, LicenseStateInfo,
  IDnsServerProvider, DnsOpResult, DnsZoneInfo, DnsRecordInfo, DnsDynamicUpdateMode,
  IDhcpServerProvider, DhcpOpResult, DhcpScopeInfo, DhcpLeaseInfo,
  INpsProvider, NpsOpResult, NasClientInfo, NetworkPolicyInfo,
  ConnectionRequestPolicyConditionsInfo, ConnectionRequestPolicyInfo,
  DirEntry, ServiceInfo, ProcessInfo, UserInfo, GroupInfo,
  NetAdapterEntry, AdapterStatisticsInfo, IPAddressInfo, RouteInfo, EventLogEntryInfo,
  NicTeamInfo, NicTeamMemberInfo, NicTeamNicInfo, NewNicTeamRequest, SetNicTeamRequest,
  VpnConnectionInfo, ScheduledTaskInfo, DiskInfo, VolumeInfo,
  NeighborInfo,
} from '@/powershell/providers/PSProviders';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { AddsForestOptions } from '@/network/devices/windows/server/ad/adFunctionalLevels';
import type { GroupWriteOptions, OrgUnitWriteOptions, UserWriteOptions } from '@/network/devices/windows/server/ad/DirectoryStore';
import type { AdGroup, AdUser } from '@/network/devices/windows/server/ad/AdTypes';
import { withRemoteDirectory } from './adRemoteDirectory';
import { MEMBER_ALREADY_IN_GROUP, MEMBER_NOT_IN_GROUP, groupTypeValue } from '@/network/devices/windows/server/ad/adGroup';
import { PRIVILEGED_ACCESS_MANAGEMENT_FEATURE, TTL_WITHOUT_PAM_FEATURE } from '@/network/devices/windows/server/ad/adOptionalFeatures';
import type { RemoteDirectoryHost, RemoteDirectoryTarget } from './adRemoteDirectory';
import type { LdapClient } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import type { TcpStack } from '@/network/tcp/TcpStack';
import type { NetIPAddressEntry } from '@/network/devices/windows/netIpAddress';
import {
  type NetRouteEntry, type NetRouteIdentity, type NetRouteUpdate,
  UNSPECIFIED_NEXT_HOP, netRouteKey,
} from '@/network/devices/windows/netRoute';
import {
  type NetFirewallRuleEntry, firewallRuleKey,
} from '@/network/devices/windows/netFirewallRule';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function defaultNamingContextOf(client: LdapClient): string | null {
  const dse = client.search('', 'base', { kind: 'present', attr: 'objectClass' }, ['defaultNamingContext']);
  const value = dse.entries[0]?.attributes.find(a => a.type.toLowerCase() === 'defaultnamingcontext')?.values[0];
  return value ?? null;
}

function groupInfoOf(g: AdGroup): AdGroupInfo {
  return {
    sam: g.sam, dn: g.dn, name: g.name, scope: g.scope, category: g.category,
    properties: { ...g.properties }, members: [...g.members],
  };
}

function userInfoOf(u: AdUser): AdUserInfo {
  return {
    sam: u.sam, upn: u.upn, dn: u.dn, sid: u.sid, enabled: u.enabled, memberOf: u.memberOf, fullName: u.fullName,
    department: u.department, title: u.title, emailAddress: u.emailAddress, passwordLastSet: u.passwordLastSet,
    passwordNeverExpires: u.passwordNeverExpires, servicePrincipalNames: u.servicePrincipalNames,
    profilePath: u.profilePath, homeDirectory: u.homeDirectory, homeDrive: u.homeDrive,
    properties: { ...u.properties }, flags: { ...u.flags },
    accountExpirationDate: u.accountExpirationDate,
    cannotChangePassword: u.cannotChangePassword, changePasswordAtLogon: u.changePasswordAtLogon,
  };
}

// ── Filesystem adapter ────────────────────────────────────────────────────

/**
 * `WindowsFileSystem` rend les mots de Win32, ceux que `cd`, `copy` et
 * `type` affichent. PowerShell, lui, remonte l'exception .NET du
 * fournisseur, et ce sont deux libelles differents pour un meme fait :
 * `DirectoryNotFoundException` dit « Could not find a part of the path
 * '<chemin>'. » et `FileNotFoundException` « Could not find file
 * '<chemin>'. ». La traduction se fait ICI, a la frontiere entre les
 * deux mondes, plutot que dans chaque applet.
 */
function dotNetIoMessage(absPath: string, win32Error: string | undefined): string {
  if (win32Error === 'The system cannot find the path specified.') {
    return `Could not find a part of the path '${absPath}'.`;
  }
  if (win32Error === 'The system cannot find the file specified.') {
    return `Could not find file '${absPath}'.`;
  }
  return win32Error ?? `Could not find a part of the path '${absPath}'.`;
}

class WindowsFileSystemAdapter implements IFileSystemProvider {
  constructor(private readonly pc: WindowsPC) {}

  private fs() { return this.pc.getFileSystem(); }

  exists(path: string): boolean {
    return this.fs().exists(this.abs(path));
  }
  readFile(path: string): string {
    const abs = this.abs(path);
    const r = this.fs().readFile(abs);
    if (!r.ok) throw new Error(dotNetIoMessage(abs, r.error));
    this.pc.auditObjectAccess?.(abs, 'ReadData', '%%4416');
    return r.content ?? '';
  }
  tailFile(path: string, lines: number): string[] {
    const all = this.readFile(path).split(/\r?\n/);
    return all.slice(Math.max(0, all.length - lines));
  }
  writeFile(path: string, content: string): void {
    const abs = this.abs(path);
    const r = this.fs().createFile(abs, content);
    if (!r.ok) throw new Error(dotNetIoMessage(abs, r.error));
  }
  appendFile(path: string, content: string): void {
    const abs = this.abs(path);
    if (!this.fs().exists(abs)) {
      this.writeFile(path, content);
      return;
    }
    const r = this.fs().appendFile(abs, content);
    if (!r.ok) throw new Error(dotNetIoMessage(abs, r.error));
  }
  listDir(path: string): DirEntry[] {
    const entries = this.fs().listDirectory(this.abs(path));
    return entries.map(e => ({
      name: e.name,
      isDirectory: e.entry.type === 'directory',
      size: e.entry.size,
      mtime: e.entry.mtime,
      attributes: new Set(e.entry.attributes),
      owner: e.entry.owner,
    }));
  }
  createFile(path: string): void {
    this.writeFile(path, '');
  }
  createDir(path: string): void {
    this.fs().mkdirp(this.abs(path));
  }
  remove(path: string, recurse: boolean): void {
    const abs = this.abs(path);
    if (this.fs().isDirectory(abs)) {
      const r = recurse
        ? this.fs().rmdirRecursive(abs)
        : this.fs().rmdir(abs);
      if (!r.ok) throw new Error(r.error ?? `Cannot remove ${path}`);
    } else {
      // L'audit précède la suppression : après, il n'y a plus d'objet
      // dont lire la SACL.
      this.pc.auditObjectAccess?.(abs, 'Delete', '%%1537');
      const r = this.fs().deleteFile(abs);
      if (!r.ok) throw new Error(r.error ?? `Cannot remove ${path}`);
    }
  }
  copy(src: string, dest: string): void {
    const r = this.fs().copyFile(this.abs(src), this.abs(dest));
    if (!r.ok) throw new Error(r.error ?? `Cannot copy`);
  }
  move(src: string, dest: string): void {
    const r = this.fs().moveFile(this.abs(src), this.abs(dest));
    if (!r.ok) throw new Error(r.error ?? `Cannot move`);
  }
  normalizePath(path: string, cwd: string): string {
    return this.fs().normalizePath(path, cwd);
  }
  getCwd(): string {
    return this.pc.getCwd();
  }
  setCwd(path: string): void {
    this.pc.setCwd(this.abs(path));
  }
  isDirectory(path: string): boolean {
    return this.fs().isDirectory(this.abs(path));
  }
  getAcl(path: string) {
    const e = this.fs().resolve(this.abs(path));
    if (!e) return null;
    return {
      owner: e.owner,
      acl: e.acl.map(a => ({ principal: a.principal, type: a.type, permissions: [...a.permissions] })),
    };
  }
  setOwner(path: string, owner: string): boolean {
    return this.fs().setOwner(this.abs(path), owner);
  }
  addAce(path: string, ace: { principal: string; type: 'allow' | 'deny'; permissions: string[] }): boolean {
    const abs = this.abs(path);
    const before = JSON.stringify(this.fs().getACL(abs));
    const ok = this.fs().addACE(abs, { ...ace });
    if (ok && JSON.stringify(this.fs().getACL(abs)) !== before) {
      this.pc.auditPermissionChange?.(abs, ace.principal, ace.permissions.join(', '));
    }
    if (ok) {
      this.pc.getBus().publish({
        topic: 'windows.filesystem.acl-changed',
        payload: {
          deviceId: this.pc.id,
          path: abs,
          identity: ace.principal,
          permissions: ace.permissions.join(', '),
          changedBy: this.pc.getUserManager().currentUser,
        },
      });
    }
    return ok;
  }
  getAudit(path: string) {
    return this.fs().getSacl(this.abs(path));
  }
  setAudit(path: string, rules: Array<{ principal: string; flags: Array<'success' | 'failure'>; permissions: string[] }>): boolean {
    const abs = this.abs(path);
    const before = JSON.stringify(this.fs().getSacl(abs));
    const ok = this.fs().setSacl(abs, rules);
    // 4670 ne se déclenche que si le descripteur a *changé* : appliquer
    // deux fois la même SACL ne modifie rien, et l'annoncer serait
    // exactement le genre d'affirmation sans fondement qu'on traque.
    if (ok && JSON.stringify(this.fs().getSacl(abs)) !== before) {
      this.pc.auditPermissionChange?.(abs, rules.map((r) => r.principal).join(', '),
        `SACL: ${rules.map((r) => r.permissions.join('/')).join(', ')}`);
    }
    return ok;
  }
  setAclProtected(path: string, isProtected: boolean): boolean {
    const e = this.fs().resolve(this.abs(path));
    if (!e) return false;
    e.aclProtected = isProtected;
    return true;
  }

  private abs(p: string): string {
    return this.fs().normalizePath(p, this.pc.getCwd());
  }
}

// ── Service adapter ────────────────────────────────────────────────────────

class WindowsServiceAdapter implements IServiceProvider {
  constructor(private readonly pc: WindowsPC) {}

  private mgr() { return this.pc.getServiceManager(); }
  private isAdmin(): boolean { return this.pc.getUserManager().isCurrentUserAdmin(); }

  listServices(nameFilter?: string): ServiceInfo[] {
    const all = this.mgr().getAllServices();
    const filtered = nameFilter
      ? all.filter(s => s.name.toLowerCase().includes(nameFilter.toLowerCase()))
      : all;
    return filtered.map(s => toServiceInfo(s, this.mgr(), this.pc.getProcessManager()));
  }
  getService(name: string): ServiceInfo | null {
    const s = this.mgr().getService(name);
    return s ? toServiceInfo(s, this.mgr(), this.pc.getProcessManager()) : null;
  }
  startService(name: string): string {
    const msg = this.mgr().startService(name, this.isAdmin());
    if (!msg) {
      const svc = this.mgr().getService(name);
      if (svc) this.pc.getProcessManager().onServiceStarted(svc.name, svc.processName);
    }
    return msg;
  }
  stopService(name: string, force?: boolean): string {
    const admin = this.isAdmin();
    if (force) {
      return this.mgr().stopServiceCascade(name, admin, svc => this.pc.getProcessManager().onServiceStopped(svc.name));
    }
    const msg = this.mgr().stopService(name, admin);
    if (!msg) this.pc.getProcessManager().onServiceStopped(name);
    return msg;
  }
  restartService(name: string, force?: boolean): string {
    const admin = this.isAdmin();
    const stopRes = force
      ? this.mgr().stopServiceCascade(name, admin, svc => this.pc.getProcessManager().onServiceStopped(svc.name))
      : this.stopService(name);
    // Real PowerShell Restart-Service tolerates a pre-stopped target: it
    // just starts it. Only abort on permission errors or "service not found".
    if (stopRes && /denied|does not exist/i.test(stopRes)) return stopRes;
    return this.startService(name);
  }
  setService(name: string, opts: { startType?: string; description?: string; displayName?: string; status?: string }): string {
    const admin = this.isAdmin();
    const m = this.mgr();
    const msgs: string[] = [];
    // normalizeStartupType (ServiceCmdlets.ts) maps known -StartupType values
    // onto ServiceStartType and passes unrecognized input through verbatim -
    // setStartType itself does no runtime validation either (pre-existing).
    if (opts.startType)   msgs.push(m.setStartType(name, opts.startType as ServiceStartType, admin));
    if (opts.displayName) msgs.push(m.setDisplayName(name, opts.displayName, admin));
    if (opts.description) msgs.push(m.setDescription(name, opts.description, admin));
    if (opts.status === 'Running') msgs.push(m.startService(name, admin));
    if (opts.status === 'Stopped') msgs.push(m.stopService(name, admin));
    return msgs.filter(Boolean).join('\n');
  }
  suspendService(name: string): string {
    return this.mgr().pauseService(name, this.isAdmin());
  }
  resumeService(name: string): string {
    return this.mgr().resumeService(name, this.isAdmin());
  }
  newService(name: string, opts: { binaryPath: string; displayName?: string; startType?: string; description?: string; dependsOn?: string[] }): string {
    return this.mgr().createService(name, {
      binaryPath: opts.binaryPath,
      displayName: opts.displayName ?? name,
      startType: (opts.startType as ServiceStartType) ?? 'Manual',
      description: opts.description ?? '',
      dependencies: opts.dependsOn ?? [],
    }, this.isAdmin(), this.pc.getUserManager().currentUser);
  }
  removeService(name: string): string {
    return this.mgr().deleteService(name, this.isAdmin());
  }
  registerInstanceWatcher(serviceName: string, cb: (evt: { previousState: string; newState: string; timestamp: Date }) => void): string {
    return this.mgr().registerInstanceWatcher(serviceName, cb);
  }
  unregisterInstanceWatcher(id: string): void {
    this.mgr().unregisterInstanceWatcher(id);
  }
}

// ── Role adapter (Server Manager — WindowsServer only) ─────────────────────

class WindowsRoleAdapter implements IRoleProvider {
  constructor(private readonly pc: WindowsPC) {}

  private mgr() { return this.pc.getRoleManager()!; }
  private isAdmin(): boolean { return this.pc.getUserManager().isCurrentUserAdmin(); }

  listFeatures(): WindowsFeatureInfo[] { return this.mgr().listFeatures(); }
  getFeature(name: string): WindowsFeatureInfo | null { return this.mgr().getFeature(name); }
  isInstalled(name: string): boolean { return this.mgr().isInstalled(name); }
  installFeature(name: string, opts?: { includeManagementTools?: boolean; whatIf?: boolean }) {
    return this.mgr().install(name, opts, this.isAdmin());
  }
  uninstallFeature(name: string) {
    return this.mgr().uninstall(name, this.isAdmin());
  }
}

// ── SMB adapter (Server Manager — WindowsServer only, gated on FS-FileServer) ──

class WindowsSmbAdapter implements ISmbProvider {
  constructor(private readonly pc: WindowsPC) {}

  /** `New-SmbShare`/`Remove-SmbShare` only exist once the FS-FileServer role is installed (PRD-Windows-Server.md §8 acceptance criterion 2) — checked live on every call. `Get-SmbShare`/`Get-SmbSession` (and `net share`) are not gated this way, matching real Windows. */
  private requireRole(): void {
    if (!this.pc.getRoleManager()?.isInstalled('FS-FileServer')) {
      throw new Error(commandNotFoundMessage('New-SmbShare'));
    }
  }

  private toShareInfo(view: { name: string; path: string; description: string; special: boolean }): SmbShareInfo {
    return { name: view.name, path: view.path, description: view.description, special: view.special };
  }

  listShares(): SmbShareInfo[] {
    return this.pc.smbShares.list().map(s => this.toShareInfo(this.pc.smbShares.toView(s)));
  }
  getShare(name: string): SmbShareInfo | null {
    const s = this.pc.smbShares.get(name);
    return s ? this.toShareInfo(this.pc.smbShares.toView(s)) : null;
  }
  newShare(name: string, path: string, opts?: { fullAccess?: string[]; changeAccess?: string[]; readAccess?: string[] }) {
    this.requireRole();
    const permissions = new Map<string, 'Full' | 'Change' | 'Read'>();
    for (const p of opts?.fullAccess ?? []) permissions.set(p, 'Full');
    for (const p of opts?.changeAccess ?? []) permissions.set(p, 'Change');
    for (const p of opts?.readAccess ?? []) permissions.set(p, 'Read');
    if (permissions.size === 0) permissions.set('Everyone', 'Read');
    const res = this.pc.smbShares.add(name, path, { permissions });
    // 5142 — « un objet de partage réseau a été ajouté ». C'est
    // l'événement de la *création* ; 5140 est celui de l'*accès*, et les
    // confondre revient à croire qu'un partage créé a déjà été utilisé.
    if (res.ok) this.pc.auditShareAdded?.(name, path);
    return res;
  }
  removeShare(name: string) {
    this.requireRole();
    return this.pc.smbShares.remove(name);
  }
  listSessions(): SmbSessionInfo[] {
    return this.pc.smbSessions.list().map(s => this.pc.smbSessions.toView(s));
  }
}

// ── AD DS adapter (Server Manager — WindowsServer only, gated on AD-Domain-Services) ──

class WindowsAdAdapter implements IAdProvider {
  constructor(private readonly pc: WindowsPC) {}

  private remoteHost(): RemoteDirectoryHost {
    const pc = this.pc as unknown as {
      getTcpStack(): TcpStack;
      resolveHostnameSync(name: string): IPAddress | null;
    };
    return {
      tcpStack: () => pc.getTcpStack(),
      resolveAddress: (name: string) => IPAddress.tryParse(name) ?? pc.resolveHostnameSync(name),
    };
  }

  private remoteDirectory(
    cmdletName: string, target: RemoteDirectoryTarget,
    work: (client: LdapClient) => AdOpResult,
  ): AdOpResult {
    const res = withRemoteDirectory(this.remoteHost(), target, cmdletName, work);
    return res.value ?? { ok: false, message: res.failure ?? `${cmdletName} : Unable to contact the server.` };
  }

  /** `Get/New/Set/Remove-AD*` only exist once the AD-Domain-Services role is installed — checked live, matching `WindowsSmbAdapter`'s FS-FileServer gate. */
  private requireRole(cmdletName: string): void {
    if (!this.pc.getRoleManager()?.isInstalled('AD-Domain-Services')) {
      throw new Error(commandNotFoundMessage(cmdletName));
    }
  }

  /** Most AD cmdlets additionally need this server to actually be a promoted DC (`Install-ADDSForest` succeeded) — the real error a real DC-less member gets is a domain-controller-locator failure. */
  private requireStore(cmdletName: string) {
    this.requireRole(cmdletName);
    const store = this.pc.getDirectoryStore();
    if (!store) throw new Error(`${cmdletName} : Unable to find a default server with Active Directory Web Services running.`);
    return store;
  }

  private isAdmin(): boolean { return this.pc.getUserManager().isCurrentUserAdmin(); }
  private requireAdmin(cmdletName: string): AdOpResult | null {
    return this.isAdmin() ? null : { ok: false, message: `${cmdletName} : Access is denied.` };
  }

  installForest(domainName: string, netbiosName: string | undefined, safeModeAdminPassword: string, opts?: AddsForestOptions): AdOpResult {
    this.requireRole('Install-ADDSForest');
    const denied = this.requireAdmin('Install-ADDSForest');
    if (denied) return denied;
    const server = this.pc as WindowsServer;
    if (typeof server.installADDSForest !== 'function') {
      return { ok: false, message: 'Install-ADDSForest : This computer cannot be promoted to a domain controller.' };
    }
    return server.installADDSForest(domainName, netbiosName, safeModeAdminPassword, opts);
  }

  isForestInstalled(): boolean {
    this.requireRole('Get-ADDomain');
    return this.pc.getDirectoryStore() !== null;
  }

  installDomainController(
    domainName: string, netbiosName: string | undefined, sourceDcAddress: string,
    credentialUser: string, credentialPassword: string, safeModeAdminPassword: string,
    opts?: { installDns?: boolean },
  ): AdOpResult {
    this.requireRole('Install-ADDSDomainController');
    const denied = this.requireAdmin('Install-ADDSDomainController');
    if (denied) return denied;
    const server = this.pc as WindowsServer;
    if (typeof server.installADDSDomainController !== 'function') {
      return { ok: false, message: 'Install-ADDSDomainController : This computer cannot be promoted to a domain controller.' };
    }
    return server.installADDSDomainController(domainName, netbiosName, sourceDcAddress, credentialUser, credentialPassword, safeModeAdminPassword, opts);
  }

  listDomainControllers(): AdComputerInfo[] {
    const store = this.requireStore('Get-ADDomainController');
    const selfName = this.pc.getHostname().toLowerCase();
    const selfIface = this.pc.getInterfaces().find(p => p.getIPAddress() !== null);
    const selfIp = selfIface?.getIPAddress()?.toString() ?? null;
    return store.listDomainControllers().map(c => {
      // The local DC's own address is always known directly; every other
      // DC's is read from its recorded site assignment (`ipForDc` —
      // DNS isn't replicated between DCs here, see forest/sites.ts header).
      const ip = c.name.toLowerCase() === selfName ? selfIp : store.ipForDc(c.name);
      const site = store.siteForDc(c.name) ?? (ip ? store.siteForIp(ip) : null);
      return { name: c.name, dn: c.dn, enabled: c.enabled, servicePrincipalNames: c.servicePrincipalNames, site, ipv4Address: ip };
    });
  }

  /** `Get-ADReplicationUpToDatenessVectorTable -Target <dc>` — this (local) DC's own view of how far it has absorbed each replication partner's changes: one row per partner it has ever successfully pulled from, keyed by that partner's own USN as last observed here (`highestKnownUsnFor`, the same source `repadmin`'s `usnForInvocation` reads). */
  listUpToDatenessVector(): AdUpToDatenessVectorRowInfo[] {
    const store = this.requireStore('Get-ADReplicationUpToDatenessVectorTable');
    const server = this.pc as WindowsServer;
    const byPartnerInvocation = new Map<string, { partnerAddress: string; remoteInvocationId: string; lastSuccess: number }>();
    for (const e of server.getReplicationSignals().log.get()) {
      if ((e.direction ?? 'inbound') !== 'inbound' || !e.ok || !e.remoteInvocationId) continue;
      const existing = byPartnerInvocation.get(e.remoteInvocationId);
      if (!existing || e.timestamp > existing.lastSuccess) {
        byPartnerInvocation.set(e.remoteInvocationId, { partnerAddress: e.partnerAddress, remoteInvocationId: e.remoteInvocationId, lastSuccess: e.timestamp });
      }
    }
    return [...byPartnerInvocation.values()].map(entry => ({
      server: store.dcForIp(entry.partnerAddress) ?? entry.partnerAddress,
      usnFilter: store.highestKnownUsnFor(entry.remoteInvocationId),
      lastReplicationSuccess: new Date(entry.lastSuccess * 1000).toUTCString(),
    }));
  }

  listReplicationConnections(): AdReplicationConnectionInfo[] {
    const store = this.requireStore('Get-ADReplicationConnection');
    const server = this.pc as WindowsServer;
    const selfName = server.getHostname().toLowerCase();
    return store.listDomainControllers()
      .filter(c => c.name.toLowerCase() !== selfName)
      .map(c => ({
        name: `${c.name}-connection`,
        autoGenerated: true,
        replicateFromDirectoryServer: `${c.name}.${store.dnsName}`,
        interSiteTransportProtocol: 'RPC',
      }));
  }

  private toPolicyInfo(p: { minPasswordLength?: number; passwordHistoryLength?: number; maxPasswordAge?: number; minPasswordAge?: number; lockoutThreshold?: number; lockoutDurationMinutes?: number; lockoutWindowMinutes?: number; complexityEnabled?: boolean; reversibleEncryptionEnabled?: boolean }): AdPasswordPolicyInfo {
    return {
      minPasswordLength: p.minPasswordLength ?? 7,
      passwordHistoryCount: p.passwordHistoryLength ?? 24,
      maxPasswordAgeDays: p.maxPasswordAge ?? 42,
      minPasswordAgeDays: p.minPasswordAge ?? 1,
      lockoutThreshold: p.lockoutThreshold ?? 5,
      lockoutDurationMinutes: p.lockoutDurationMinutes ?? 30,
      lockoutObservationWindowMinutes: p.lockoutWindowMinutes ?? 30,
      complexityEnabled: p.complexityEnabled ?? true,
      reversibleEncryptionEnabled: p.reversibleEncryptionEnabled ?? false,
    };
  }

  private fromPolicyPatch(patch: Partial<AdPasswordPolicyInfo>): {
    minPasswordLength?: number; passwordHistoryLength?: number; maxPasswordAge?: number; minPasswordAge?: number;
    lockoutThreshold?: number; lockoutDurationMinutes?: number; lockoutWindowMinutes?: number;
    complexityEnabled?: boolean; reversibleEncryptionEnabled?: boolean;
  } {
    const out: ReturnType<WindowsAdAdapter['fromPolicyPatch']> = {};
    if (patch.minPasswordLength !== undefined) out.minPasswordLength = patch.minPasswordLength;
    if (patch.passwordHistoryCount !== undefined) out.passwordHistoryLength = patch.passwordHistoryCount;
    if (patch.maxPasswordAgeDays !== undefined) out.maxPasswordAge = patch.maxPasswordAgeDays;
    if (patch.minPasswordAgeDays !== undefined) out.minPasswordAge = patch.minPasswordAgeDays;
    if (patch.lockoutThreshold !== undefined) out.lockoutThreshold = patch.lockoutThreshold;
    if (patch.lockoutDurationMinutes !== undefined) out.lockoutDurationMinutes = patch.lockoutDurationMinutes;
    if (patch.lockoutObservationWindowMinutes !== undefined) out.lockoutWindowMinutes = patch.lockoutObservationWindowMinutes;
    if (patch.complexityEnabled !== undefined) out.complexityEnabled = patch.complexityEnabled;
    if (patch.reversibleEncryptionEnabled !== undefined) out.reversibleEncryptionEnabled = patch.reversibleEncryptionEnabled;
    return out;
  }

  private toPsoInfo(pso: { name: string; precedence: number; description: string; settings: Parameters<WindowsAdAdapter['toPolicyInfo']>[0] }): AdFineGrainedPasswordPolicyInfo {
    return { name: pso.name, precedence: pso.precedence, description: pso.description, ...this.toPolicyInfo(pso.settings) };
  }

  getAcl(dn: string): AdAccessRuleInfo[] | null {
    const store = this.requireStore('Get-ACL');
    return store.getAcl(dn);
  }

  setAcl(dn: string, rules: AdAccessRuleInfo[]): AdOpResult {
    const store = this.requireStore('Set-ACL');
    return store.setAcl(dn, rules);
  }

  getDefaultDomainPasswordPolicy(): AdPasswordPolicyInfo {
    const store = this.requireStore('Get-ADDefaultDomainPasswordPolicy');
    return this.toPolicyInfo(store.getDefaultDomainPasswordPolicy());
  }

  setDefaultDomainPasswordPolicy(patch: Partial<AdPasswordPolicyInfo>): AdOpResult {
    const store = this.requireStore('Set-ADDefaultDomainPasswordPolicy');
    return store.setDefaultDomainPasswordPolicy(this.fromPolicyPatch(patch));
  }

  newFineGrainedPasswordPolicy(name: string, precedence: number, settings: Partial<AdPasswordPolicyInfo>, description?: string): AdOpResult {
    const store = this.requireStore('New-ADFineGrainedPasswordPolicy');
    return store.newFineGrainedPasswordPolicy(name, precedence, this.fromPolicyPatch(settings), description);
  }

  getFineGrainedPasswordPolicy(name: string): AdFineGrainedPasswordPolicyInfo | null {
    const store = this.requireStore('Get-ADFineGrainedPasswordPolicy');
    const pso = store.getFineGrainedPasswordPolicy(name);
    return pso ? this.toPsoInfo(pso) : null;
  }

  listFineGrainedPasswordPolicies(): AdFineGrainedPasswordPolicyInfo[] {
    const store = this.requireStore('Get-ADFineGrainedPasswordPolicy');
    return store.listFineGrainedPasswordPolicies().map(pso => this.toPsoInfo(pso));
  }

  addFineGrainedPasswordPolicySubject(name: string, subjects: string[]): AdOpResult {
    const store = this.requireStore('Add-ADFineGrainedPasswordPolicySubject');
    return store.addFineGrainedPasswordPolicySubject(name, subjects);
  }

  listFineGrainedPasswordPolicySubjects(name: string): string[] {
    const store = this.requireStore('Get-ADFineGrainedPasswordPolicySubject');
    return store.listFineGrainedPasswordPolicySubjects(name);
  }

  getResultantPasswordPolicy(userIdentity: string): AdFineGrainedPasswordPolicyInfo | null {
    const store = this.requireStore('Get-ADUserResultantPasswordPolicy');
    const pso = store.getResultantPasswordPolicy(userIdentity);
    return pso ? this.toPsoInfo(pso) : null;
  }

  addKdsRootKey(): AdKdsRootKeyInfo {
    return this.requireStore('Add-KdsRootKey').addKdsRootKey();
  }
  getKdsRootKey(): AdKdsRootKeyInfo | null {
    return this.requireStore('Get-KdsRootKey').getKdsRootKey();
  }
  newServiceAccount(name: string, opts: {
    dnsHostName: string; description?: string; path?: string;
    principalsAllowed?: string[]; managedPasswordIntervalDays?: number; restrictToSingleComputer?: boolean;
  }): AdOpResult {
    const store = this.requireStore('New-ADServiceAccount');
    const denied = this.requireAdmin('New-ADServiceAccount');
    if (denied) return denied;
    return store.newServiceAccount(name, opts);
  }
  getServiceAccount(identity: string): AdServiceAccountInfo | null {
    const store = this.requireStore('Get-ADServiceAccount');
    const a = store.getServiceAccount(store.resolveIdentity(identity));
    return a ? { ...a } : null;
  }
  addServiceAccountSpns(identity: string, addSpns: string[]): AdOpResult {
    const store = this.requireStore('Set-ADServiceAccount');
    const denied = this.requireAdmin('Set-ADServiceAccount');
    if (denied) return denied;
    return store.addServiceAccountSpns(store.resolveIdentity(identity), addSpns);
  }
  addComputerServiceAccount(computerIdentity: string, serviceAccountIdentity: string): AdOpResult {
    const store = this.requireStore('Add-ADComputerServiceAccount');
    const denied = this.requireAdmin('Add-ADComputerServiceAccount');
    if (denied) return denied;
    return store.addComputerServiceAccount(store.resolveIdentity(computerIdentity).replace(/\$$/, ''), store.resolveIdentity(serviceAccountIdentity));
  }

  listReplicationFailures(): AdReplicationFailureInfo[] {
    const store = this.requireStore('Get-ADReplicationFailure');
    const server = this.pc as WindowsServer;
    const selfFqdn = `${server.getHostname()}.${store.dnsName}`;
    const byPartner = new Map<string, { first: number; count: number; lastError: string }>();
    for (const e of server.getReplicationSignals().log.get()) {
      if (e.ok) continue;
      const err = e.error ?? 'unspecified replication error';
      const existing = byPartner.get(e.partnerAddress);
      if (existing) { existing.count += 1; existing.lastError = err; }
      else byPartner.set(e.partnerAddress, { first: e.timestamp, count: 1, lastError: err });
    }
    return [...byPartner.entries()].map(([partner, info]) => ({
      server: selfFqdn,
      partner,
      firstFailureTime: new Date(info.first * 1000).toUTCString(),
      failureCount: info.count,
      lastError: info.lastError,
      failureType: 'LinkFailure',
    }));
  }

  removeDomainController(name: string): AdOpResult {
    const store = this.requireStore('Remove-ADDomainController');
    const denied = this.requireAdmin('Remove-ADDomainController');
    if (denied) return denied;
    return store.removeComputer(name);
  }

  newUser(sam: string, opts: { password: string; fullName?: string; path?: string; enabled?: boolean; department?: string; title?: string; emailAddress?: string; passwordNeverExpires?: boolean; actingSam?: string } & UserWriteOptions): AdOpResult {
    const store = this.requireStore('New-ADUser');
    const denied = this.requireAdmin('New-ADUser');
    if (denied) return denied;
    return store.newUser(sam, {
      password: opts.password, fullName: opts.fullName, enabled: opts.enabled,
      ou: opts.path,
      department: opts.department, title: opts.title, emailAddress: opts.emailAddress,
      passwordNeverExpires: opts.passwordNeverExpires, actingSam: opts.actingSam,
      commonName: opts.commonName, attributes: opts.attributes, flags: opts.flags, spns: opts.spns,
      accountExpires: opts.accountExpires, changePasswordAtLogon: opts.changePasswordAtLogon,
      cannotChangePassword: opts.cannotChangePassword,
    });
  }
  getUser(identity: string): AdUserInfo | null {
    const store = this.requireStore('Get-ADUser');
    const u = store.getUser(store.resolveIdentity(identity));
    return u ? userInfoOf(u) : null;
  }
  setUser(identity: string, opts: { enabled?: boolean; fullName?: string; password?: string; department?: string; title?: string; addSpns?: string[]; removeSpns?: string[]; actingSam?: string; profilePath?: string; homeDirectory?: string; homeDrive?: string }): AdOpResult {
    const store = this.requireStore('Set-ADUser');
    const denied = this.requireAdmin('Set-ADUser');
    if (denied) return denied;
    return store.setUser(store.resolveIdentity(identity), opts);
  }
  listUsers(): AdUserInfo[] {
    return this.requireStore('Get-ADUser').listUsers().map(userInfoOf);
  }
  listObjectsWithSpns(): Array<{ name: string; servicePrincipalNames: string[] }> {
    return this.requireStore('Get-ADObject').listObjectsWithSpns();
  }
  listLockedOutUsers(): Array<{ sam: string; name: string; badPwdCount: number }> {
    return this.requireStore('Search-ADAccount').listLockedOutUsers();
  }
  removeUser(identity: string): AdOpResult {
    const store = this.requireStore('Remove-ADUser');
    const denied = this.requireAdmin('Remove-ADUser');
    if (denied) return denied;
    return store.removeUser(store.resolveIdentity(identity));
  }

  newGroup(sam: string, scope: AdGroupInfo['scope'], path?: string, category?: AdGroupInfo['category'], opts?: GroupWriteOptions): AdOpResult {
    if (opts?.target) {
      const cn = opts.commonName || sam;
      const base = path ?? `CN=Users,DC=${opts.target.server.split('.').slice(1).join(',DC=')}`;
      return this.remoteDirectory('New-ADGroup', opts.target, client => {
        const res = client.add(`CN=${cn},${base}`, [
          { type: 'objectClass', values: ['top', 'group'] },
          { type: 'cn', values: [cn] },
          { type: 'name', values: [cn] },
          { type: 'sAMAccountName', values: [sam] },
          { type: 'groupType', values: [String(groupTypeValue(scope, category ?? 'Security'))] },
          ...Object.entries(opts.attributes ?? {}).filter(([, v]) => v !== '')
            .map(([type, value]) => ({ type, values: [value] })),
        ]);
        return res.ok ? { ok: true, message: '' } : { ok: false, message: res.result.diagnosticMessage || 'An object with that name already exists.' };
      });
    }
    const store = this.requireStore('New-ADGroup');
    const denied = this.requireAdmin('New-ADGroup');
    if (denied) return denied;
    return store.newGroup(sam, scope, path, category, opts);
  }
  setGroup(identity: string, attributes: Record<string, string>, target?: RemoteDirectoryTarget): AdOpResult {
    if (target) {
      return this.remoteDirectory('Set-ADGroup', target, client => {
        const changes = Object.entries(attributes).map(([type, value]) => ({
          operation: (value === '' ? 'delete' : 'replace') as 'delete' | 'replace',
          modification: { type, values: value === '' ? [] : [value] },
        }));
        if (changes.length === 0) return { ok: true, message: '' };
        const res = client.modify(identity, changes);
        return res.ok ? { ok: true, message: '' } : { ok: false, message: res.result.diagnosticMessage || `Cannot find an object with identity: '${identity}'.` };
      });
    }
    const store = this.requireStore('Set-ADGroup');
    const denied = this.requireAdmin('Set-ADGroup');
    if (denied) return denied;
    return store.setGroupAttributes(identity, attributes);
  }
  getGroup(identity: string): AdGroupInfo | null {
    const store = this.requireStore('Get-ADGroup');
    const g = store.getGroup(store.resolveIdentity(identity));
    return g ? groupInfoOf(g) : null;
  }
  listGroups(): AdGroupInfo[] {
    return this.requireStore('Get-ADGroup').listGroups().map(groupInfoOf);
  }
  addGroupMember(groupIdentity: string, members: string[], opts: AddGroupMemberOptions = {}): AdOpResult {
    if (opts.target) return this.groupMemberModifyRemotely('Add-ADGroupMember', 'add', groupIdentity, members, opts);
    const store = this.requireStore('Add-ADGroupMember');
    const denied = this.requireAdmin('Add-ADGroupMember');
    if (denied) return denied;
    if (opts.ttlSeconds !== undefined && !store.isOptionalFeatureEnabled(PRIVILEGED_ACCESS_MANAGEMENT_FEATURE)) {
      return { ok: false, message: TTL_WITHOUT_PAM_FEATURE };
    }
    const group = store.resolveIdentity(groupIdentity);
    const resolved: string[] = [];
    for (const m of members) {
      // `<remoteRealm>\<sam>` naming a domain other than this one (trust-
      // relationships gap 1) — real AD stores this as a local
      // `foreignSecurityPrincipal` stub rather than the actual foreign
      // object, gated on a real established trust (`addForeignSecurityPrincipal`).
      const backslash = m.indexOf('\\');
      const domainPart = backslash !== -1 ? m.slice(0, backslash) : '';
      const isForeign = backslash !== -1
        && domainPart.toLowerCase() !== store.netbiosName.toLowerCase()
        && domainPart.toLowerCase() !== store.dnsName.toLowerCase();
      if (isForeign) {
        const fsp = store.addForeignSecurityPrincipal(domainPart, m.slice(backslash + 1));
        if (!fsp.ok) return fsp;
        resolved.push(fsp.sam!);
        continue;
      }
      resolved.push(store.resolveIdentity(m));
    }
    return store.addGroupMembers(group, resolved, {
      permissiveModify: opts.permissiveModify, ttlSeconds: opts.ttlSeconds,
    });
  }

  private groupMemberModifyRemotely(
    cmdletName: string, operation: 'add' | 'delete',
    groupIdentity: string, members: string[], opts: AddGroupMemberOptions,
  ): AdOpResult {
    const target = opts.target!;
    return this.remoteDirectory(cmdletName, target, client => {
      const base = opts.partition ?? defaultNamingContextOf(client) ?? rootDnOf(target.domainName ?? target.server);
      const dnOf = (identity: string): string | null => {
        if (identity.includes('=')) return identity;
        const found = client.search(base, 'sub',
          { kind: 'equalityMatch', attr: 'sAMAccountName', value: identity }, ['distinguishedName']);
        return found.entries[0]?.dn ?? null;
      };
      const groupDn = dnOf(groupIdentity);
      if (!groupDn) return { ok: false, message: `Cannot find an object with identity: '${groupIdentity}' under: '${base}'.` };
      const memberDns: string[] = [];
      for (const m of members) {
        const dn = dnOf(m);
        if (!dn) return { ok: false, message: `Cannot find an object with identity: '${m}' under: '${base}'.` };
        memberDns.push(dn);
      }
      const type = opts.ttlSeconds === undefined ? 'member' : `member;TTL=${opts.ttlSeconds}`;
      const res = client.modify(groupDn, [{ operation, modification: { type, values: memberDns } }]);
      if (res.ok) return { ok: true, message: '' };
      const fallback = operation === 'add' ? MEMBER_ALREADY_IN_GROUP : MEMBER_NOT_IN_GROUP;
      return { ok: false, message: res.result.diagnosticMessage || fallback };
    });
  }

  groupMemberLinks(groupIdentity: string): AdMemberLink[] {
    const store = this.requireStore('Get-ADGroup');
    const group = store.resolveIdentity(groupIdentity);
    const ttls = store.memberTimeToLive(group);
    return store.getGroupMembersDetailed(group).map(m => {
      const remaining = ttls.get(m.dn.toLowerCase());
      return remaining === undefined ? { dn: m.dn } : { dn: m.dn, ttlSeconds: remaining };
    });
  }
  removeGroupMember(groupIdentity: string, members: string[], opts: AddGroupMemberOptions = {}): AdOpResult {
    if (opts.target) return this.groupMemberModifyRemotely('Remove-ADGroupMember', 'delete', groupIdentity, members, opts);
    const store = this.requireStore('Remove-ADGroupMember');
    const denied = this.requireAdmin('Remove-ADGroupMember');
    if (denied) return denied;
    return store.removeGroupMembers(
      store.resolveIdentity(groupIdentity),
      members.map(m => store.resolveIdentity(m)),
      { permissiveModify: opts.permissiveModify },
    );
  }
  getGroupMembers(groupIdentity: string): Array<{ sam: string; dn: string; objectClass: 'user' | 'computer' | 'group' | 'foreignSecurityPrincipal' }> {
    const store = this.requireStore('Get-ADGroupMember');
    return store.getGroupMembersDetailed(store.resolveIdentity(groupIdentity));
  }
  removeGroup(identity: string): AdOpResult {
    const store = this.requireStore('Remove-ADGroup');
    const denied = this.requireAdmin('Remove-ADGroup');
    if (denied) return denied;
    return store.removeGroup(store.resolveIdentity(identity));
  }

  // ── AD Recycle Bin ──────────────────────────────────────────────────
  getConfigurationNamingContext(): string {
    return this.requireStore('Get-ADRootDSE').getConfigurationNamingContext();
  }
  getOptionalFeature(name: string): AdOptionalFeatureInfo | null {
    return this.requireStore('Get-ADOptionalFeature').getOptionalFeature(name);
  }
  enableOptionalFeature(name: string, scopeDn: string): AdOpResult {
    const store = this.requireStore('Enable-ADOptionalFeature');
    const denied = this.requireAdmin('Enable-ADOptionalFeature');
    if (denied) return denied;
    return store.enableOptionalFeature(name, scopeDn);
  }
  getGenericObject(dn: string, includeDeleted: boolean): AdGenericObjectInfo | null {
    return this.requireStore('Get-ADObject').getObjectByDn(dn, includeDeleted);
  }
  listGenericObjects(opts: { includeDeleted: boolean; searchBaseDn?: string }): AdGenericObjectInfo[] {
    return this.requireStore('Get-ADObject').listObjects(opts);
  }
  setGenericObject(dn: string, replace: Record<string, string>): AdOpResult {
    const store = this.requireStore('Set-ADObject');
    const denied = this.requireAdmin('Set-ADObject');
    if (denied) return denied;
    return store.setObjectAttributes(dn, replace);
  }
  restoreObject(dn: string, targetPathDn?: string): AdOpResult {
    const store = this.requireStore('Restore-ADObject');
    const denied = this.requireAdmin('Restore-ADObject');
    if (denied) return denied;
    return store.restoreObject(dn, targetPathDn);
  }

  getComputer(identity: string): AdComputerInfo | null {
    const store = this.requireStore('Get-ADComputer');
    const name = store.resolveIdentity(identity).replace(/\$$/, '');
    const c = store.getComputer(name);
    return c ? { name: c.name, dn: c.dn, enabled: c.enabled, servicePrincipalNames: c.servicePrincipalNames } : null;
  }
  listComputers(): AdComputerInfo[] {
    return this.requireStore('Get-ADComputer').listComputers().map(c => ({ name: c.name, dn: c.dn, enabled: c.enabled, servicePrincipalNames: c.servicePrincipalNames }));
  }

  setComputerAllowedToDelegateTo(identity: string, targetServiceNames: string[]): AdOpResult {
    const store = this.requireStore('Set-ADComputer');
    const denied = this.requireAdmin('Set-ADComputer');
    if (denied) return denied;
    const name = store.resolveIdentity(identity).replace(/\$$/, '');
    return store.setAllowedToDelegateTo(name, targetServiceNames);
  }

  newOrganizationalUnit(name: string, path?: string, opts?: OrgUnitWriteOptions): AdOpResult {
    if (opts?.target) {
      const base = path ?? `DC=${opts.target.server.split('.').slice(1).join(',DC=')}`;
      const dn = `OU=${name},${base}`;
      return this.remoteDirectory('New-ADOrganizationalUnit', opts.target, client => {
        const attributes = [
          { type: 'objectClass', values: ['top', 'organizationalUnit'] },
          { type: 'ou', values: [name] },
          ...Object.entries(opts.attributes ?? {}).filter(([, v]) => v !== '')
            .map(([type, value]) => ({ type, values: [value] })),
        ];
        const res = client.add(dn, attributes);
        return res.ok ? { ok: true, message: '' } : { ok: false, message: res.result.diagnosticMessage || 'An object with that name already exists.' };
      });
    }
    const store = this.requireStore('New-ADOrganizationalUnit');
    const denied = this.requireAdmin('New-ADOrganizationalUnit');
    if (denied) return denied;
    return store.newOrgUnit(name, path, opts);
  }
  setOrganizationalUnit(identity: string, attributes: Record<string, string>, protectedFlag?: boolean, target?: RemoteDirectoryTarget): AdOpResult {
    if (target) {
      return this.remoteDirectory('Set-ADOrganizationalUnit', target, client => {
        const changes = Object.entries(attributes).map(([type, value]) => ({
          operation: (value === '' ? 'delete' : 'replace') as 'delete' | 'replace',
          modification: { type, values: value === '' ? [] : [value] },
        }));
        if (changes.length === 0) return { ok: true, message: '' };
        const res = client.modify(identity, changes);
        return res.ok ? { ok: true, message: '' } : { ok: false, message: res.result.diagnosticMessage || `Cannot find an object with identity: '${identity}'.` };
      });
    }
    const store = this.requireStore('Set-ADOrganizationalUnit');
    const denied = this.requireAdmin('Set-ADOrganizationalUnit');
    if (denied) return denied;
    if (protectedFlag !== undefined) {
      const res = store.setOrgUnitProtectionByIdentity(identity, protectedFlag);
      if (!res.ok) return res;
    }
    return store.setOrgUnitAttributes(identity, attributes);
  }
  removeOrganizationalUnit(identity: string, recursive?: boolean, target?: RemoteDirectoryTarget): AdOpResult {
    if (target) {
      return this.remoteDirectory('Remove-ADOrganizationalUnit', target, client => {
        const res = client.delete(identity);
        return res.ok ? { ok: true, message: '' } : { ok: false, message: res.result.diagnosticMessage || `Cannot find an object with identity: '${identity}'.` };
      });
    }
    const store = this.requireStore('Remove-ADOrganizationalUnit');
    const denied = this.requireAdmin('Remove-ADOrganizationalUnit');
    if (denied) return denied;
    return store.removeOrgUnit(identity, { recursive });
  }
  getOrganizationalUnit(identity: string): AdOrgUnitInfo | null {
    const store = this.requireStore('Get-ADOrganizationalUnit');
    const ou = store.getOrgUnit(store.resolveIdentity(identity));
    return ou ? { ...ou, gpLinks: [...ou.gpLinks], properties: { ...ou.properties } } : null;
  }
  listOrganizationalUnits(): AdOrgUnitInfo[] {
    return this.requireStore('Get-ADOrganizationalUnit').listOrgUnits().map(ou => ({ ...ou, gpLinks: [...ou.gpLinks], properties: { ...ou.properties } }));
  }

  newReplicationSite(name: string, description?: string): AdOpResult {
    const store = this.requireStore('New-ADReplicationSite');
    const denied = this.requireAdmin('New-ADReplicationSite');
    if (denied) return denied;
    const res = store.newSite(name, description ?? '');
    if (res.ok) store.ensureDefaultSiteLink();
    return res;
  }
  renameReplicationSite(identity: string, newName: string): AdOpResult {
    const store = this.requireStore('Set-ADReplicationSite');
    const denied = this.requireAdmin('Set-ADReplicationSite');
    if (denied) return denied;
    return store.renameSite(identity, newName);
  }
  listReplicationSites(): AdSiteInfo[] {
    const store = this.requireStore('Get-ADReplicationSite');
    return store.listSites();
  }
  newReplicationSubnet(cidr: string, siteName: string, description?: string): AdOpResult {
    const store = this.requireStore('New-ADReplicationSubnet');
    const denied = this.requireAdmin('New-ADReplicationSubnet');
    if (denied) return denied;
    return store.newSubnet(cidr, siteName, description ?? '');
  }
  listReplicationSubnets(): AdSubnetInfo[] {
    const store = this.requireStore('Get-ADReplicationSubnet');
    return store.listSubnets();
  }

  newReplicationSiteLink(
    name: string, sitesIncluded: string[],
    opts?: { cost?: number; replicationFrequencyInMinutes?: number; transport?: 'IP' | 'SMTP'; description?: string },
  ): AdOpResult {
    const store = this.requireStore('New-ADReplicationSiteLink');
    const denied = this.requireAdmin('New-ADReplicationSiteLink');
    if (denied) return denied;
    return store.newSiteLink(name, sitesIncluded, opts);
  }
  listReplicationSiteLinks(): AdSiteLinkInfo[] {
    const store = this.requireStore('Get-ADReplicationSiteLink');
    return store.listSiteLinks();
  }
  getReplicationSiteLink(name: string): AdSiteLinkInfo | null {
    const store = this.requireStore('Get-ADReplicationSiteLink');
    return store.getSiteLink(name);
  }
  setReplicationSiteLink(
    name: string, patch: { cost?: number; replicationFrequencyInMinutes?: number; sitesIncluded?: string[]; description?: string },
  ): AdOpResult {
    const store = this.requireStore('Set-ADReplicationSiteLink');
    const denied = this.requireAdmin('Set-ADReplicationSiteLink');
    if (denied) return denied;
    return store.setSiteLink(name, patch);
  }

  moveDirectoryServer(identity: string, siteName: string): AdOpResult {
    this.requireStore('Move-ADDirectoryServer');
    const denied = this.requireAdmin('Move-ADDirectoryServer');
    if (denied) return denied;
    const server = this.pc as WindowsServer;
    if (typeof server.moveDirectoryServer !== 'function') {
      return { ok: false, message: 'Move-ADDirectoryServer : This computer cannot manage directory server sites.' };
    }
    return server.moveDirectoryServer(identity, siteName);
  }

  newAttribute(schema: AdAttributeSchemaInfo): AdOpResult {
    const store = this.requireStore('New-ADAttribute');
    const denied = this.requireAdmin('New-ADAttribute');
    if (denied) return denied;
    return store.newAttribute(schema);
  }
  newObjectClass(schema: AdObjectClassSchemaInfo): AdOpResult {
    const store = this.requireStore('New-ADObjectClass');
    const denied = this.requireAdmin('New-ADObjectClass');
    if (denied) return denied;
    return store.newObjectClass(schema);
  }

  newDomain(
    newDomainDnsName: string, netbiosName: string | undefined, parentDomainName: string, parentDcAddress: string,
    credentialUser: string, credentialPassword: string, safeModeAdminPassword: string,
    opts?: { installDns?: boolean },
  ): AdOpResult {
    this.requireRole('New-ADDomain');
    const denied = this.requireAdmin('New-ADDomain');
    if (denied) return denied;
    const server = this.pc as WindowsServer;
    if (typeof server.newADDomain !== 'function') {
      return { ok: false, message: 'New-ADDomain : This computer cannot be promoted to a domain controller.' };
    }
    return server.newADDomain(newDomainDnsName, netbiosName, parentDomainName, parentDcAddress, credentialUser, credentialPassword, safeModeAdminPassword, opts);
  }

  private fqdn(shortHostname: string): string {
    const dnsName = this.pc.getDirectoryStore()?.dnsName;
    if (!shortHostname) return '';
    return dnsName ? `${shortHostname}.${dnsName}` : shortHostname;
  }

  getForest(): AdForestInfo | null {
    this.requireRole('Get-ADForest');
    const server = this.pc as WindowsServer;
    const forest = typeof server.getForest === 'function' ? server.getForest() : null;
    if (!forest) return null;
    const fsmo = forest.getFsmoRoles();
    return {
      functionalLevel: forest.functionalLevel, domains: forest.listDomains().map(d => ({ ...d })),
      schemaMaster: this.fqdn(fsmo.schemaMaster), domainNamingMaster: this.fqdn(fsmo.domainNamingMaster),
    };
  }

  getDomain(): AdDomainInfo | null {
    this.requireRole('Get-ADDomain');
    const store = this.pc.getDirectoryStore();
    if (!store) return null;
    return {
      dnsRoot: store.dnsName, netBiosName: store.netbiosName, domainMode: store.domainMode,
      infrastructureMaster: this.fqdn(store.getDomainFsmoRoleOwner('InfrastructureMaster')),
      pdcEmulator: this.fqdn(store.getDomainFsmoRoleOwner('PDCEmulator')),
      ridMaster: this.fqdn(store.getDomainFsmoRoleOwner('RIDMaster')),
    };
  }

  moveOperationMasterRole(targetHostname: string, roles: string[], force: boolean): AdOpResult {
    this.requireRole('Move-ADDirectoryServerOperationMasterRole');
    const denied = this.requireAdmin('Move-ADDirectoryServerOperationMasterRole');
    if (denied) return denied;
    const server = this.pc as WindowsServer;
    if (typeof server.moveOperationMasterRole !== 'function') {
      return { ok: false, message: 'Move-ADDirectoryServerOperationMasterRole : This computer is not a domain controller.' };
    }
    return server.moveOperationMasterRole(targetHostname, roles, force);
  }

  newTrust(
    remoteRealm: string, remoteDcAddress: string, direction: AdTrustInfo['direction'], transitive: boolean,
    credentialUser: string, credentialPassword: string,
  ): AdOpResult {
    this.requireRole('New-ADTrust');
    const denied = this.requireAdmin('New-ADTrust');
    if (denied) return denied;
    const server = this.pc as WindowsServer;
    if (typeof server.newADTrust !== 'function') {
      return { ok: false, message: 'New-ADTrust : This computer cannot be promoted to a domain controller.' };
    }
    return server.newADTrust(remoteRealm, remoteDcAddress, direction, transitive, credentialUser, credentialPassword);
  }

  getTrust(remoteRealm: string): AdTrustInfo | null {
    this.requireRole('Get-ADTrust');
    const server = this.pc as WindowsServer;
    const trust = typeof server.getTrust === 'function' ? server.getTrust(remoteRealm) : null;
    if (!trust) return null;
    return { remoteRealm: trust.remoteRealm, direction: trust.direction, transitive: trust.transitive };
  }

  listTrusts(): AdTrustInfo[] {
    this.requireRole('Get-ADTrust');
    const server = this.pc as WindowsServer;
    const trusts = typeof server.listTrusts === 'function' ? server.listTrusts() : [];
    return trusts.map(t => ({ ...t }));
  }
}

// ── DNS Server adapter (PRD-Windows-Server.md §5 P7) ─────────────────────

class WindowsDnsServerAdapter implements IDnsServerProvider {
  constructor(private readonly pc: WindowsPC) {}

  private requireRole(cmdletName: string): void {
    if (!this.pc.getRoleManager()?.isInstalled('DNS')) {
      throw new Error(commandNotFoundMessage(cmdletName));
    }
  }

  private role() {
    this.requireRole('DnsServer cmdlet');
    const role = this.pc.getDnsServerRole();
    if (!role) throw new Error('DnsServer cmdlet : The DNS Server service is not available on this computer.');
    return role;
  }

  addPrimaryZone(name: string, adminEmail?: string): DnsOpResult { return this.role().addPrimaryZone(name, { adminEmail }); }
  removeZone(name: string): DnsOpResult { return this.role().removeZone(name); }
  getZone(name: string): DnsZoneInfo | null { return this.role().getZone(name); }
  listZones(): DnsZoneInfo[] { return this.role().listZones(); }

  addARecord(zone: string, name: string, ipv4: string, ttl?: number): DnsOpResult { return this.role().addARecord(zone, name, ipv4, ttl); }
  addAaaaRecord(zone: string, name: string, ipv6: string, ttl?: number): DnsOpResult { return this.role().addAaaaRecord(zone, name, ipv6, ttl); }
  addCnameRecord(zone: string, name: string, hostNameAlias: string, ttl?: number): DnsOpResult { return this.role().addCnameRecord(zone, name, hostNameAlias, ttl); }
  addMxRecord(zone: string, name: string, preference: number, mailExchange: string, ttl?: number): DnsOpResult { return this.role().addMxRecord(zone, name, preference, mailExchange, ttl); }
  addPtrRecord(zone: string, name: string, ptrDomainName: string, ttl?: number): DnsOpResult { return this.role().addPtrRecord(zone, name, ptrDomainName, ttl); }
  addSrvRecord(zone: string, name: string, target: { priority: number; weight: number; port: number; target: string }, ttl?: number): DnsOpResult {
    return this.role().addSrvRecord(zone, name, target, ttl);
  }
  removeRecord(zone: string, name: string, type: string): DnsOpResult { return this.role().removeRecord(zone, name, type); }
  getRecords(zone: string, name?: string): DnsRecordInfo[] | null { return this.role().getRecords(zone, name); }

  setForwarders(addresses: string[]): DnsOpResult { return this.role().setForwarders(addresses); }
  getForwarders(): string[] { return this.role().getForwarders(); }

  setZoneDynamicUpdate(zone: string, mode: DnsDynamicUpdateMode): DnsOpResult {
    return this.role().setZoneDynamicUpdate(zone, mode);
  }
  addTsigKey(name: string, algorithm: string, secret: string): DnsOpResult {
    return this.role().addTsigKey(name, algorithm, secret);
  }
  removeTsigKey(name: string): DnsOpResult { return this.role().removeTsigKey(name); }
  listTsigKeys(): { name: string; algorithm: string }[] { return this.role().listTsigKeys(); }
}

// ── DHCP Server adapter (PRD-Windows-Server.md §5 P8) ────────────────────

class WindowsDhcpServerAdapter implements IDhcpServerProvider {
  constructor(private readonly pc: WindowsPC) {}

  private requireRole(cmdletName: string): void {
    if (!this.pc.getRoleManager()?.isInstalled('DHCP')) {
      throw new Error(commandNotFoundMessage(cmdletName));
    }
  }

  private role() {
    this.requireRole('DhcpServer cmdlet');
    const role = this.pc.getDhcpServerRole();
    if (!role) throw new Error('DhcpServer cmdlet : The DHCP Server service is not available on this computer.');
    return role;
  }

  addScope(name: string, startRange: string, endRange: string, subnetMask: string, leaseDurationSeconds?: number): DhcpOpResult {
    return this.role().addScope(name, startRange, endRange, subnetMask, leaseDurationSeconds);
  }
  getScope(name: string): DhcpScopeInfo | null { return this.role().getScope(name); }
  listScopes(): DhcpScopeInfo[] { return this.role().listScopes(); }

  addExclusionRange(startRange: string, endRange: string): DhcpOpResult { return this.role().addExclusionRange(startRange, endRange); }
  addReservation(scopeName: string, ipAddress: string, clientId: string): DhcpOpResult { return this.role().addReservation(scopeName, ipAddress, clientId); }
  setOptionValue(scopeName: string | undefined, optionId: number, values: string[]): DhcpOpResult { return this.role().setOptionValue(scopeName, optionId, values); }
  getLeases(scopeName?: string): DhcpLeaseInfo[] { return this.role().getLeases(scopeName); }

  setScope(name: string, changes: { newName?: string; leaseDuration?: number; state?: 'Active' | 'Inactive' }): DhcpOpResult {
    return this.role().setScope(name, changes);
  }
  removeScope(name: string): DhcpOpResult { return this.role().removeScope(name); }
  listExclusionRanges() { return this.role().listExclusionRanges(); }
  removeExclusionRange(startRange: string, endRange: string): DhcpOpResult {
    return this.role().removeExclusionRange(startRange, endRange);
  }
  listReservations(scopeName?: string) { return this.role().listReservations(scopeName); }
  removeReservation(scopeName: string, ipAddress: string): DhcpOpResult {
    return this.role().removeReservation(scopeName, ipAddress);
  }
  removeLease(ipAddress: string): DhcpOpResult { return this.role().removeLease(ipAddress); }
  hasScope(scopeName: string) { return this.role().hasScope(scopeName); }
  listOptionValues(scopeName?: string) { return this.role().listOptionValues(scopeName); }
  removeOptionValue(scopeName: string | undefined, optionId: number): DhcpOpResult {
    return this.role().removeOptionValue(scopeName, optionId);
  }
  scopeStatistics(scopeName: string) { return this.role().scopeStatistics(scopeName); }
  serverStatistics() { return this.role().serverStatistics(); }

  authorizeInDC(dnsName?: string, ipAddress?: string): DhcpOpResult { return this.role().authorizeInDC(dnsName, ipAddress); }
  registeredIdentity(): { dnsName: string | null; ipAddress: string | null } { return this.role().registeredIdentity(); }
  listBindings() { return this.role().listBindings(); }
  getDnsSettings() { return this.role().getDnsSettings(); }
  setDnsSettings(changes: Record<string, unknown>) {
    return this.role().setDnsSettings(changes as Parameters<ReturnType<WindowsPC['getDhcpServerRole']>['setDnsSettings']>[0]);
  }
  isAuthorizedInDC(): boolean { return this.role().isAuthorizedInDC(); }
  isRegisteredInDC(): boolean { return this.role().isRegisteredInDC(); }
  revokeInDC(): DhcpOpResult { return this.role().revokeInDC(); }
  getConflictDetectionAttempts(): number { return this.role().getConflictDetectionAttempts(); }
  setConflictDetectionAttempts(attempts: number): DhcpOpResult {
    return this.role().setConflictDetectionAttempts(attempts);
  }
  serverAddress(): string { return this.pc.getPorts()[0]?.getIPAddress()?.toString() ?? ''; }
  serverName(): string { return this.pc.getHostname(); }
}

// ── NPS (RADIUS) adapter (PRD-Windows-Server.md §5 P9) ───────────────────

class WindowsNpsAdapter implements INpsProvider {
  constructor(private readonly pc: WindowsPC) {}

  private requireRole(cmdletName: string): void {
    if (!this.pc.getRoleManager()?.isInstalled('NPAS')) {
      throw new Error(commandNotFoundMessage(cmdletName));
    }
  }

  private role() {
    this.requireRole('NPS cmdlet');
    const role = this.pc.getNpsRole();
    if (!role) throw new Error('NPS cmdlet : The Network Policy Server service is not available on this computer.');
    return role;
  }

  addNasClient(name: string, ipAddress: string, sharedSecret: string, nasType?: string): NpsOpResult {
    return this.role().addNasClient(name, ipAddress, sharedSecret, nasType);
  }
  removeNasClient(name: string): NpsOpResult { return this.role().removeNasClient(name); }
  getNasClient(name: string): NasClientInfo | null { return this.role().getNasClient(name); }
  listNasClients(): NasClientInfo[] { return this.role().listNasClients(); }

  addNetworkPolicy(name: string, group: string, vlanId?: number, sessionTimeoutSec?: number): NpsOpResult {
    return this.role().addNetworkPolicy(name, group, { vlanId, sessionTimeoutSec });
  }
  removeNetworkPolicy(name: string): NpsOpResult { return this.role().removeNetworkPolicy(name); }
  listNetworkPolicies(): NetworkPolicyInfo[] { return this.role().listNetworkPolicies(); }

  addConnectionRequestPolicy(name: string, conditions: ConnectionRequestPolicyConditionsInfo): NpsOpResult {
    return this.role().addConnectionRequestPolicy(name, conditions);
  }
  removeConnectionRequestPolicy(name: string): NpsOpResult { return this.role().removeConnectionRequestPolicy(name); }
  listConnectionRequestPolicies(): ConnectionRequestPolicyInfo[] { return this.role().listConnectionRequestPolicies(); }

  setSqlAccounting(enabled: boolean): NpsOpResult { return this.role().setSqlAccounting(enabled); }
  isSqlAccountingEnabled(): boolean { return this.role().isSqlAccountingEnabled(); }

  queryAccounting(sql: string): Record<string, PSValue>[] | null {
    const rs = this.role().queryAccounting(sql);
    if (!rs) return null;
    return rs.rows.map((row) => {
      const obj: Record<string, PSValue> = {};
      rs.columns.forEach((col, i) => { obj[col.name] = row[i] as PSValue; });
      return obj;
    });
  }
}

function toServiceInfo(
  s: import('@/network/devices/windows/WindowsServiceManager').WindowsService,
  mgr: import('@/network/devices/windows/WindowsServiceManager').WindowsServiceManager,
  procMgr: import('@/network/devices/windows/WindowsProcessManager').WindowsProcessManager,
): ServiceInfo {
  return {
    name: s.name,
    displayName: s.displayName,
    description: s.description,
    state: String(s.state),
    startType: String(s.startType),
    serviceType: String(s.serviceType),
    binaryPath: s.binaryPath,
    account: s.account,
    dependencies: [...s.dependencies],
    dependents: mgr.getAllDependents(s.name).map(d => d.name),
    canPauseAndContinue: s.canPauseAndContinue,
    processId: procMgr.getPidForService(s.name),
  };
}

// ── Process adapter ────────────────────────────────────────────────────────

class WindowsProcessAdapter implements IProcessProvider {
  constructor(private readonly pc: WindowsPC) {}

  private mgr() { return this.pc.getProcessManager(); }
  private isAdmin(): boolean { return this.pc.getUserManager().isCurrentUserAdmin(); }

  listProcesses(nameFilter?: string): ProcessInfo[] {
    const all = this.mgr().getAllProcesses();
    const filtered = nameFilter
      ? all.filter(p => p.name.toLowerCase().includes(nameFilter.toLowerCase()))
      : all;
    return filtered.map(toProcessInfo);
  }
  getProcess(nameOrPid: string | number): ProcessInfo | null {
    if (typeof nameOrPid === 'number') {
      const p = this.mgr().getProcess(nameOrPid);
      return p ? toProcessInfo(p) : null;
    }
    const byName = this.mgr().getProcessesByName(nameOrPid);
    return byName.length > 0 ? toProcessInfo(byName[0]) : null;
  }
  killProcess(nameOrPid: string | number, force: boolean): string {
    if (typeof nameOrPid === 'number') {
      return this.mgr().killProcess(nameOrPid, force, this.isAdmin());
    }
    return this.mgr().killByName(nameOrPid, force, this.isAdmin(), false);
  }
  startProcess(imageName: string, opts?: { arguments?: string; user?: string }): ProcessInfo | null {
    const mgr = this.mgr();
    // Parent the new process to explorer.exe (interactive shell session).
    const parent = mgr.getAllProcesses().find(p => p.name.toLowerCase() === 'explorer.exe');
    const ppid = parent?.pid ?? 1;
    const spawned = mgr.spawnProcess(
      imageName,
      ppid,
      opts?.user ?? (this.pc as unknown as { getCurrentUser?: () => string }).getCurrentUser?.() ?? 'User',
      { session: 'Console', sessionId: 1 },
    );
    return spawned ? toProcessInfo(spawned) : null;
  }
  checkCredential(userName: string, password: string): boolean {
    return this.pc.checkPassword(userName, password);
  }
}

function toProcessInfo(p: import('@/network/devices/windows/WindowsProcessManager').WindowsProcess): ProcessInfo {
  return {
    pid: p.pid,
    name: p.name,
    ppid: p.ppid,
    owner: p.owner,
    handles: p.handles,
    npmK: p.npmK,
    pmK: p.pmK,
    wsK: p.wsK,
    cpuSec: p.cpuSec,
    threads: p.threads,
    cpuPercent: p.cpuPercent,
    status: p.status,
    sessionId: p.sessionId,
    critical: p.critical,
  };
}

// ── User / group adapter ───────────────────────────────────────────────────

class WindowsUserAdapter implements IUserProvider {
  constructor(private readonly pc: WindowsPC) {}

  private mgr() { return this.pc.getUserManager(); }

  listUsers(): UserInfo[] {
    return this.mgr().getAllUsers().map(toUserInfo);
  }
  getUser(name: string): UserInfo | null {
    const u = this.mgr().getUser(name);
    return u ? toUserInfo(u) : null;
  }
  createUser(name: string, opts: { password?: string; fullName?: string; description?: string }): string {
    return this.mgr().createUser(name, opts.password ?? '', {
      fullName: opts.fullName,
      description: opts.description,
    });
  }
  removeUser(name: string): string {
    return this.mgr().deleteUser(name);
  }
  setUser(name: string, opts: { enabled?: boolean; fullName?: string; description?: string; password?: string }): string {
    const m = this.mgr();
    const msgs: string[] = [];
    if (opts.fullName !== undefined)     msgs.push(m.setUserProperty(name, 'fullName',    opts.fullName));
    if (opts.description !== undefined)  msgs.push(m.setUserProperty(name, 'description', opts.description));
    if (opts.password !== undefined)     msgs.push(m.setUserProperty(name, 'password',    opts.password));
    if (opts.enabled === true)           msgs.push(m.enableUser(name));
    if (opts.enabled === false)          msgs.push(m.disableUser(name));
    return msgs.filter(Boolean).join('\n');
  }
  enableUser(name: string): string {
    return this.mgr().enableUser(name);
  }
  disableUser(name: string): string {
    return this.mgr().disableUser(name);
  }
  renameUser(oldName: string, newName: string): string {
    return this.mgr().renameUser(oldName, newName);
  }
  renameGroup(oldName: string, newName: string): string {
    return this.mgr().renameGroup(oldName, newName);
  }

  listGroups(): GroupInfo[] {
    return this.mgr().getAllGroups().map(toGroupInfo);
  }
  getGroup(name: string): GroupInfo | null {
    const g = this.mgr().getGroup(name);
    return g ? toGroupInfo(g) : null;
  }
  createGroup(name: string, opts?: { description?: string }): string {
    return this.mgr().createGroup(name, opts?.description ?? '');
  }
  removeGroup(name: string): string {
    return this.mgr().deleteGroup(name);
  }
  addGroupMember(group: string, member: string): string {
    return this.mgr().addGroupMember(group, member);
  }
  removeGroupMember(group: string, member: string): string {
    return this.mgr().removeGroupMember(group, member);
  }
  getGroupMembers(group: string): UserInfo[] {
    const g = this.mgr().getGroup(group);
    if (!g) return [];
    const out: UserInfo[] = [];
    for (const memberName of g.members) {
      const u = this.mgr().getUser(memberName);
      if (u) out.push(toUserInfo(u));
    }
    return out;
  }
  isAdmin(userName: string): boolean {
    return this.mgr().isAdmin(userName);
  }
}

function toUserInfo(u: import('@/network/devices/windows/WindowsUserManager').WindowsUser): UserInfo {
  return {
    name: u.name,
    fullName: u.fullName,
    description: u.description,
    sid: u.sid,
    enabled: u.enabled,
    passwordRequired: u.passwordRequired,
    lastLogon: u.lastLogon,
  };
}
function toGroupInfo(g: import('@/network/devices/windows/WindowsUserManager').WindowsGroup): GroupInfo {
  return {
    name: g.name,
    description: g.description,
    sid: g.sid,
    members: [...g.members],
  };
}

// ── Registry adapter (direct delegation — same string-returning shape) ─────

class WindowsRegistryAdapter implements IRegistryProvider {
  // Held at provider-construction time so the interpreter and the legacy
  // executor can share the same in-memory hive (see WindowsPSProviders ctor).
  constructor(private readonly reg: PSRegistryProvider) {}

  testPath(path: string): boolean              { return this.reg.testPath(path); }
  getItem(path: string): string                 { return this.reg.getItem(path); }
  getChildItem(path: string): string            { return this.reg.getChildItem(path); }
  newItem(path: string, force: boolean): string { return this.reg.newItem(path, force); }
  removeItem(path: string, recurse: boolean): string { return this.reg.removeItem(path, recurse); }
  getItemProperty(path: string, name?: string): string { return this.reg.getItemProperty(path, name); }
  getItemPropertyValues(path: string) { return this.reg.getItemPropertyValues(path); }
  setItemProperty(path: string, name: string, value: string | number): string {
    return this.reg.setItemProperty(path, name, value);
  }
  removeItemProperty(path: string, name: string): string { return this.reg.removeItemProperty(path, name); }
  getPSDrive(): string                           { return this.reg.getPSDrive(); }
}

// ── Event-log adapter (minimal — returns parsed shape where possible) ──────

class WindowsEventLogAdapter implements IEventLogProvider {
  constructor(
    private readonly log: PSEventLogProvider,
    /** L'appareil, pour l'audit 1102 — absent sur un hôte non-Windows. */
    private readonly pc?: { auditLogCleared?(logName: string): void },
  ) {}

  listLogs() {
    return this.log.getAllLogsStructured();
  }
  getEntries(logName: string, opts?: { newest?: number; entryType?: string; source?: string }): EventLogEntryInfo[] {
    const raw = this.log.getEntriesStructured(logName, opts ?? {});
    if (!raw) return [];
    return raw.map(e => ({
      index: e.index,
      timeGenerated: e.timeGenerated,
      entryType: e.entryType,
      source: e.source,
      eventId: e.eventId,
      category: e.category,
      message: e.message,
      data: e.data,
    }));
  }
  writeEntry(logName: string, source: string, eventId: number, entryType: string, message: string, data?: Record<string, string>): void {
    this.log.writeEventLog(logName, source, eventId, entryType as 'Information' | 'Warning' | 'Error' | 'SuccessAudit' | 'FailureAudit', message, data);
  }
  clearLog(logName: string): string {
    const out = this.log.clearEventLog(logName);
    // 1102 s'écrit *après* le vidage : c'est la première entrée du
    // journal neuf, et souvent la seule trace qu'un effacement a eu lieu.
    if (!out) this.pc?.auditLogCleared?.(logName);
    return out;
  }
  newLog(logName: string, source: string): string { return this.log.newEventLog(logName, source); }
  limitLog(logName: string): void { this.log.limitEventLog(logName); }
}

// ── Network adapter ────────────────────────────────────────────────────────

interface NetworkStateRefs {
  readonly extraIPs:             Map<string, NetIPAddressEntry>;
  readonly extraRoutes:          Map<string, NetRouteEntry>;
  readonly firewallRules: Map<string, NetFirewallRuleEntry>;
  readonly networkProfiles:      Map<number, string>;
}

class WindowsNetworkAdapter implements INetworkProvider {
  constructor(
    private readonly pc: WindowsPC,
    private readonly state: NetworkStateRefs,
  ) {}

  // ─ Hostname / adapters / IP enumeration ─────────────────────────────────

  getHostname(): string {
    return (this.pc as unknown as { name: string }).name;
  }
  getAdapters(): NetAdapterEntry[] {
    return this.pc.getPorts().map((port, idx) => {
      const portName = port.getName();
      const connected = port.isOperationallyUp();
      const aggregated = this.pc.aggregateLinkSpeedMbps(portName);
      return {
        portName,
        name: this.pc.adapterAlias(portName),
        interfaceDescription: this.pc.interfaceDescriptionOf(portName),
        ifIndex: adapterIfIndex(idx),
        status: port.isAdminDown() ? 'Disabled' : (connected ? 'Up' : 'Disconnected'),
        macAddress: port.getMAC().toString(),
        linkSpeed: connected
          ? formatLinkSpeedMbps(aggregated ?? port.getNegotiatedSpeed())
          : '0 bps',
        mtu: port.getMTU(),
        physical: !port.isCarrierless() && this.pc.getVlanSubInterface(portName) === undefined,
        hidden: false,
      };
    });
  }
  getNicTeams(): NicTeamInfo[] {
    return [...this.pc.getNicTeams().values()].map(t => ({
      name: t.name,
      members: t.members.map(m => toDisplayName(m.name)),
      teamNics: t.teamNics.map(n => n.name),
      teamingMode: t.teamingMode,
      loadBalancingAlgorithm: t.loadBalancingAlgorithm,
      lacpTimer: t.lacpTimer,
      status: teamStatus(t.members, n => this.pc.activeTeamMembers(t).includes(n)),
    }));
  }

  newNicTeam(request: NewNicTeamRequest): string {
    const membres: TeamMember[] = [];
    for (const brut of request.teamMembers) {
      const port = toPortName(brut) ?? brut;
      membres.push({ name: port, adminMode: 'Active' });
    }
    const mode = request.teamingMode
      ? normaliseTeamingMode(request.teamingMode) : 'SwitchIndependent';
    if (!mode) return `'${request.teamingMode}' is not a valid teaming mode.`;
    const algo = request.loadBalancingAlgorithm
      ? normaliseLbAlgorithm(request.loadBalancingAlgorithm) : 'Dynamic';
    if (!algo) return `'${request.loadBalancingAlgorithm}' is not a valid load balancing algorithm.`;
    const timer = request.lacpTimer ? normaliseLacpTimer(request.lacpTimer) : 'Slow';
    if (!timer) return `'${request.lacpTimer}' is not a valid LACP timer.`;
    return this.pc.createNicTeam({
      name: request.name,
      members: membres,
      teamNics: [{ name: request.teamNicName ?? request.name, vlanId: null, primary: true }],
      teamingMode: mode,
      loadBalancingAlgorithm: algo,
      lacpTimer: timer,
    });
  }

  setNicTeam(name: string, request: SetNicTeamRequest): string {
    const team = this.pc.getNicTeam(name);
    if (!team) return `The team '${name}' was not found.`;
    if (request.teamingMode !== undefined) {
      const mode = normaliseTeamingMode(request.teamingMode);
      if (!mode) return `'${request.teamingMode}' is not a valid teaming mode.`;
      team.teamingMode = mode;
    }
    if (request.loadBalancingAlgorithm !== undefined) {
      const algo = normaliseLbAlgorithm(request.loadBalancingAlgorithm);
      if (!algo) return `'${request.loadBalancingAlgorithm}' is not a valid load balancing algorithm.`;
      team.loadBalancingAlgorithm = algo;
    }
    if (request.lacpTimer !== undefined) {
      const timer = normaliseLacpTimer(request.lacpTimer);
      if (!timer) return `'${request.lacpTimer}' is not a valid LACP timer.`;
      team.lacpTimer = timer;
    }
    this.pc.applyNicTeam(team.name);
    return '';
  }

  removeNicTeam(name: string): string {
    return this.pc.removeNicTeam(name) ? '' : `The team '${name}' was not found.`;
  }

  getNicTeamMembers(team?: string): NicTeamMemberInfo[] {
    const out: NicTeamMemberInfo[] = [];
    for (const t of this.pc.getNicTeams().values()) {
      if (team !== undefined && t.name.toLowerCase() !== team.toLowerCase()) continue;
      const actifs = this.pc.activeTeamMembers(t);
      for (const m of t.members) {
        const port = this.pc.getPort(m.name);
        const vitesse = port?.isOperationallyUp()
          ? formatLinkSpeedMbps(port.getNegotiatedSpeed()) : '0 bps';
        out.push({
          name: toDisplayName(m.name),
          interfaceDescription: toDisplayName(m.name),
          team: t.name,
          administrativeMode: m.adminMode,
          operationalStatus: memberStatus(
            m, port?.isOperationallyUp() === true, actifs.includes(m.name), t.teamingMode),
          transmitLinkSpeed: vitesse,
          receiveLinkSpeed: vitesse,
          failureReason: memberFailureReason(
            m, port?.isOperationallyUp() === true, actifs.includes(m.name), t.teamingMode),
        });
      }
    }
    return out;
  }

  getNicTeamNics(team?: string): NicTeamNicInfo[] {
    const out: NicTeamNicInfo[] = [];
    for (const t of this.pc.getNicTeams().values()) {
      if (team !== undefined && t.name.toLowerCase() !== team.toLowerCase()) continue;
      for (const nic of t.teamNics) {
        out.push({
          name: nic.name, team: t.name, vlanId: nic.vlanId,
          primary: nic.primary, isDefault: nic.primary && nic.vlanId === null,
        });
      }
    }
    return out;
  }

  addNicTeamNic(team: string, vlanId: number, name?: string): string {
    return this.pc.addNicTeamNic(team, vlanId, name);
  }

  removeNicTeamNic(team: string, vlanId: number): string {
    return this.pc.removeNicTeamNic(team, vlanId);
  }

  setNicTeamNic(name: string, patch: { vlanId?: number; isDefault?: boolean }): string {
    return this.pc.setNicTeamNic(name, patch);
  }

  addNicTeamMember(team: string, name: string, administrativeMode?: string): string {
    const mode = administrativeMode ? normaliseAdminMode(administrativeMode) : 'Active';
    if (!mode) return `'${administrativeMode}' is not a valid administrative mode.`;
    return this.pc.addNicTeamMember(team, { name: toPortName(name) ?? name, adminMode: mode });
  }

  setNicTeamMember(name: string, administrativeMode: string): string {
    const mode = normaliseAdminMode(administrativeMode);
    if (!mode) return `'${administrativeMode}' is not a valid administrative mode.`;
    const port = toPortName(name) ?? name;
    const team = this.pc.teamOwning(port);
    if (!team) return `The network adapter '${name}' is not a member of any team.`;
    const membre = team.members.find(m => m.name.toLowerCase() === port.toLowerCase());
    if (!membre) return `The network adapter '${name}' is not a member of any team.`;
    membre.adminMode = mode;
    this.pc.applyNicTeam(team.name);
    return '';
  }

  removeNicTeamMember(name: string): string {
    return this.pc.removeNicTeamMember(toPortName(name) ?? name);
  }

  getAdapter(name: string): NetAdapterEntry | null {
    return resolveAdapter(this.getAdapters(), name);
  }
  private portNameFor(name: string): string {
    return resolveAdapterPortName(name, this.pc.getPortsMap().values()) ?? name;
  }
  getAdapterStatistics(name: string): AdapterStatisticsInfo | null {
    const adapter = this.getAdapter(name);
    if (!adapter) return null;
    const portName = toPortName(name) ?? name;
    const ports = (this.pc as unknown as {
      getPorts: () => Array<{
        name: string;
        getCounters: () => { framesIn: number; framesOut: number; bytesIn: number; bytesOut: number; errorsIn: number; errorsOut: number; dropsIn: number; dropsOut: number };
      }>;
    }).getPorts();
    const port = ports.find(p => p.name.toLowerCase() === portName.toLowerCase())
      ?? ports.find(p => toDisplayName(p.name).toLowerCase() === adapter.name.toLowerCase());
    if (!port) return null;
    const c = port.getCounters();
    return {
      name: adapter.name,
      receivedBytes: c.bytesIn,
      receivedUnicastPackets: c.framesIn,
      receivedDiscardedPackets: c.dropsIn,
      receivedPacketErrors: c.errorsIn,
      sentBytes: c.bytesOut,
      sentUnicastPackets: c.framesOut,
      outboundDiscardedPackets: c.dropsOut,
      outboundPacketErrors: c.errorsOut,
    };
  }
  getIPAddresses(ifAlias?: string): IPAddressInfo[] {
    const out: IPAddressInfo[] = [];
    // Loopback is always present in real Windows.
    if (!ifAlias || ifAlias.toLowerCase() === LOOPBACK_IFALIAS.toLowerCase()) {
      out.push({
        ipAddress: '127.0.0.1',
        prefixLength: 8,
        ifAlias: LOOPBACK_IFALIAS,
        ifIndex: LOOPBACK_IFINDEX,
        prefixOrigin: 'WellKnown',
        suffixOrigin: 'WellKnown',
        addressFamily: 'IPv4',
      });
      out.push({
        ipAddress: '::1',
        prefixLength: 128,
        ifAlias: LOOPBACK_IFALIAS,
        ifIndex: LOOPBACK_IFINDEX,
        prefixOrigin: 'WellKnown',
        suffixOrigin: 'WellKnown',
        addressFamily: 'IPv6',
      });
    }
    const pc = this.pc as unknown as {
      getPorts: () => Array<{
        name: string;
        getIPAddress: () => unknown;
        getSubnetMask?: () => { toCIDR?: () => number } | null;
        getIPv4Origin?: () => 'manual' | 'dhcp' | 'link-local';
      }>;
      getInterfaceLeaseLifetimes?: (ifName: string) => { validSeconds: number; preferredSeconds: number } | null;
    };
    const ports = pc.getPorts();
    const resolvedFilter = ifAlias ? (toPortName(ifAlias) ?? ifAlias) : undefined;
    const filtered = resolvedFilter
      ? ports.filter(p => p.name.toLowerCase() === resolvedFilter.toLowerCase())
      : ports;
    filtered.forEach((p, idx) => {
      const raw = p.getIPAddress();
      if (raw) {
        const ip = String((raw as { toString: () => string }).toString());
        const origin = p.getIPv4Origin?.() ?? 'manual';
        const { prefixOrigin, suffixOrigin } = mapV4Origin(origin);
        const cidr = p.getSubnetMask?.()?.toCIDR?.();
        const lease = origin === 'dhcp' ? (pc.getInterfaceLeaseLifetimes?.(p.name) ?? null) : null;
        out.push({
          ipAddress: ip,
          prefixLength: typeof cidr === 'number' ? cidr : 24,
          ifAlias: toDisplayName(p.name),
          ifIndex: adapterIfIndex(idx),
          prefixOrigin,
          suffixOrigin,
          addressFamily: ip.includes(':') ? 'IPv6' : 'IPv4',
          validLifetimeSeconds: lease?.validSeconds,
          preferredLifetimeSeconds: lease?.preferredSeconds,
        });
      }
    });
    // Layer extra IPs (added via New-NetIPAddress) that aren't already
    // mirrored onto a real port — IPv4 additions are applied to the port
    // directly above, so only IPv6/unreachable entries land here.
    const seenIps = new Set(out.map(e => e.ipAddress.toLowerCase()));
    for (const [ip, meta] of this.state.extraIPs) {
      if (seenIps.has(ip.toLowerCase())) continue;
      const metaPortName = toPortName(meta.ifAlias) ?? meta.ifAlias;
      if (resolvedFilter && metaPortName.toLowerCase() !== resolvedFilter.toLowerCase()) continue;
      const ifIndex = ports.findIndex(p => p.name.toLowerCase() === metaPortName.toLowerCase()) + 1;
      out.push({
        ipAddress: ip,
        prefixLength: meta.prefixLength,
        ifAlias: toDisplayName(metaPortName),
        ifIndex,
        prefixOrigin: meta.prefixOrigin,
        suffixOrigin: meta.suffixOrigin,
        addressFamily: meta.addressFamily,
        gateway: meta.gateway,
      });
    }
    for (const entry of out) {
      const meta = this.state.extraIPs.get(entry.ipAddress.toLowerCase());
      if (!meta) continue;
      entry.skipAsSource = meta.skipAsSource;
      entry.type = meta.type;
      entry.policyStore = meta.policyStore;
      if (meta.validLifetimeSeconds !== undefined) entry.validLifetimeSeconds = meta.validLifetimeSeconds;
      if (meta.preferredLifetimeSeconds !== undefined) entry.preferredLifetimeSeconds = meta.preferredLifetimeSeconds;
    }
    return out;
  }

  // ─ IP add / remove ──────────────────────────────────────────────────────

  resolveNetInterface(spec: { alias?: string; index?: number }): { alias: string; ifIndex: number } | null {
    const adapters = this.getAdapters();
    if (spec.index !== undefined) {
      const byIndex = adapters.find(a => a.ifIndex === spec.index);
      return byIndex ? { alias: byIndex.name, ifIndex: byIndex.ifIndex } : null;
    }
    if (spec.alias === undefined) return null;
    const wanted = spec.alias.trim();
    const exact = adapters.find(a => a.name.toLowerCase() === wanted.toLowerCase());
    if (exact) return { alias: exact.name, ifIndex: exact.ifIndex };
    const byPort = resolveAdapter(adapters, wanted);
    return byPort ? { alias: byPort.name, ifIndex: byPort.ifIndex } : null;
  }

  setDhcpEnabled(ifAlias: string, enabled: boolean): void {
    if (enabled) return;
    (this.pc as unknown as { disableDhcpOnInterface: (n: string) => void })
      .disableDhcpOnInterface(this.portNameFor(ifAlias));
  }

  addIPAddress(ip: string, prefixLength: number, ifAlias: string, opts?: NetIPAddressOptions): void {
    // Une adresse dont un octet dépasse 255 n'en est pas une. Elle
    // entrait ici sans contrôle et ressortait dans `Get-NetIPAddress` :
    // la machine croyait porter `999.1.1.1`, que `netsh` refusait au
    // même instant sur la même interface.
    if (!ip.includes(':') && !isValidIPv4(ip)) {
      throw new Error(
        `Cannot validate argument on parameter 'IPAddress'. `
        + `The argument "${ip}" is not a valid IPv4 address.`);
    }
    const key = ip.toLowerCase();
    if (this.state.extraIPs.has(key)) {
      throw new Error(`IP address ${ip} already exists.`);
    }
    this.state.extraIPs.set(key, {
      ifAlias,
      prefixLength,
      prefixOrigin: 'Manual',
      suffixOrigin: 'Manual',
      skipAsSource: opts?.skipAsSource ?? false,
      gateway: opts?.gateway,
      addressFamily: ip.includes(':') ? 'IPv6' : 'IPv4',
      type: opts?.type ?? 'Unicast',
      policyStore: opts?.policyStore ?? 'ActiveStore',
      validLifetimeSeconds: opts?.validLifetimeSeconds,
      preferredLifetimeSeconds: opts?.preferredLifetimeSeconds,
    });
    this.setDhcpEnabled(ifAlias, false);
    if (opts?.gateway) {
      this.addRoute(ip.includes(':') ? '::/0' : '0.0.0.0/0', ifAlias, opts.gateway, 256);
    }
    // Mirror onto the device port so cmd's `ipconfig` / `netsh ipv4 show
    // addresses` see the same address PowerShell just added.
    if (!ip.includes(':')) {
      const ports = this.pc.getPortsMap();
      const portName = this.portNameFor(ifAlias);
      if (ports.has(portName)) {
        const maskOctets = prefixToMaskOctets(prefixLength);
        try {
          (this.pc as unknown as { configureInterface: (n: string, ip: IPAddress, m: SubnetMask) => void })
            .configureInterface(portName, new IPAddress(ip), new SubnetMask(maskOctets));
        } catch { /* ignore — extraIPs already records the assignment */ }
      }
    }
  }
  removeIPAddress(ip: string): void {
    if (ip === '127.0.0.1' || ip === '::1') {
      throw new Error('Cannot remove loopback address.');
    }
    const entry = this.state.extraIPs.get(ip.toLowerCase());
    this.state.extraIPs.delete(ip.toLowerCase());
    // Also strip the address from the underlying device port so cmd's
    // `ipconfig` no longer reports it. We only clear if the port currently
    // carries that exact IP (matches netsh's `delete address` semantics).
    if (entry && !ip.includes(':')) {
      const ports = this.pc.getPortsMap();
      const portName = this.portNameFor(entry.ifAlias);
      const port = ports.get(portName);
      // Clear the address AND its connected route via the same device method
      // cmd's `netsh delete address` uses, so `route print` / `Get-NetRoute`
      // agree the network is gone (not just the address).
      if (port && String(port.getIPAddress()) === ip) {
        (this.pc as unknown as { unconfigureInterface: (n: string) => void }).unconfigureInterface(portName);
      }
    }
  }

  // ─ Routes ───────────────────────────────────────────────────────────────

  getRoutes(): RouteInfo[] {
    const out: RouteInfo[] = [];
    const real = (this.pc as unknown as {
      getRoutingTable: () => Array<{
        network: { toString(): string }; mask: { toCIDR(): number };
        nextHop: { toString(): string } | null; iface: string; metric: number;
      }>;
    }).getRoutingTable();
    const seen = new Set<string>();
    for (const r of real) {
      const row: RouteInfo = {
        destinationPrefix: `${r.network.toString()}/${r.mask.toCIDR()}`,
        ifAlias: toDisplayName(r.iface),
        nextHop: r.nextHop ? r.nextHop.toString() : UNSPECIFIED_NEXT_HOP.IPv4,
        routeMetric: r.metric,
      };
      seen.add(netRouteKey(row));
      out.push(row);
    }
    // Troisieme copie du meme fait, trouvee en verifiant les deux
    // autres : `route print`, `Get-NetRoute` cote cmd et ce fournisseur
    // declaraient chacun leurs routes de bouclage, avec des metriques
    // differentes. Une seule declaration, trois lecteurs.
    for (const lo of WINDOWS_LOOPBACK_ROUTES) {
      const row: RouteInfo = {
        destinationPrefix: `${lo.network}/${lo.prefixLength}`,
        ifAlias: LOOPBACK_IFALIAS, nextHop: UNSPECIFIED_NEXT_HOP.IPv4, routeMetric: lo.metric,
      };
      seen.add(netRouteKey(row));
      out.push(row);
    }
    for (const meta of this.state.extraRoutes.values()) {
      if (seen.has(netRouteKey(meta))) continue;
      out.push({
        destinationPrefix: meta.destinationPrefix,
        ifAlias: meta.ifAlias,
        nextHop: meta.nextHop,
        routeMetric: meta.metric,
      });
    }
    const adapters = this.getAdapters();
    for (const entry of out) {
      const meta = this.state.extraRoutes.get(netRouteKey(entry));
      entry.addressFamily = entry.destinationPrefix.includes(':') ? 'IPv6' : 'IPv4';
      entry.publish = meta?.publish ?? 'No';
      entry.protocol = meta?.protocol ?? (meta ? 'NetMgmt' : 'Local');
      entry.policyStore = meta?.policyStore ?? 'ActiveStore';
      entry.ifIndex = meta?.ifIndex
        ?? adapters.find(a => a.name.toLowerCase() === entry.ifAlias.toLowerCase())?.ifIndex
        ?? (entry.ifAlias === LOOPBACK_IFALIAS ? LOOPBACK_IFINDEX : 0);
      entry.validLifetimeSeconds = meta?.validLifetimeSeconds;
      entry.preferredLifetimeSeconds = meta?.preferredLifetimeSeconds;
    }
    return out;
  }
  addRoute(dest: string, ifAlias: string, nextHop: string, metric: number, opts?: NetRouteAttributes): void {
    const entry: NetRouteEntry = {
      destinationPrefix: dest, ifAlias, nextHop, metric,
      publish: opts?.publish, protocol: opts?.protocol as NetRouteEntry['protocol'],
      policyStore: opts?.policyStore, ifIndex: opts?.ifIndex,
      addressFamily: opts?.addressFamily as NetRouteEntry['addressFamily'],
      validLifetimeSeconds: opts?.validLifetimeSeconds,
      preferredLifetimeSeconds: opts?.preferredLifetimeSeconds,
    };
    const applied = this.tryApplyRealRoute(dest, nextHop, metric);
    if (applied && opts === undefined) return;
    this.state.extraRoutes.set(netRouteKey(entry), entry);
  }
  removeRoute(route: NetRouteIdentity): void {
    this.state.extraRoutes.delete(netRouteKey(route));
    this.tryRemoveRealRoute(route.destinationPrefix, route.nextHop);
  }
  private parsePrefix(dest: string): { network: IPAddress; mask: SubnetMask } | null {
    const slash = dest.lastIndexOf('/');
    if (slash === -1) return null;
    const network = IPAddress.tryParse(dest.slice(0, slash));
    const length = Number(dest.slice(slash + 1));
    if (network === null || !Number.isInteger(length) || length < 0 || length > 32) return null;
    return { network, mask: new SubnetMask(prefixToMaskOctets(length)) };
  }
  private isDefaultPrefix(dest: string): boolean {
    const parsed = this.parsePrefix(dest);
    return parsed !== null && parsed.mask.toCIDR() === 0;
  }
  private tryApplyRealRoute(dest: string, nextHop: string, metric: number): boolean {
    const parsed = this.parsePrefix(dest);
    const gw = IPAddress.tryParse(nextHop);
    if (!parsed || gw === null || gw.toString() === UNSPECIFIED_NEXT_HOP.IPv4) return false;
    const device = this.pc as unknown as {
      addStaticRoute: (n: IPAddress, m: SubnetMask, g: IPAddress, metric: number) => boolean;
      setDefaultGateway: (g: IPAddress, origin?: 'static' | 'dhcp', metric?: number) => void;
      getDefaultGateway?: () => IPAddress | null;
    };
    if (this.isDefaultPrefix(dest)) {
      const before = device.getDefaultGateway?.() ?? null;
      device.setDefaultGateway(gw, 'static', metric);
      return (device.getDefaultGateway?.() ?? before)?.toString() === gw.toString();
    }
    return device.addStaticRoute(parsed.network, parsed.mask, gw, metric);
  }
  private tryRemoveRealRoute(dest: string, nextHop?: string): boolean {
    const parsed = this.parsePrefix(dest);
    if (!parsed) return false;
    const device = this.pc as unknown as {
      removeRoute: (n: IPAddress, m: SubnetMask) => boolean;
      clearDefaultGateway: () => void;
      getDefaultGateway?: () => IPAddress | null;
    };
    if (this.isDefaultPrefix(dest)) {
      const current = device.getDefaultGateway?.() ?? null;
      if (current === null) return device.removeRoute(parsed.network, parsed.mask);
      if (nextHop !== undefined && current.toString() !== nextHop) return false;
      device.clearDefaultGateway();
      return true;
    }
    return device.removeRoute(parsed.network, parsed.mask);
  }
  setRoute(route: NetRouteIdentity, update: NetRouteUpdate): string {
    const key = netRouteKey(route);
    const known = this.state.extraRoutes.get(key);
    if (update.routeMetric !== undefined) {
      const applied = this.getRoutes().find(r => netRouteKey(r) === key);
      if (applied && this.tryRemoveRealRoute(route.destinationPrefix, route.nextHop)) {
        this.tryApplyRealRoute(route.destinationPrefix, route.nextHop, update.routeMetric);
      }
    }
    const entry: NetRouteEntry = known ?? {
      destinationPrefix: route.destinationPrefix,
      ifAlias: route.ifAlias,
      nextHop: route.nextHop,
      metric: this.getRoutes().find(r => netRouteKey(r) === key)?.routeMetric ?? 256,
    };
    if (update.publish !== undefined) entry.publish = update.publish;
    if (update.routeMetric !== undefined) entry.metric = update.routeMetric;
    if (update.validLifetimeSeconds !== undefined) entry.validLifetimeSeconds = update.validLifetimeSeconds;
    if (update.preferredLifetimeSeconds !== undefined) {
      entry.preferredLifetimeSeconds = update.preferredLifetimeSeconds;
    }
    this.state.extraRoutes.set(key, entry);
    return '';
  }
  setIPAddress(ip: string, ifAlias: string, opts: NetIPAddressUpdate): string {
    if (ip === '127.0.0.1' || ip === '::1') return 'Cannot modify loopback address.';
    const key = ip.toLowerCase();
    const cur = this.state.extraIPs.get(key);
    if (cur) {
      if (opts.prefixLength !== undefined) cur.prefixLength = opts.prefixLength;
      if (opts.skipAsSource !== undefined) cur.skipAsSource = opts.skipAsSource;
      if (opts.validLifetimeSeconds !== undefined) cur.validLifetimeSeconds = opts.validLifetimeSeconds;
      if (opts.preferredLifetimeSeconds !== undefined) cur.preferredLifetimeSeconds = opts.preferredLifetimeSeconds;
    }
    if (opts.prefixLength !== undefined && !ip.includes(':')) {
      const ports = this.pc.getPortsMap();
      const portName = this.portNameFor(ifAlias);
      const port = ports.get(portName);
      if (port && String(port.getIPAddress()) === ip) {
        (this.pc as unknown as { configureInterface: (n: string, a: IPAddress, m: SubnetMask) => void })
          .configureInterface(portName, new IPAddress(ip), new SubnetMask(prefixToMaskOctets(opts.prefixLength)));
      }
    }
    return '';
  }

  // ─ DNS ──────────────────────────────────────────────────────────────────

  getDnsServers(ifAlias: string): string[] {
    const m = this.pc as unknown as { getDnsServers?: (n: string) => string[] };
    return m.getDnsServers ? m.getDnsServers(toPortName(ifAlias) ?? ifAlias) : [];
  }
  setDnsServers(ifAlias: string, servers: string[]): void {
    const m = this.pc as unknown as { setDnsServers?: (n: string, s: string[]) => void };
    if (m.setDnsServers) m.setDnsServers(toPortName(ifAlias) ?? ifAlias, servers);
  }
  getDefaultGateway(): string | null {
    const m = this.pc as unknown as { getDefaultGatewayString?: () => string | null };
    return m.getDefaultGatewayString ? m.getDefaultGatewayString() : null;
  }
  getDhcpServer(ifAlias: string): string | null {
    const m = this.pc as unknown as { getDhcpServer?: (n: string) => string | null };
    return m.getDhcpServer ? m.getDhcpServer(toPortName(ifAlias) ?? ifAlias) : null;
  }
  isDHCPConfigured(ifAlias: string): boolean {
    return (this.pc as unknown as { isDHCPConfigured: (n: string) => boolean })
      .isDHCPConfigured(this.portNameFor(ifAlias));
  }
  testConnection(target: string): boolean {
    const probe = this.testPingProbe(target);
    return probe?.success ?? false;
  }
  resolveDns(name: string): string[] { return this.pc.resolveDnsSync(name); }
  resolveDnsWithOptions(name: string, options: {
    dnsOnly?: boolean; llmnrOnly?: boolean;
    noHostsFile?: boolean; cacheOnly?: boolean;
  }): string[] {
    return this.pc.resolveDnsSync(name, options);
  }
  resolveDnsViaServer(name: string, server: string): string[] { return this.pc.resolveDnsViaServerSync(name, server); }
  resolveDnsViaServerWithTtl(name: string, server: string): Array<{ ip: string; ttl: number }> {
    return this.pc.resolveDnsViaServerWithTtlSync(name, server);
  }
  getDnsClientCache(): DnsCacheRow[] {
    return dnsCacheRowsOf(this.pc.dnsCache.entries());
  }
  clearDnsClientCache(): void { this.pc.dnsCache.flush(); }
  invokeWebRequest(url: string) { return this.pc.invokeWebRequest(url); }
  sendMailMessage(opts: Parameters<WindowsPC['sendMailMessage']>[0]) { return this.pc.sendMailMessage(opts); }
  testPingProbe(target: string) {
    const ip = this.resolveTargetSync(target);
    if (!ip) return null;
    const r = this.pc.sendPingProbeSync(ip);
    return { success: r.success, rttMs: r.rttMs, resolvedIp: ip.toString() };
  }
  traceRoute(target: string): string[] {
    const ip = this.resolveTargetSync(target);
    if (!ip) return ['0.0.0.0'];
    const eg = this.pc.getEgressFor(ip);
    if (!eg) return ['0.0.0.0'];
    const probe = this.pc.sendPingProbeSync(ip);
    const nextHopStr = eg.nextHopIP.toString();
    const isDirect = nextHopStr === ip.toString() || nextHopStr === '0.0.0.0';
    const hops: string[] = [];
    if (!isDirect) hops.push(nextHopStr);
    hops.push(probe.success ? ip.toString() : '0.0.0.0');
    return hops;
  }
  testTcpProbe(target: string, port: number): boolean {
    const ip = this.resolveTargetSync(target);
    if (!ip) return false;
    return this.pc.tcpProbeSync(ip, port);
  }
  egressInfoFor(target: string) {
    const ip = this.resolveTargetSync(target);
    if (!ip) return null;
    const eg = this.pc.getEgressFor(ip);
    if (!eg) return null;
    return {
      sourceIp: eg.sourceIp.toString(),
      interfaceAlias: toDisplayName(eg.interfaceName),
      nextHop: eg.nextHopIP.toString(),
    };
  }
  private resolveTargetSync(target: string): IPAddress | null {
    // Same chain as cmd's ping: literal IP / hosts file / own name first,
    // then the full DNS chain (resolver cache + configured servers over
    // the wire). Without the DNS step, Test-NetConnection failed on names
    // that ping resolved fine (audit §2.1).
    const direct = this.pc.resolveHostnameSync(target);
    if (direct) return direct;
    const viaDns = this.pc.resolveDnsSync(target).find((ip) => !ip.includes(':'));
    if (!viaDns) return null;
    try { return new IPAddress(viaDns); } catch { return null; }
  }
  getNeighbors(): NeighborInfo[] {
    const pc = this.pc as unknown as {
      arpTable: Map<string, { mac: MACAddress; iface: string; type: 'dynamic' | 'static' | 'failed' }>;
      getPorts: () => Array<{ name: string }>;
      getNeighborCache?: () => Map<string, { mac: MACAddress; iface: string; state: string }>;
    };
    const ports = pc.getPorts();
    const indexOf = (iface: string): number => {
      const position = ports.findIndex(p => p.name === iface);
      return position < 0 ? LOOPBACK_IFINDEX : adapterIfIndex(position);
    };
    const arpState: Record<string, NetNeighborState> = {
      static: 'Permanent', dynamic: 'Reachable', failed: 'Unreachable',
    };
    const ndpState: Record<string, NetNeighborState> = {
      permanent: 'Permanent', reachable: 'Reachable', stale: 'Stale',
      delay: 'Delay', probe: 'Probe', incomplete: 'Incomplete',
    };
    const rows: NeighborInfo[] = [];
    for (const [ip, entry] of pc.arpTable) {
      rows.push({
        ifIndex: indexOf(entry.iface),
        ifAlias: toDisplayName(entry.iface),
        ipAddress: ip,
        linkLayerAddress: entry.mac.toWindowsString(),
        state: arpState[entry.type] ?? 'Reachable',
        addressFamily: 'IPv4',
        policyStore: entry.type === 'static' ? 'PersistentStore' : 'ActiveStore',
      });
    }
    for (const [ip, entry] of pc.getNeighborCache?.() ?? []) {
      const state = ndpState[entry.state] ?? 'Reachable';
      rows.push({
        ifIndex: indexOf(entry.iface),
        ifAlias: toDisplayName(entry.iface),
        ipAddress: ip,
        linkLayerAddress: entry.mac.toWindowsString(),
        state,
        addressFamily: 'IPv6',
        policyStore: state === 'Permanent' ? 'PersistentStore' : 'ActiveStore',
      });
    }
    return rows;
  }

  addNeighbor(plan: NetNeighborPlan): string {
    const ports = (this.pc as unknown as { getPorts: () => Array<{ name: string }> }).getPorts();
    const iface = plan.interfaceAlias !== undefined
      ? (toPortName(plan.interfaceAlias) ?? plan.interfaceAlias)
      : ports[plan.interfaceIndex! - LOOPBACK_IFINDEX - 1]?.name;
    if (iface === undefined || !ports.some(p => p.name === iface)) return NO_MATCHING_INTERFACE;
    if (plan.linkLayerAddress === null) {
      return "Cannot process command because of one or more missing mandatory parameters: LinkLayerAddress.";
    }
    if (plan.address.family === 'IPv6') {
      (this.pc as unknown as {
        addStaticNeighbor6: (ip: IPv6Address, mac: MACAddress, iface: string) => void;
      }).addStaticNeighbor6(plan.address.value, plan.linkLayerAddress, iface);
      return '';
    }
    (this.pc as unknown as { addStaticARP: (ip: IPAddress, mac: MACAddress, iface: string) => void })
      .addStaticARP(plan.address.value, plan.linkLayerAddress, iface);
    return '';
  }

  removeNeighbors(rows: readonly NeighborInfo[]): number {
    const pc = this.pc as unknown as {
      deleteARP: (ip: IPAddress) => boolean;
      removeNeighbor6: (ip: IPv6Address) => boolean;
    };
    let removed = 0;
    for (const row of rows) {
      const ok = row.addressFamily === 'IPv6'
        ? pc.removeNeighbor6(new IPv6Address(row.ipAddress))
        : pc.deleteARP(new IPAddress(row.ipAddress));
      if (ok) removed++;
    }
    return removed;
  }

  setNeighborLinkLayer(rows: readonly NeighborInfo[], linkLayerAddress: MACAddress): number {
    const pc = this.pc as unknown as {
      addStaticARP: (ip: IPAddress, mac: MACAddress, iface: string) => void;
      addStaticNeighbor6: (ip: IPv6Address, mac: MACAddress, iface: string) => void;
    };
    let changed = 0;
    for (const row of rows) {
      const iface = toPortName(row.ifAlias) ?? row.ifAlias;
      if (row.addressFamily === 'IPv6') {
        pc.addStaticNeighbor6(new IPv6Address(row.ipAddress), linkLayerAddress, iface);
      } else {
        pc.addStaticARP(new IPAddress(row.ipAddress), linkLayerAddress, iface);
      }
      changed++;
    }
    return changed;
  }

  clearNeighbors(ifAlias?: string): void {
    const pc = this.pc as unknown as {
      arpTable: Map<string, { iface: string }>;
      deleteARP: (ip: IPAddress) => boolean;
      clearNeighbors6: (iface?: string) => void;
    };
    if (!ifAlias) {
      pc.arpTable.clear();
      pc.clearNeighbors6();
      return;
    }
    const portName = toPortName(ifAlias) ?? ifAlias;
    for (const [ip, entry] of [...pc.arpTable]) {
      if (entry.iface.toLowerCase() === portName.toLowerCase()) {
        pc.deleteARP(new IPAddress(ip));
      }
    }
    pc.clearNeighbors6(portName);
  }

  getTcpConnections() {
    const table = (this.pc as unknown as { getSocketTable?: () => { getAll: () => Array<{ protocol: string; localAddress: string; localPort: number; remoteAddress: string; remotePort: number; state: string; pid: number }> } }).getSocketTable?.();
    if (!table) return [];
    return table.getAll()
      .filter(s => s.protocol.toLowerCase() === 'tcp')
      .map(s => ({
        localAddress:  s.localAddress,
        localPort:     s.localPort,
        remoteAddress: s.state === 'LISTEN' ? '0.0.0.0' : s.remoteAddress,
        remotePort:    s.state === 'LISTEN' ? 0 : s.remotePort,
        state:         s.state === 'LISTEN' ? 'Listen' : s.state,
        pid:           s.pid,
      }));
  }

  getUdpEndpoints() {
    const table = (this.pc as unknown as { getSocketTable?: () => { getAll: () => Array<{ protocol: string; localAddress: string; localPort: number; pid: number; processName: string }> } }).getSocketTable?.();
    if (!table) return [];
    return table.getAll()
      .filter(s => s.protocol.toLowerCase() === 'udp')
      .map(s => ({
        localAddress: s.localAddress,
        localPort:    s.localPort,
        pid:          s.pid,
        processName:  s.processName,
      }));
  }

  // ─ Firewall ─────────────────────────────────────────────────────────────

  getFirewallRules(): NetFirewallRuleEntry[] {
    return [...this.state.firewallRules.values()];
  }
  addFirewallRule(rule: NetFirewallRuleEntry): string {
    const key = firewallRuleKey(rule.name);
    if (this.state.firewallRules.has(key)) {
      return `Cannot create a file when that file already exists. Rule '${rule.name}' already exists.`;
    }
    this.state.firewallRules.set(key, { ...rule });
    return '';
  }
  updateFirewallRule(name: string, patch: Partial<NetFirewallRuleEntry>): void {
    const key = firewallRuleKey(name);
    const rule = this.state.firewallRules.get(key);
    if (!rule) return;
    Object.assign(rule, patch);
    if (patch.name !== undefined && firewallRuleKey(patch.name) !== key) {
      this.state.firewallRules.delete(key);
      this.state.firewallRules.set(firewallRuleKey(patch.name), rule);
    }
  }
  removeFirewallRule(name: string): void {
    this.state.firewallRules.delete(firewallRuleKey(name));
  }

  // ─ Adapter actions ──────────────────────────────────────────────────────

  setAdapterStatus(name: string, status: 'Up' | 'Down'): void {
    const entry = this.getAdapter(name);
    if (!entry) return;
    this.pc.getPort(entry.portName)?.setAdminDown(status !== 'Up');
  }
  renameAdapter(name: string, newName: string): void {
    const entry = this.getAdapter(name);
    if (!entry) return;
    this.pc.setAdapterAlias(entry.portName, newName);
  }
  setAdapterMac(portName: string, mac: MACAddress): void {
    this.pc.getPort(portName)?.setMAC(mac);
  }

  // ─ Network connection profile ──────────────────────────────────────────

  getNetworkProfile(ifIndex: number): string {
    return this.state.networkProfiles.get(ifIndex) ?? 'DomainAuthenticated';
  }
  setNetworkProfile(ifIndex: number, category: string): void {
    this.state.networkProfiles.set(ifIndex, category);
  }

  // ─ WLAN / proxy / native cmd execution — still legacy-only ─────────────

  getWlanSSID(): string         { return ''; }
  getWlanProfiles(): string[]   { return []; }
  getWinhttpProxy(): string     { return ''; }
  setWinhttpProxy(): void       { throw notImpl('setWinhttpProxy'); }
  async executeCmdCommand(): Promise<string> { throw notImpl('executeCmdCommand'); }
  runSyncNativeCommand(cmd: string, args: string[]): string | null {
    const m = this.pc as unknown as { runSyncNativeCommand?: (c: string, a: string[]) => string | null };
    return m.runSyncNativeCommand ? m.runSyncNativeCommand(cmd, args) : null;
  }
}

/** CIDR prefix length → 4-octet subnet mask. */
function prefixToMaskOctets(prefix: number): number[] {
  const bits = Math.max(0, Math.min(32, prefix));
  const m = bits === 0 ? 0 : 0xFFFFFFFF << (32 - bits);
  return [(m >>> 24) & 0xFF, (m >>> 16) & 0xFF, (m >>> 8) & 0xFF, m & 0xFF];
}

function notImpl(name: string): Error {
  // The cmdlet layer recognises "not implemented" and falls through to the
  // legacy PowerShellExecutor; keep the message in sync with isFallbackError.
  return new Error(commandNotFoundMessage(name));
}

// 255.255.255.0 → 24.
function maskToPrefixLength(mask: string): number {
  let bits = 0;
  for (const part of mask.split('.')) {
    bits += ((parseInt(part, 10) | 0) >>> 0).toString(2).split('').filter(b => b === '1').length;
  }
  return bits;
}

// ── VPN adapter (state still on the legacy executor) ─────────────────────

interface VpnState {
  readonly vpnConnections: Map<string, VpnConnectionInfo>;
}

class WindowsVpnAdapter implements IVpnProvider {
  private readonly activeClients = new Map<string, RemoteAccessVpnClient>();

  constructor(private readonly pc: WindowsPC, private readonly state: VpnState) {}

  listConnections(nameFilter?: string): VpnConnectionInfo[] {
    const all = Array.from(this.state.vpnConnections.values());
    return nameFilter
      ? all.filter(v => v.name.toLowerCase() === nameFilter.toLowerCase())
      : all;
  }
  getConnection(name: string): VpnConnectionInfo | null {
    return this.state.vpnConnections.get(name.toLowerCase()) ?? null;
  }
  addConnection(conn: VpnConnectionInfo): void {
    this.state.vpnConnections.set(conn.name.toLowerCase(), conn);
  }
  setConnection(name: string, opts: Partial<Omit<VpnConnectionInfo, 'name'>>): string {
    const cur = this.state.vpnConnections.get(name.toLowerCase());
    if (!cur) return `Cannot find VPN connection '${name}'.`;
    this.state.vpnConnections.set(name.toLowerCase(), { ...cur, ...opts });
    return '';
  }
  removeConnection(name: string): string {
    return this.state.vpnConnections.delete(name.toLowerCase())
      ? ''
      : `Cannot find VPN connection '${name}'.`;
  }
  addConnectionRoute(name: string, destinationPrefix: string): string {
    const key = name.toLowerCase();
    const cur = this.state.vpnConnections.get(key);
    if (!cur) return `Cannot find VPN connection '${name}'.`;
    this.state.vpnConnections.set(key, {
      ...cur, destinationPrefixes: [...cur.destinationPrefixes, destinationPrefix],
    });
    return '';
  }
  connect(name: string): string {
    const key = name.toLowerCase();
    const conn = this.state.vpnConnections.get(key);
    if (!conn) return `Cannot find VPN connection '${name}'.`;
    if (this.activeClients.has(key)) return `VPN connection '${name}' is already connected.`;
    const client = new RemoteAccessVpnClient({
      gatewayPublicIp: conn.serverAddress,
      corporateSubnets: conn.destinationPrefixes,
      mode: conn.splitTunneling ? 'split' : 'full',
    }, this.pc);
    try {
      client.connect();
    } catch (e) {
      return `Connect-VpnConnection : ${(e as Error).message}`;
    }
    this.activeClients.set(key, client);
    this.state.vpnConnections.set(key, { ...conn, connectionStatus: 'Connected' });
    return '';
  }
  disconnect(name: string): string {
    const key = name.toLowerCase();
    const conn = this.state.vpnConnections.get(key);
    if (!conn) return `Cannot find VPN connection '${name}'.`;
    const client = this.activeClients.get(key);
    if (!client) return `VPN connection '${name}' is not connected.`;
    client.disconnect();
    this.activeClients.delete(key);
    this.state.vpnConnections.set(key, { ...conn, connectionStatus: 'Disconnected' });
    return '';
  }
}

// ── Scheduled tasks ───────────────────────────────────────────────────────
//
// The seeded built-ins live on the device (`WindowsPC.scheduledTasks`),
// which is what both `schtasks` and the cmdlets read; this file used to
// keep a second, identical seed list of its own for a `shared` override
// nobody ever passed. Removed — one table, on the machine.

class WindowsScheduledTaskAdapter implements IScheduledTaskProvider {
  /**
   * Reads/writes go through the device's shared `scheduledTasks` map so
   * cmd `schtasks` and PS `*-ScheduledTask` cmdlets observe identical state.
   */
  constructor(private readonly pc: WindowsPC) {}

  private store(): Map<string, ScheduledTaskInfo> {
    return (this.pc as unknown as { scheduledTasks: Map<string, ScheduledTaskInfo> }).scheduledTasks;
  }

  listTasks(nameFilter?: string): ScheduledTaskInfo[] {
    const all = Array.from(this.store().values());
    if (!nameFilter) return all;
    // `-TaskName` désigne un nom, pas un fragment. Le filtre comparait en
    // sous-chaîne : `-TaskName T` rendait alors toute tâche dont le nom
    // contient un « t », c'est-à-dire presque toutes. Le vrai fait une
    // correspondance exacte, insensible à la casse, et n'accepte que `*`
    // et `?` comme jokers.
    const pattern = new RegExp(
      '^' + nameFilter.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i',
    );
    return all.filter((t) => pattern.test(t.taskName));
  }
  registerTask(task: ScheduledTaskInfo): string {
    // L'identité qui enregistre est celle de la session, pas un paramètre :
    // le cmdlet ne la connaît pas, la machine si. Sans elle `schtasks
    // /query /v` rendait « Author: N/A » sur une tâche pourtant nommée.
    task.author ??= `${this.pc.getHostname()}\\${this.pc.getCurrentUser()}`;
    task.runAsUser ??= this.pc.getCurrentUser();
    this.store().set(task.taskName.toLowerCase(), task);
    // 4698 — une tâche planifiée est un mécanisme de persistance
    // courant : la créer sans laisser de trace laissait un angle mort
    // complet dans la piste d'audit.
    this.pc.auditScheduledTaskCreated?.(task.taskName, task.command ?? '');
    return `\\${task.taskName}`;
  }
  unregisterTask(name: string): string {
    return this.store().delete(name.toLowerCase()) ? '' : `Cannot find scheduled task '${name}'.`;
  }
  updateTask(name: string, patch: Partial<ScheduledTaskInfo>): string {
    const task = this.store().get(name.toLowerCase());
    if (!task) return `Cannot find scheduled task '${name}'.`;
    Object.assign(task, patch);
    return '';
  }
  runTask(name: string): string {
    const task = this.store().get(name.toLowerCase());
    if (!task) return `Cannot find scheduled task '${name}'.`;
    // Le même chemin que `schtasks /run` : un démarrage manuel, qui vaut
    // même pour une tâche désactivée.
    (this.pc as unknown as { runScheduledTaskNow(t: ScheduledTaskInfo): void }).runScheduledTaskNow(task);
    return '';
  }
  now(): Date {
    return this.pc.simulatedDate();
  }
}

// ── Disks / volumes (read-only seeded data) ───────────────────────────────

class WindowsEnvironmentAdapter implements IEnvironmentProvider {
  constructor(private readonly pc: WindowsPC) {}

  private wellKnown(): Map<string, string> {
    return (this.pc as unknown as { getEnvVars?: () => Map<string, string> }).getEnvVars?.()
        ?? new Map<string, string>();
  }

  list(): Array<{ Name: string; Value: string }> {
    return Array.from(this.wellKnown().entries(), ([Name, Value]) => ({ Name, Value }));
  }

  get(name: string): string | undefined {
    return this.wellKnown().get(name.toUpperCase());
  }

  set(name: string, value: string): void {
    (this.pc as unknown as { setEnvVar?: (n: string, v: string) => void }).setEnvVar?.(name, value);
  }

  remove(name: string): void {
    (this.pc as unknown as { removeEnvVar?: (n: string) => void }).removeEnvVar?.(name);
  }
}

class WindowsDiskAdapter implements IDiskProvider {
  constructor(private readonly pc: WindowsPC) {}
  listDisks(): DiskInfo[] {
    const fs = this.pc.getFileSystem();
    return fs.listDrives().map((drive, index) => {
      const letter = drive.charAt(0).toUpperCase();
      const boot = letter === 'C';
      return {
        number: index,
        friendlyName: boot ? 'Microsoft Virtual Disk' : `Virtual HD ${letter}:`,
        size: fs.getDriveCapacity(letter),
        partitionStyle: 'MBR',
        operationalStatus: 'Online',
        uniqueId: `{00000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}}`,
        serialNumber: fs.getVolumeSerialNumber(letter).replace('-', ''),
        isBoot: boot,
        isSystem: boot,
      };
    });
  }
  listVolumes(): VolumeInfo[] {
    const fs = this.pc.getFileSystem();
    const labels: Record<string, string> = { C: 'Windows', D: 'Data' };
    return fs.listDrives().map(drive => {
      const letter = drive.charAt(0).toUpperCase();
      return {
        driveLetter: letter,
        fileSystemLabel: labels[letter] ?? 'Local Disk',
        fileSystem: 'NTFS',
        sizeRemaining: fs.getFreeDiskSpace(letter),
        size: fs.getDriveCapacity(letter),
        driveType: 'Fixed',
        healthStatus: 'Healthy',
        operationalStatus: 'OK',
      };
    });
  }
}

// ── Computer adapter (Add-Computer / domain join, PRD §5 P6) ─────────────
//
// Available on every Windows host (client or server) — unlike `ad`, this
// isn't gated by a role: any machine can join a domain someone else hosts.

interface JoinableDevice {
  resolveHostnameSync(name: string): { toString(): string } | null;
  joinDomainNow(
    domainName: string, dcAddress: string, credentialUser: string, credentialPassword: string,
    opts?: { ouPath?: string; newName?: string },
  ): AdOpResult;
  getDomainMembership(): DomainMembershipInfo | null;
  markServiceAccountInstalled(sam: string): void;
  hasServiceAccountInstalled(sam: string): boolean;
}

class WindowsComputerAdapter implements IComputerProvider {
  constructor(private readonly pc: WindowsPC) {}

  private device(): JoinableDevice { return this.pc as unknown as JoinableDevice; }

  join(domainName: string, credential: { username: string; password: string }, server?: string, opts?: { ouPath?: string; newName?: string }): AdOpResult {
    const dcAddress = server ?? this.pc.resolveHostnameSync(domainName)?.toString();
    if (!dcAddress) {
      return { ok: false, message: `Computer '${this.pc.getHostname()}' failed to join domain '${domainName}': The specified domain either does not exist or could not be contacted.` };
    }
    return this.device().joinDomainNow(domainName, dcAddress, credential.username, credential.password, opts);
  }

  getDomainInfo(): DomainMembershipInfo | null {
    return this.device().getDomainMembership();
  }

  discoverDomainController(): { hostName: string } | null {
    const membership = this.device().getDomainMembership();
    if (!membership) return null;
    const hostname = discoverDcHostname(this.pc.getTcpStack(), membership.dcAddress, membership.dnsName);
    return hostname ? { hostName: `${hostname}.${membership.dnsName}` } : null;
  }

  testSecureChannel(): boolean {
    return this.pc.testSecureChannel();
  }

  installServiceAccount(identity: string): AdOpResult {
    const membership = this.device().getDomainMembership();
    if (!membership) return { ok: false, message: 'Install-ADServiceAccount : The server is not joined to a domain.' };
    const conn = dialLdap(this.pc.getTcpStack(), membership.dcAddress);
    if (!conn.ok || !conn.client) return { ok: false, message: 'Install-ADServiceAccount : Unable to contact a domain controller.' };
    const bind = conn.client.bind(`${this.pc.getHostname()}$`, membership.machineSecret);
    if (!bind.ok) { conn.client.unbind(); return { ok: false, message: 'Install-ADServiceAccount : Access is denied.' }; }
    const sam = identity.endsWith('$') ? identity : `${identity}$`;
    const result = conn.client.search(rootDnOf(membership.dnsName), 'sub',
      { kind: 'equalityMatch', attr: 'sAMAccountName', value: sam },
      ['msDS-GroupMSAMembership', 'msDS-HostServiceAccount']);
    conn.client.unbind();
    const entry = result.entries[0];
    if (!entry) return { ok: false, message: `Install-ADServiceAccount : Cannot find an object with identity: '${identity}'.` };
    const principals = entry.attributes.find(a => a.type.toLowerCase() === 'msds-groupmsamembership')?.values ?? [];
    const hostServiceAccount = entry.attributes.find(a => a.type.toLowerCase() === 'msds-hostserviceaccount')?.values[0];
    const myHostname = this.pc.getHostname().toLowerCase();
    const authorized = principals.some(p => p.replace(/\$$/, '').toLowerCase() === myHostname)
      || (hostServiceAccount !== undefined && hostServiceAccount.toLowerCase().startsWith(`cn=${myHostname},`));
    if (!authorized) return { ok: false, message: 'Install-ADServiceAccount : Access is denied.' };
    this.device().markServiceAccountInstalled(sam);
    return { ok: true, message: '' };
  }

  testServiceAccount(identity: string): boolean {
    const sam = identity.endsWith('$') ? identity : `${identity}$`;
    return this.device().hasServiceAccountInstalled(sam);
  }

  remove(credential: { username: string; password: string }): AdOpResult {
    return this.pc.removeFromDomain(credential.username, credential.password);
  }

  rename(newName: string, credential?: { username: string; password: string }): AdOpResult {
    return this.pc.renameComputer(newName, credential);
  }
}

// ── Group Policy adapter (PRD-Windows-Server.md §5 P10) ──────────────────
// GPO authoring requires the GroupPolicy module, which (like ActiveDirectory)
// is only available on a domain controller in this simulator's scope — gated
// on `getDirectoryStore()` rather than a RoleManager feature.

class WindowsGpoAdapter implements IGpoProvider {
  constructor(private readonly pc: WindowsPC) {}

  private requireDc(cmdletName: string): DirectoryStore {
    const store = this.pc.getDirectoryStore();
    if (!store) throw new Error(commandNotFoundMessage(cmdletName));
    return store;
  }

  newGpo(name: string): AdOpResult {
    return this.requireDc('New-GPO').newGpo(name);
  }

  getGpo(name: string): GpoInfo | null {
    const gpo = this.requireDc('Get-GPO').getGpo(name);
    return gpo ? { id: gpo.id, name: gpo.name, links: gpo.links } : null;
  }

  listGpos(): GpoInfo[] {
    return this.requireDc('Get-GPO').listGpos().map(g => ({ id: g.id, name: g.name, links: g.links }));
  }

  newGPLink(gpoName: string, targetDn: string, opts?: GpLinkOptions): AdOpResult {
    return this.requireDc('New-GPLink').newGPLink(gpoName, targetDn, opts);
  }

  setGpLink(gpoName: string, targetDn: string, opts: GpLinkOptions): AdOpResult {
    return this.requireDc('Set-GPLink').setGpLink(gpoName, targetDn, opts);
  }

  setGpRegistryValue(gpoName: string, key: string, valueName: string, type: string, value: string): AdOpResult {
    return this.requireDc('Set-GPRegistryValue').setGpRegistryValue(gpoName, { key, valueName, type, value });
  }

  getDomainDn(): string {
    return this.requireDc('New-GPLink').getDomainDn();
  }

  setGpInheritance(targetDn: string, blocked: boolean): AdOpResult {
    return this.requireDc('Set-GPInheritance').setGpInheritance(targetDn, blocked);
  }

  getGpInheritance(targetDn: string): { dn: string; gpoInheritanceBlocked: boolean; gpoLinks: GpoLinkResultInfo[] } | null {
    return this.requireDc('Get-GPInheritance').getGpInheritance(targetDn);
  }
}

// ── IIS adapter (PRD-Windows-Server.md §5 P11) ────────────────────────────

class WindowsIisAdapter implements IIisProvider {
  constructor(private readonly pc: WindowsPC) {}

  private requireRole(cmdletName: string) {
    if (!this.pc.getRoleManager()?.isInstalled('Web-Server')) {
      throw new Error(commandNotFoundMessage(cmdletName));
    }
    const role = this.pc.getIisRole();
    if (!role) throw new Error(`${cmdletName} : The Web Server (IIS) service is not available on this computer.`);
    return role;
  }

  newWebsite(name: string, physicalPath: string, port: number, applicationPool?: string): IisOpResult {
    return this.requireRole('New-Website').newWebsite(name, physicalPath, port, applicationPool);
  }
  removeWebsite(name: string): IisOpResult { return this.requireRole('Remove-Website').removeWebsite(name); }
  getWebsite(name: string): WebsiteInfo | null { return this.requireRole('Get-Website').getWebsite(name); }
  listWebsites(): WebsiteInfo[] { return this.requireRole('Get-Website').listWebsites(); }
  startWebsite(name: string): IisOpResult { return this.requireRole('Start-Website').startSite(name); }
  stopWebsite(name: string): IisOpResult { return this.requireRole('Stop-Website').stopSite(name); }
  newBinding(name: string, protocol: 'http' | 'https', port: number, certificateThumbprint?: string): IisOpResult {
    return this.requireRole('New-WebBinding').newBinding(name, protocol, port, certificateThumbprint);
  }

  newAppPool(name: string, opts?: NewAppPoolOptions): IisOpResult { return this.requireRole('New-WebAppPool').newAppPool(name, opts); }
  removeAppPool(name: string): IisOpResult { return this.requireRole('Remove-WebAppPool').removeAppPool(name); }
  startAppPool(name: string): IisOpResult { return this.requireRole('Start-WebAppPool').startAppPool(name); }
  stopAppPool(name: string): IisOpResult { return this.requireRole('Stop-WebAppPool').stopAppPool(name); }
  recycleAppPool(name: string): IisOpResult { return this.requireRole('Restart-WebAppPool').recycleAppPool(name); }
  getAppPool(name: string): AppPoolInfo | null { return this.requireRole('Get-IISAppPool').getAppPool(name); }
  listAppPools(): AppPoolInfo[] { return this.requireRole('Get-IISAppPool').listAppPools(); }
  listGlobalModules(): WebModuleInfo[] { return this.requireRole('Get-WebGlobalModule').listGlobalModules(); }
}

// ── Exchange Server adapter (docs/PRD-Exchange.md §2.1 P1) ─────────────────

class WindowsExchangeAdapter implements IExchangeProvider {
  constructor(private readonly pc: WindowsPC) {}

  /** `Install-ExchangeServer` never needs an org to already exist — every other Exchange cmdlet does, and fails as "not recognized" (mimics the Exchange Management Shell module never having been loaded), matching docs/PRD-Exchange.md §1.3/§8. */
  private requireOrg(cmdletName: string): void {
    if (this.pc.getExchangeOrganizationName() === null) {
      throw new Error(commandNotFoundMessage(cmdletName));
    }
  }

  installExchangeServer(organizationName: string, roles: readonly string[]): ExchangeOpResult {
    return this.pc.installExchangeServer(organizationName, roles);
  }

  getExchangeServer(hostname?: string): ExchangeServerInfo | null {
    this.requireOrg('Get-ExchangeServer');
    const record = this.pc.getExchangeServer(hostname);
    const orgName = this.pc.getExchangeOrganizationName();
    if (!record || !orgName) return null;
    return { hostname: record.hostname, roles: [...record.roles], organizationName: orgName, installedAt: record.installedAt };
  }

  listExchangeServers(): ExchangeServerInfo[] {
    this.requireOrg('Get-ExchangeServer');
    const orgName = this.pc.getExchangeOrganizationName();
    if (!orgName) return [];
    return this.pc.listExchangeServers().map((record) => ({
      hostname: record.hostname, roles: [...record.roles], organizationName: orgName, installedAt: record.installedAt,
    }));
  }

  private mailboxToInfo(mailbox: MailboxRecord): MailboxInfo {
    return {
      identity: mailbox.adIdentity, primarySmtpAddress: mailbox.primarySmtpAddress,
      proxyAddresses: [...mailbox.proxyAddresses], quotaBytes: mailbox.quotaBytes,
    };
  }

  enableMailbox(identity: string): MailboxOpResult {
    this.requireOrg('Enable-Mailbox');
    return this.pc.enableMailbox(identity);
  }

  newMailbox(name: string, password: string): MailboxOpResult {
    this.requireOrg('New-Mailbox');
    return this.pc.newMailbox(name, password);
  }

  getMailbox(identity: string): MailboxInfo | null {
    this.requireOrg('Get-Mailbox');
    const mailbox = this.pc.getMailboxStore()?.get(identity) ?? null;
    return mailbox ? this.mailboxToInfo(mailbox) : null;
  }

  listMailboxes(): MailboxInfo[] {
    this.requireOrg('Get-Mailbox');
    return (this.pc.getMailboxStore()?.list() ?? []).map((m) => this.mailboxToInfo(m));
  }

  setMailboxQuota(identity: string, quotaBytes: number | null): MailboxOpResult {
    this.requireOrg('Set-Mailbox');
    const store = this.pc.getMailboxStore();
    if (!store) return { ok: false, message: 'Set-Mailbox : Exchange Server has not been installed on this computer.' };
    return store.setQuota(identity, quotaBytes);
  }

  getMailboxStatistics(identity: string): MailboxStatisticsInfo | null {
    this.requireOrg('Get-MailboxStatistics');
    const store = this.pc.getMailboxStore();
    const mailbox = store?.get(identity) ?? null;
    if (!store || !mailbox) return null;
    const folderItemCounts = Object.fromEntries(
      MAIL_FOLDER_NAMES.map((f) => [f, mailbox.folders[f].length]),
    ) as Record<MailFolderName, number>;
    return {
      identity: mailbox.adIdentity, totalItemSize: store.totalSizeBytes(mailbox),
      itemCount: store.totalItemCount(mailbox), folderItemCounts,
    };
  }

  disableMailbox(identity: string): MailboxOpResult {
    this.requireOrg('Disable-Mailbox');
    return this.pc.disableMailbox(identity);
  }

  removeMailbox(identity: string): MailboxOpResult {
    this.requireOrg('Remove-Mailbox');
    return this.pc.removeMailbox(identity);
  }

  newDistributionGroup(identity: string, type: 'Distribution' | 'Security'): ExchangeOpResult {
    this.requireOrg('New-DistributionGroup');
    return this.pc.newDistributionGroup(identity, type === 'Security' ? 'SecurityMailEnabled' : 'Distribution');
  }

  setDistributionGroupPrimarySmtpAddress(identity: string, address: string): ExchangeOpResult {
    this.requireOrg('Set-DistributionGroup');
    return this.pc.setDistributionGroupPrimarySmtpAddress(identity, address);
  }

  getDistributionGroup(identity: string): DistributionGroupInfo | null {
    this.requireOrg('Get-DistributionGroup');
    const group = this.pc.getDistributionGroupStore()?.get(identity) ?? null;
    return group ? { identity: group.adGroupSam, type: group.type, primarySmtpAddress: group.primarySmtpAddress } : null;
  }

  listDistributionGroups(): DistributionGroupInfo[] {
    this.requireOrg('Get-DistributionGroup');
    return (this.pc.getDistributionGroupStore()?.list() ?? []).map((g) => ({
      identity: g.adGroupSam, type: g.type, primarySmtpAddress: g.primarySmtpAddress,
    }));
  }

  addDistributionGroupMember(identity: string, member: string): ExchangeOpResult {
    this.requireOrg('Add-DistributionGroupMember');
    return this.pc.addDistributionGroupMember(identity, member);
  }

  getDistributionGroupMembers(identity: string): readonly string[] | null {
    this.requireOrg('Get-DistributionGroupMember');
    return this.pc.getDistributionGroupMembers(identity);
  }

  getGlobalAddressList(): GalEntryInfo[] {
    this.requireOrg('Get-GlobalAddressList');
    return this.pc.getGlobalAddressList().map((e) => ({
      displayName: e.displayName, samAccountName: e.samAccountName, primarySmtpAddress: e.primarySmtpAddress, kind: e.kind,
    }));
  }

  newReceiveConnector(def: ReceiveConnectorInfo): ExchangeOpResult {
    this.requireOrg('New-ReceiveConnector');
    return this.pc.newReceiveConnector(def);
  }

  getReceiveConnector(name: string): ReceiveConnectorInfo | null {
    this.requireOrg('Get-ReceiveConnector');
    return this.pc.getReceiveConnector(name);
  }

  listReceiveConnectors(): ReceiveConnectorInfo[] {
    this.requireOrg('Get-ReceiveConnector');
    return this.pc.listReceiveConnectors();
  }

  newSendConnector(def: SendConnectorInfo): ExchangeOpResult {
    this.requireOrg('New-SendConnector');
    return this.pc.newSendConnector(def);
  }

  getSendConnector(name: string): SendConnectorInfo | null {
    this.requireOrg('Get-SendConnector');
    return this.pc.getSendConnector(name);
  }

  listSendConnectors(): SendConnectorInfo[] {
    this.requireOrg('Get-SendConnector');
    return this.pc.listSendConnectors();
  }

  newTransportRule(rule: TransportRuleInfo): ExchangeOpResult {
    this.requireOrg('New-TransportRule');
    return this.pc.newTransportRule(rule);
  }

  getTransportRule(name: string): TransportRuleInfo | null {
    this.requireOrg('Get-TransportRule');
    return this.pc.getTransportRule(name);
  }

  listTransportRules(): TransportRuleInfo[] {
    this.requireOrg('Get-TransportRule');
    return this.pc.listTransportRules();
  }

  listQueues(): QueueInfo[] {
    this.requireOrg('Get-Queue');
    const queue = this.pc.getDeliveryQueue();
    if (!queue) return [];
    const counts = new Map<string, number>();
    for (const entry of queue.peekAll()) {
      const domain = domainOf(entry.recipient).toLowerCase();
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    return [...counts.entries()].map(([domain, messageCount]) => ({
      identity: domain, nextHopDomain: domain, messageCount,
      status: queue.isSuspended(domain) ? 'Suspended' : 'Active',
    }));
  }

  retryQueue(identity: string): ExchangeOpResult {
    this.requireOrg('Retry-Queue');
    const queue = this.pc.getDeliveryQueue();
    if (!queue) return { ok: false, message: 'Retry-Queue : Exchange Server has not been installed on this computer.' };
    void queue.retryNow(identity);
    return { ok: true, message: '' };
  }

  suspendQueue(identity: string): ExchangeOpResult {
    this.requireOrg('Suspend-Queue');
    const queue = this.pc.getDeliveryQueue();
    if (!queue) return { ok: false, message: 'Suspend-Queue : Exchange Server has not been installed on this computer.' };
    queue.suspend(identity);
    return { ok: true, message: '' };
  }

  resumeQueue(identity: string): ExchangeOpResult {
    this.requireOrg('Resume-Queue');
    const queue = this.pc.getDeliveryQueue();
    if (!queue) return { ok: false, message: 'Resume-Queue : Exchange Server has not been installed on this computer.' };
    queue.resume(identity);
    return { ok: true, message: '' };
  }

  addMailboxPermission(identity: string, user: string): ExchangeOpResult {
    this.requireOrg('Add-MailboxPermission');
    return this.pc.addMailboxPermission(identity, user);
  }

  addRecipientPermission(identity: string, trustee: string): ExchangeOpResult {
    this.requireOrg('Add-RecipientPermission');
    return this.pc.addRecipientPermission(identity, trustee);
  }

  getMailboxPermissionTrustees(identity: string): string[] {
    this.requireOrg('Get-MailboxPermission');
    return this.pc.getMailboxPermissions(identity, 'FullAccess');
  }

  getRecipientPermissionTrustees(identity: string): string[] {
    this.requireOrg('Get-RecipientPermission');
    return this.pc.getMailboxPermissions(identity, 'SendAs');
  }

  newJournalRule(journalEmailAddress: string): ExchangeOpResult {
    this.requireOrg('New-JournalRule');
    return this.pc.newJournalRule(journalEmailAddress);
  }

  getJournalRule(): TransportRuleInfo | null {
    this.requireOrg('Get-JournalRule');
    return this.pc.getJournalRule();
  }

  newDatabaseAvailabilityGroup(name: string): ExchangeOpResult {
    this.requireOrg('New-DatabaseAvailabilityGroup');
    return this.pc.newDatabaseAvailabilityGroup(name);
  }

  addDatabaseAvailabilityGroupServer(dagName: string, server: string): ExchangeOpResult {
    this.requireOrg('Add-DatabaseAvailabilityGroupServer');
    return this.pc.addDatabaseAvailabilityGroupServer(dagName, server);
  }

  addMailboxDatabaseCopy(dagName: string, database: string, server: string): ExchangeOpResult {
    this.requireOrg('Add-MailboxDatabaseCopy');
    return this.pc.addMailboxDatabaseCopy(dagName, database, server);
  }

  updateMailboxDatabaseCopy(dagName: string, database: string, server: string): ExchangeOpResult {
    this.requireOrg('Update-MailboxDatabaseCopy');
    return this.pc.updateMailboxDatabaseCopy(dagName, database, server);
  }

  getMailboxDatabaseCopyStatus(dagName: string, database?: string): MailboxDatabaseCopyInfo[] {
    this.requireOrg('Get-MailboxDatabaseCopyStatus');
    return this.pc.getMailboxDatabaseCopyStatus(dagName, database);
  }

  testServiceHealth(): ServiceHealthCheckInfo[] {
    this.requireOrg('Test-ServiceHealth');
    return this.pc.testServiceHealth();
  }

  testMailflow(fromIdentity: string, toIdentity: string): MailflowTestResultInfo {
    this.requireOrg('Test-Mailflow');
    return this.pc.testMailflow(fromIdentity, toIdentity);
  }
}

// ── DFS Namespaces + DFSR adapter (PRD-Windows-Server-Advanced.md §5 P16) ──

class WindowsDfsAdapter implements IDfsProvider {
  constructor(private readonly pc: WindowsPC) {}

  private requireNamespaceRole(cmdletName: string) {
    if (!this.pc.getRoleManager()?.isInstalled('FS-DFS-Namespace')) {
      throw new Error(commandNotFoundMessage(cmdletName));
    }
    const role = this.pc.getDfsNamespaceRole();
    if (!role) throw new Error(`${cmdletName} : DFS Namespaces is not available on this computer.`);
    return role;
  }

  private requireDfsrRole(cmdletName: string) {
    if (!this.pc.getRoleManager()?.isInstalled('FS-DFS-Replication')) {
      throw new Error(commandNotFoundMessage(cmdletName));
    }
    const role = this.pc.getDfsrRole();
    if (!role) throw new Error(`${cmdletName} : DFS Replication is not available on this computer.`);
    return role;
  }

  newDfsnRoot(namespacePath: string, options?: { type?: 'Standalone' | 'DomainV1' | 'DomainV2'; description?: string; target?: DfsTargetInfo }): DfsOpResult {
    return this.requireNamespaceRole('New-DfsnRoot').newRoot(namespacePath, options);
  }
  getDfsnRoot(namespacePath: string) { return this.requireNamespaceRole('Get-DfsnRoot').getRoot(namespacePath); }
  newDfsnFolder(namespacePath: string, folderName: string, target: DfsTargetInfo, description?: string): DfsOpResult {
    return this.requireNamespaceRole('New-DfsnFolder').newFolder(namespacePath, folderName, [target], description);
  }
  addDfsnFolderTarget(namespacePath: string, folderName: string, target: DfsTargetInfo): DfsOpResult {
    return this.requireNamespaceRole('New-DfsnFolderTarget').addFolderTarget(namespacePath, folderName, target);
  }
  setDfsnFolderTargetPriority(namespacePath: string, folderName: string, serverAddress: string, priorityClass: DfsReferralPriorityClassInfo): DfsOpResult {
    return this.requireNamespaceRole('Set-DfsnFolderTarget').setFolderTargetPriority(namespacePath, folderName, serverAddress, priorityClass);
  }
  getDfsnFolder(namespacePath: string, folderName: string): DfsFolderInfo | null {
    return this.requireNamespaceRole('Get-DfsnFolder').getFolder(namespacePath, folderName);
  }
  listDfsnFolders(namespacePath: string): DfsFolderInfo[] {
    return this.requireNamespaceRole('Get-DfsnFolder').listFolders(namespacePath);
  }

  newDfsReplicationGroup(groupName: string, contentPath: string): DfsOpResult {
    return this.requireDfsrRole('New-DfsReplicationGroup').newGroup(groupName, contentPath);
  }
  syncDfsReplicationGroup(groupName: string, partnerAddress: string): DfsrSyncResultInfo {
    return this.requireDfsrRole('Sync-DfsReplicationGroup').sync(groupName, partnerAddress);
  }
  registerDfsrAdminGroup(groupName: string, description: string): DfsOpResult {
    return this.requireDfsrRole('New-DfsReplicationGroup').registerAdminGroup(groupName, description);
  }
  getDfsrAdminGroup(groupName: string) {
    return this.requireDfsrRole('Get-DfsReplicationGroup').getAdminGroup(groupName);
  }
  addDfsrMembers(groupName: string, computerNames: string[]): DfsOpResult {
    return this.requireDfsrRole('Add-DfsrMember').addMembers(groupName, computerNames);
  }
  listDfsrMembers(groupName: string): string[] {
    return this.requireDfsrRole('Get-DfsrMember').listMembers(groupName);
  }
  newDfsReplicatedFolderAdmin(groupName: string, folderName: string): DfsOpResult {
    return this.requireDfsrRole('New-DfsReplicatedFolder').newReplicatedFolder(groupName, folderName);
  }
  addDfsrConnection(groupName: string, source: string, destination: string): DfsOpResult {
    return this.requireDfsrRole('Add-DfsrConnection').addConnection(groupName, source, destination);
  }
  setDfsrMembership(groupName: string, folderName: string, computerName: string, contentPath: string, primaryMember: boolean): DfsOpResult {
    return this.requireDfsrRole('Set-DfsrMembership').setMembership(groupName, folderName, computerName, contentPath, primaryMember);
  }
  listDfsrMemberships(groupName: string, folderName: string) {
    return this.requireDfsrRole('Get-DfsrMembership').listMemberships(groupName, folderName);
  }
}

// ── AD CS adapter (PRD-Windows-Server-Advanced.md §5 P13) ────────────────

class WindowsAdcsAdapter implements IAdcsProvider {
  constructor(private readonly pc: WindowsPC) {}

  private requireRole(cmdletName: string) {
    if (!this.pc.getRoleManager()?.isInstalled('AD-Certificate')) {
      throw new Error(commandNotFoundMessage(cmdletName));
    }
    const role = this.pc.getAdcsRole();
    if (!role) throw new Error(`${cmdletName} : Active Directory Certificate Services is not available on this computer.`);
    return role;
  }

  installCA(caCommonName: string): AdcsOpResult {
    return this.requireRole('Install-AdcsCertificationAuthority').installCA(caCommonName);
  }

  listTemplates(): CaTemplateInfo[] {
    return this.requireRole('Get-CATemplate').listTemplates();
  }

  addTemplate(name: string): AdcsOpResult {
    return this.requireRole('Add-CATemplate').addTemplate(name);
  }

  getCertificate(templateName: string, dnsName: string, requestedEku?: string): CertificateRequestResultInfo {
    const res = this.requireRole('Get-Certificate').submitRequest(`CN=${dnsName}`, templateName, { requestedEku });
    if (!res.ok) return { ok: false, message: res.message };
    const c = res.certificate!;
    // PRD §5 P14 — feed the personal store so `New-WebBinding -CertificateHash`
    // can reference an AD CS-issued cert exactly like a self-signed one.
    this.pc.getCertStore().add(c, res.privateKey!);
    return {
      ok: true, message: res.message,
      certificate: { serialNumber: c.serialNumber, subject: c.subject, issuer: c.issuer, notBefore: c.notBefore, notAfter: c.notAfter },
    };
  }
}

// ── Personal certificate store adapter (PRD-Windows-Server-Advanced.md §5 P14) ──
// Unconditional (no RoleManager gate): the PKI client module ships on every
// Windows SKU, not just servers with a role installed.

class WindowsPkiAdapter implements IPkiProvider {
  constructor(private readonly pc: WindowsPC) {}

  newSelfSignedCertificate(dnsName: string): IssuedCertInfo & { thumbprint: string } {
    const now = this.pc.simulatedDate().getTime();
    const { cert, privateKey } = generateSelfSignedCertificate(`CN=${dnsName}`, { now, extKeyUsage: ['serverAuth'] });
    const thumbprint = this.pc.getCertStore().add(cert, privateKey);
    return { thumbprint, serialNumber: cert.serialNumber, subject: cert.subject, issuer: cert.issuer, notBefore: cert.notBefore, notAfter: cert.notAfter };
  }

  listCertificates(): (IssuedCertInfo & { thumbprint: string })[] {
    return this.pc.getCertStore().list().map(c => ({
      thumbprint: c.serialNumber, serialNumber: c.serialNumber, subject: c.subject, issuer: c.issuer,
      notBefore: c.notBefore, notAfter: c.notAfter,
    }));
  }
}

// ── RDP adapter (PRD-Windows-Server-Advanced.md §5 P17) ───────────────────
// Unconditional (no RoleManager gate): Remote Desktop ships on every
// Windows SKU, matching WinRM's own unconditional wiring.

class WindowsRdpAdapter implements IRdpProvider {
  constructor(private readonly pc: WindowsPC) {}

  enable(): RdpOpResult { this.pc.rdp.enable(); return { ok: true, message: '' }; }
  disable(): RdpOpResult { this.pc.rdp.disable(); return { ok: true, message: '' }; }

  listSessions(): RdpSessionInfo[] { return this.pc.rdp.sessions.list(); }

  logoff(sessionId: number): RdpOpResult {
    const existed = this.pc.rdp.sessions.logoff(sessionId);
    if (!existed) return { ok: false, message: `logoff : No session exists for ID ${sessionId}.` };
    return { ok: true, message: '' };
  }
}

// ── Failover Clustering / WSFC adapter (Server Manager — WindowsServer only, gated on Failover-Clustering) ──

class WindowsClusterAdapter implements IClusterProvider {
  constructor(private readonly pc: WindowsPC) {}

  private requireRole(cmdletName: string): void {
    if (!this.pc.getRoleManager()?.isInstalled('Failover-Clustering')) {
      throw new Error(commandNotFoundMessage(cmdletName));
    }
  }

  /** Most cluster cmdlets additionally need `New-Cluster` to have actually run on this node. */
  private requireCluster(cmdletName: string) {
    this.requireRole(cmdletName);
    const cluster = this.pc.getClusterRole();
    if (!cluster) throw new Error(`${cmdletName} : No cluster was found on this server. Access to a remote cluster may be blocked by the firewall.`);
    return cluster;
  }

  newCluster(clusterName: string, selfNodeName: string, peers: ClusterPeerInfo[]): ClusterOpResult {
    this.requireRole('New-Cluster');
    const server = this.pc as WindowsServer;
    if (typeof server.newCluster !== 'function') {
      return { ok: false, message: 'New-Cluster : This computer cannot host a failover cluster.' };
    }
    return server.newCluster(clusterName, selfNodeName, peers);
  }

  getClusterNodes(): ClusterNodeInfo[] { return this.requireCluster('Get-ClusterNode').listNodes(); }
  hasClusterQuorum(): boolean { return this.requireCluster('Get-Cluster').hasQuorum(); }

  addClusterFileServerRole(name: string, preferredOwners: string[]): ClusterOpResult {
    return this.requireCluster('Add-ClusterFileServerRole').groups.addFileServerRole(name, preferredOwners);
  }

  getClusterGroups(): ClusterGroupInfo[] { return this.requireCluster('Get-ClusterGroup').groups.listGroups(); }

  moveClusterGroup(name: string, targetNode: string): ClusterOpResult {
    return this.requireCluster('Move-ClusterGroup').groups.moveGroup(name, targetNode);
  }
}

// ── WSUS adapter (Server Manager — WindowsServer only, gated on UpdateServices) ──

class WindowsWsusAdapter implements IWsusProvider {
  constructor(private readonly pc: WindowsPC) {}

  private requireRole(cmdletName: string) {
    if (!this.pc.getRoleManager()?.isInstalled('UpdateServices')) {
      throw new Error(commandNotFoundMessage(cmdletName));
    }
    const role = this.pc.getWsusRole();
    if (!role) throw new Error(`${cmdletName} : Windows Server Update Services is not available on this computer.`);
    return role;
  }

  listCatalog(): WsusUpdateInfo[] { return this.requireRole('Get-WsusUpdate').listCatalog(); }

  approveUpdate(kbId: string, targetGroup: string, action: WsusApprovalActionInfo): WsusOpResult {
    return this.requireRole('Approve-WsusUpdate').approve(kbId, targetGroup, action);
  }
}

// ── Windows Update client adapter (unconditional — every SKU) ────────────

class WindowsUpdateClientAdapter implements IWindowsUpdateProvider {
  constructor(private readonly pc: WindowsPC) {}

  setWuSettings(wuServer: string, targetGroup?: string): void {
    this.pc.wsus.setWuServer(wuServer);
    if (targetGroup !== undefined) this.pc.wsus.setTargetGroup(targetGroup);
  }

  getWindowsUpdates(): WsusUpdateInfo[] { return this.pc.getWindowsUpdates(); }
}

// ── Print and Document Services adapter (Server Manager — WindowsServer only, gated on Print-Services) ──

class WindowsPrintAdapter implements IPrintProvider {
  constructor(private readonly pc: WindowsPC) {}

  private requireRole(cmdletName: string) {
    if (!this.pc.getRoleManager()?.isInstalled('Print-Services')) {
      throw new Error(commandNotFoundMessage(cmdletName));
    }
    const role = this.pc.getPrintServerRole();
    if (!role) throw new Error(`${cmdletName} : Print and Document Services is not available on this computer.`);
    return role;
  }

  addPrinter(shareName: string): PrintOpResult { return this.requireRole('Add-Printer').addPrinter(shareName); }

  getPrintJobs(shareName: string): PrintJobInfo[] {
    return this.requireRole('Get-PrintJob').listJobs(shareName).map((j) => ({
      id: j.id, document: j.document, owner: j.owner, submittedAt: j.submittedAt.getTime(), size: j.size, status: j.status,
    }));
  }

  removePrintJob(shareName: string, jobId: number): PrintOpResult {
    return this.requireRole('Remove-PrintJob').removeJob(shareName, jobId);
  }
}

// ── Licensing adapter (unconditional — every SKU) ─────────────────────────

class WindowsLicensingAdapter implements ILicensingProvider {
  constructor(private readonly pc: WindowsPC) {}

  getProductName(): string {
    return this.pc.getDeviceType() === 'windows-server'
      ? WINDOWS_SERVER_PRODUCT_IDENTITY.productName
      : WINDOWS_CLIENT_PRODUCT_IDENTITY.productName;
  }

  getState(): LicenseStateInfo { return this.pc.licensing.getState(); }
  getProductKey(): string | null { return this.pc.licensing.getProductKey(); }
}

// ── Remoting adapter (Invoke-Command -ComputerName / Test-WSMan) ──────────
//
// Resolves the target through the same simulated-topology lookup the SSH
// clients use (`findHostByAddress`), then — when the target is genuinely a
// WindowsPC — hands back a handle onto ITS OWN memoized PSInterpreter, so a
// script block dispatched there truly runs against that device's services /
// processes / registry / event log, not the caller's.

interface RemotableDevice {
  getHostname(): string;
  getPowerShellInterpreter(): { invokeRemote(block: PSScriptBlock, positionalArgs: PSValue[]): PSValue };
  winrm: { enabled: boolean };
}

class WindowsRemotingAdapter implements IRemotingProvider {
  constructor(private readonly pc: WindowsPC) {}

  private local(): { winrm: { enable(): void; enabled: boolean; credSSP: boolean } } {
    return this.pc as unknown as { winrm: { enable(): void; enabled: boolean; credSSP: boolean } };
  }

  /**
   * PRD-Windows-Server.md §5 P4: reachability (and, when a credential is
   * supplied, authentication) is now decided by a real TCP/5985 dial
   * through this device's own `TcpStack` — genuine routing/cables/
   * firewalls — rather than a topology-wide `findHostByAddress` lookup.
   * `findHostByAddress` is still used to obtain the target DEVICE OBJECT
   * once the real dial has confirmed reachability: this simulator runs
   * every device in one JS process, so script execution itself still
   * delegates to the target's own interpreter (`invokeRemote`) — there is
   * no real wire representation of a `PSScriptBlock` AST to ship, only
   * the connection-establishment step is real.
   */
  resolveComputer(name: string, credential?: { username: string; password: string }): IRemoteComputer | null {
    const targetIp = this.pc.resolveHostnameSync(name);
    if (!targetIp) return null;
    const found = findHostByAddress(targetIp.toString());
    if (!found || found.poweredOff || found.interfaceDown) return null;
    const device = found.device as unknown as Partial<RemotableDevice>;
    if (typeof device.getPowerShellInterpreter !== 'function' || !device.winrm) return null;

    if (credential) {
      const dial = this.pc.dialWinRm(targetIp.toString(), credential.username, credential.password);
      if (!dial.ok) return null;
    } else {
      const probe = this.pc.getTcpStack().connect(targetIp.toString(), 5985);
      if (!probe || probe.state !== 'established') return null;
      probe.close();
    }

    const interp = device.getPowerShellInterpreter();
    const hostname = device.getHostname?.() ?? name;
    const winrm = device.winrm;
    return {
      hostname,
      invoke: (block, positionalArgs) => interp.invokeRemote(block, positionalArgs),
      isRemotingEnabled: () => winrm.enabled,
    };
  }

  enablePSRemoting(): void { this.local().winrm.enable(); }
  isLocalRemotingEnabled(): boolean { return this.local().winrm.enabled; }
  isLocalCredSSPEnabled(): boolean { return this.local().winrm.credSSP; }
}

// ── Public factory ─────────────────────────────────────────────────────────

/**
 * Build a PSProviders bag backed by a real WindowsPC device.
 *
 * A machine has ONE registry, ONE event log and ONE set of network
 * tables, and every door into it — the `reg`/`netsh` commands of `cmd`,
 * the cmdlets of PowerShell, the legacy PowerShellExecutor — must reach
 * that same store, or the same box answers two different things about
 * itself depending on which shell you asked. So the default for every
 * piece of shared state is the device's own field, never a fresh
 * detached object: a caller that passes no `shared` bag gets a
 * PowerShell wired to the real machine, not to a private copy of it.
 * (The defaults used to be detached, and both production call sites
 * spelled the six fields out by hand to avoid them — which worked right
 * up until a third caller forgot.)
 *
 * The `shared` argument therefore exists only to let a caller substitute
 * a store deliberately. Production callers can, and should, omit it.
 */

export function createWindowsPSProviders(
  pc: WindowsPC,
  shared?: {
    registry?:       PSRegistryProvider;
    eventLog?:       PSEventLogProvider;
    network?:        NetworkStateRefs;
    vpn?:            VpnState;
  },
): PSProviders {
  const reg = shared?.registry ?? pc.registry;
  const log = shared?.eventLog ?? pc.eventLog;
  const net = shared?.network ?? {
    extraIPs:             pc.extraIPs,
    extraRoutes:          pc.extraRoutes,
    firewallRules: pc.firewallRules,
    networkProfiles:      pc.networkProfiles,
  };
  const vpn = shared?.vpn ?? { vpnConnections: pc.vpnConnections };
  return {
    filesystem:     new WindowsFileSystemAdapter(pc),
    services:       new WindowsServiceAdapter(pc),
    processes:      new WindowsProcessAdapter(pc),
    jobs:           new JobProvider({
      now: () => (pc as unknown as { simulatedNow: () => number }).simulatedNow(),
      advance: (ms) => (pc as unknown as { advanceTime: (ms: number) => void }).advanceTime(ms),
    }),
    users:          new WindowsUserAdapter(pc),
    registry:       new WindowsRegistryAdapter(reg),
    eventLog:       new WindowsEventLogAdapter(log, pc),
    network:        new WindowsNetworkAdapter(pc, net),
    vpn:            new WindowsVpnAdapter(pc, vpn),
    // Le fuseau vit sur l'identite de la machine, la meme que
    // `timedatectl` lit cote Linux (`PRD-NTP-Tutoriel.md` §5).
    identity: (pc as unknown as { getTimezoneStore?: () => { timezone: string; setTimezone(n: string): void } }).getTimezoneStore?.() ?? null,
    scheduledTasks: new WindowsScheduledTaskAdapter(pc),
    disks:          new WindowsDiskAdapter(pc),
    environment:    new WindowsEnvironmentAdapter(pc),
    remoting:       new WindowsRemotingAdapter(pc),
    roles:          pc.getRoleManager() ? new WindowsRoleAdapter(pc) : null,
    smb:            pc.getRoleManager() ? new WindowsSmbAdapter(pc) : null,
    ad:             pc.getRoleManager() ? new WindowsAdAdapter(pc) : null,
    computer:       new WindowsComputerAdapter(pc),
    dns:            pc.getRoleManager() ? new WindowsDnsServerAdapter(pc) : null,
    dhcp:           pc.getRoleManager() ? new WindowsDhcpServerAdapter(pc) : null,
    nps:            pc.getRoleManager() ? new WindowsNpsAdapter(pc) : null,
    gpo:            new WindowsGpoAdapter(pc),
    iis:            pc.getRoleManager() ? new WindowsIisAdapter(pc) : null,
    exchange:       pc.getRoleManager() ? new WindowsExchangeAdapter(pc) : null,
    adcs:           pc.getRoleManager() ? new WindowsAdcsAdapter(pc) : null,
    pki:            new WindowsPkiAdapter(pc),
    dfs:            pc.getRoleManager() ? new WindowsDfsAdapter(pc) : null,
    rdp:            new WindowsRdpAdapter(pc),
    cluster:        pc.getRoleManager() ? new WindowsClusterAdapter(pc) : null,
    wsus:           pc.getRoleManager() ? new WindowsWsusAdapter(pc) : null,
    windowsUpdate:  new WindowsUpdateClientAdapter(pc),
    print:          pc.getRoleManager() ? new WindowsPrintAdapter(pc) : null,
    licensing:      new WindowsLicensingAdapter(pc),
  };
}
