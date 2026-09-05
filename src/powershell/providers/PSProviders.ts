/**
 * PSProviders — Dependency-injection bag for system resource providers.
 *
 * Each interface defines the minimal surface a category of Windows cmdlets needs.
 * The PSRuntime receives a PSProviders instance at construction time; core cmdlets
 * (Write-Host, ForEach-Object, etc.) do not use providers at all.
 *
 * Concrete implementations:
 *   - WindowsPSProviders (src/powershell/providers/WindowsPSProviders.ts)
 *     → wraps the real WindowsPC managers (filesystem, registry, services…)
 *   - NullProviders (src/powershell/providers/NullProviders.ts)
 *     → all nulls, used by the standalone PSInterpreter (no Windows device)
 */

import type { GroupWriteOptions, OrgUnitWriteOptions, UserWriteOptions } from '@/network/devices/windows/server/ad/DirectoryStore';

import type { AddsForestOptions } from '@/network/devices/windows/server/ad/adFunctionalLevels';
import type { RemoteDirectoryTarget } from './adRemoteDirectory';
import type { NetRouteIdentity, NetRouteUpdate } from '@/network/devices/windows/netRoute';
import type { NetFirewallRuleEntry } from '@/network/devices/windows/netFirewallRule';
import type { NetAdapterEntry } from '@/network/devices/windows/netAdapter';
import type { NetNeighborPlan, NetNeighborRow } from '@/network/devices/windows/netNeighbor';
import type { DnsCacheRow } from '@/network/devices/windows/dnsClientCache';

// ─── Entry types re-exported for cmdlet use ────────────────────────────────

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  mtime: Date;
  attributes?: Set<string>;
  owner?: string;
}

export interface RegistryValue {
  name: string;
  value: string | number;
  type: 'String' | 'DWord' | 'QWord' | 'ExpandString' | 'MultiString' | 'Binary';
}

export interface ServiceInfo {
  name: string;
  displayName: string;
  description: string;
  state: string;
  startType: string;
  serviceType: string;
  binaryPath: string;
  account: string;
  /** Services this one depends on (ServicesDependedOn). */
  dependencies: string[];
  /** Services that depend on this one (DependentServices) — reverse lookup. */
  dependents: string[];
  canPauseAndContinue: boolean;
  /** PID of the hosting process, or 0 when not running. */
  processId: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  ppid: number;
  owner: string;
  handles: number;
  npmK: number;
  pmK: number;
  wsK: number;
  cpuSec: number;
  threads: number;
  cpuPercent: number;
  status: string;
  sessionId: number;
  critical: boolean;
}

export interface UserInfo {
  name: string;
  fullName: string;
  description: string;
  sid: string;
  enabled: boolean;
  passwordRequired: boolean;
  lastLogon: Date | null;
}

export interface GroupInfo {
  name: string;
  description: string;
  sid: string;
  members: string[];
}

export interface EventLogEntryInfo {
  index: number;
  timeGenerated: Date;
  entryType: string;
  source: string;
  eventId: number;
  category: string;
  message: string;
  data?: Record<string, string>;
}

export type { NetAdapterEntry };

export interface IPAddressInfo {
  ipAddress: string;
  prefixLength: number;
  ifAlias: string;
  ifIndex: number;
  prefixOrigin: string;
  suffixOrigin: string;
  addressFamily: string;
  gateway?: string;
  /** Residual DHCP lease lifetimes (seconds); undefined for non-leased addresses. */
  validLifetimeSeconds?: number;
  preferredLifetimeSeconds?: number;
  skipAsSource?: boolean;
  type?: 'Unicast' | 'Anycast';
  policyStore?: 'ActiveStore' | 'PersistentStore';
}

export interface RouteInfo {
  destinationPrefix: string;
  ifAlias: string;
  ifIndex?: number;
  nextHop: string;
  routeMetric: number;
  addressFamily?: string;
  publish?: 'No' | 'Age' | 'Yes';
  protocol?: string;
  policyStore?: 'ActiveStore' | 'PersistentStore';
  validLifetimeSeconds?: number;
  preferredLifetimeSeconds?: number;
}

// ─── PowerShell Remoting (Invoke-Command -ComputerName / Test-WSMan) ───────

export interface IRemoteComputer {
  readonly hostname: string;
  /** Genuinely execute the script block against the remote machine's OWN
   *  runtime (its own services/processes/registry/event log), returning
   *  whatever the block's pipeline produced. */
  invoke(block: import('@/powershell/parser/PSASTNode').PSScriptBlock, positionalArgs: import('@/powershell/runtime/PSEnvironment').PSValue[]): import('@/powershell/runtime/PSEnvironment').PSValue;
  /** Whether the target has `Enable-PSRemoting` applied (WinRM listening). */
  isRemotingEnabled(): boolean;
}

export interface WindowsFeatureInfo {
  name: string;
  displayName: string;
  installState: 'Installed' | 'Available';
  featureType: 'Role' | 'Role Service' | 'Feature';
  psModule?: string;
}

export interface IRoleProvider {
  listFeatures(): WindowsFeatureInfo[];
  getFeature(name: string): WindowsFeatureInfo | null;
  isInstalled(name: string): boolean;
  installFeature(name: string, opts?: { includeManagementTools?: boolean; whatIf?: boolean }):
    { ok: boolean; message: string; changed: readonly WindowsFeatureInfo[] };
  uninstallFeature(name: string): { ok: boolean; message: string; changed: readonly WindowsFeatureInfo[] };
}

export interface SmbShareInfo {
  name: string;
  path: string;
  description: string;
  special: boolean;
}

export interface SmbSessionInfo {
  id: number;
  clientComputerName: string;
  clientIp: string;
  user: string;
  shares: string[];
  numOpens: number;
}

export interface ISmbProvider {
  listShares(): SmbShareInfo[];
  getShare(name: string): SmbShareInfo | null;
  newShare(name: string, path: string, opts?: { fullAccess?: string[]; changeAccess?: string[]; readAccess?: string[] }):
    { ok: boolean; message: string };
  removeShare(name: string): { ok: boolean; message: string };
  listSessions(): SmbSessionInfo[];
}

// ── AD DS (Active Directory Domain Services) ────────────────────────────────

export interface AdUserInfo {
  sam: string; upn: string; dn: string; sid: string; enabled: boolean; memberOf: string[]; fullName: string;
  department: string; title: string; emailAddress: string; passwordLastSet: string; passwordNeverExpires: boolean;
  servicePrincipalNames: string[];
  properties: Record<string, string>;
  flags: Record<string, boolean>;
  accountExpirationDate: Date | null;
  cannotChangePassword: boolean;
  changePasswordAtLogon: boolean;
  /** Roaming profile (`ProfilePath`), redirected home folder (`HomeDirectory`/`HomeDrive`) — real LDAP `profilePath`/`homeDirectory`/`homeDrive` attributes, PRD AD roaming-profiles gap. */
  profilePath: string; homeDirectory: string; homeDrive: string;
}

/** A raw AD object of any class — `Get-ADObject`/`Set-ADObject`/`Restore-ADObject` (PRD AD Recycle Bin). See `AdGenericObject` in `AdTypes.ts` for the rationale of exposing raw attributes rather than a fixed shape. */
export interface AdGenericObjectInfo {
  dn: string; name: string; objectClass: string; isDeleted: boolean;
  lastKnownParent?: string; whenChanged?: string; attributes: Record<string, string[]>;
}
export interface AdMemberLink { dn: string; ttlSeconds?: number }

export interface AddGroupMemberOptions {
  permissiveModify?: boolean;
  ttlSeconds?: number;
  partition?: string;
  target?: RemoteDirectoryTarget;
}

export interface AdOptionalFeatureInfo { name: string; enabledScopes: string[] }

export interface AdAccessRuleInfo {
  identitySam: string;
  rights: string;
  accessControlType: 'Allow' | 'Deny';
  objectType: string;
  inheritanceType: string;
  inheritedObjectType: string;
}
export interface AdGroupInfo {
  sam: string; dn: string; name: string;
  scope: 'DomainLocal' | 'Global' | 'Universal'; category: 'Security' | 'Distribution';
  properties: Record<string, string>; members: string[];
}
export interface AdComputerInfo {
  name: string; dn: string; enabled: boolean; servicePrincipalNames: string[];
  /** The site this DC is (explicitly or IP-derived) assigned to — undefined for a plain (non-DC) computer object. */
  site?: string | null;
  /** This DC's resolved IPv4 address — undefined for a plain (non-DC) computer object. */
  ipv4Address?: string | null;
}
export interface AdOrgUnitInfo {
  name: string; dn: string; gpLinks: string[];
  properties: Record<string, string>;
  protectedFromAccidentalDeletion: boolean;
}
export interface AdOpResult { ok: boolean; message: string }
export interface AdSubnetInfo { cidr: string; dn: string; site: string; description: string }
export type AdSiteLinkTransport = 'IP' | 'SMTP';
export interface AdSiteLinkInfo {
  name: string; dn: string; sitesIncluded: string[]; cost: number;
  replicationFrequencyInMinutes: number; interSiteTransportProtocol: AdSiteLinkTransport; description: string;
}
export interface AdUpToDatenessVectorRowInfo { server: string; usnFilter: number; lastReplicationSuccess: string }

export interface IAdProvider {
  /** `Install-ADDSForest` — promotes this server to a new forest's first DC. Fails if already promoted. */
  installForest(domainName: string, netbiosName: string | undefined, safeModeAdminPassword: string, opts?: AddsForestOptions): AdOpResult;
  /** Whether this server has already been promoted (`Install-ADDSForest` succeeded). */
  isForestInstalled(): boolean;
  /** `Install-ADDSDomainController` (PRD-Windows-Server-Advanced.md §5 P5) — promotes this server as an additional DC of a domain that already exists at `sourceDcAddress`, via a real initial replication sync. */
  installDomainController(
    domainName: string, netbiosName: string | undefined, sourceDcAddress: string,
    credentialUser: string, credentialPassword: string, safeModeAdminPassword: string,
    opts?: { installDns?: boolean },
  ): AdOpResult;
  /** `Get-ADDomainController` — every domain controller this DC currently knows about (itself, plus any replicated in). */
  listDomainControllers(): AdComputerInfo[];
  /** `Remove-ADDomainController` — AD metadata cleanup for a DC that will never come back online (the `ntdsutil metadata cleanup` equivalent). */
  removeDomainController(name: string): AdOpResult;

  newUser(sam: string, opts: { password: string; fullName?: string; path?: string; enabled?: boolean; department?: string; title?: string; emailAddress?: string; passwordNeverExpires?: boolean; actingSam?: string } & UserWriteOptions): AdOpResult;
  getUser(identity: string): AdUserInfo | null;
  listUsers(): AdUserInfo[];
  setUser(identity: string, opts: { enabled?: boolean; fullName?: string; password?: string; department?: string; title?: string; addSpns?: string[]; removeSpns?: string[]; actingSam?: string; profilePath?: string; homeDirectory?: string; homeDrive?: string }): AdOpResult;
  removeUser(identity: string): AdOpResult;
  /** Every user/computer object carrying at least one SPN — for cross-object duplicate-SPN detection (`Get-ADObject -Filter {ServicePrincipalName -like "*"}`). */
  listObjectsWithSpns(): Array<{ name: string; servicePrincipalNames: string[] }>;
  /** `Search-ADAccount -LockedOut`. */
  listLockedOutUsers(): Array<{ sam: string; name: string; badPwdCount: number }>;

  newGroup(sam: string, scope: AdGroupInfo['scope'], path?: string, category?: AdGroupInfo['category'], opts?: GroupWriteOptions): AdOpResult;
  setGroup(identity: string, attributes: Record<string, string>, target?: RemoteDirectoryTarget): AdOpResult;
  getGroup(identity: string): AdGroupInfo | null;
  listGroups(): AdGroupInfo[];
  addGroupMember(groupIdentity: string, members: string[], opts?: AddGroupMemberOptions): AdOpResult;
  groupMemberLinks(groupIdentity: string): AdMemberLink[];
  removeGroupMember(groupIdentity: string, members: string[], opts?: AddGroupMemberOptions): AdOpResult;
  /** `Get-ADGroupMember` — direct members only (users, computers, nested groups, or a cross-domain `foreignSecurityPrincipal` — the AGDLP model relies on nesting Global groups inside Domain Local ones), each with enough shape to tell members apart by kind. */
  getGroupMembers(groupIdentity: string): Array<{ sam: string; dn: string; objectClass: 'user' | 'computer' | 'group' | 'foreignSecurityPrincipal' }>;
  removeGroup(identity: string): AdOpResult;

  // ── AD Recycle Bin (PRD-Windows-Server-Advanced.md — optional features) ──
  /** `(Get-ADRootDSE).configurationNamingContext`. */
  getConfigurationNamingContext(): string;
  /** `Get-ADOptionalFeature -Filter {Name -eq "Recycle Bin Feature"}` — null for any name other than the one optional feature this simulator models. */
  getOptionalFeature(name: string): AdOptionalFeatureInfo | null;
  /** `Enable-ADOptionalFeature -Identity "Recycle Bin Feature" -Scope ForestOrConfigurationSet`. */
  enableOptionalFeature(name: string, scopeDn: string): AdOpResult;
  /** `Get-ADObject -Identity <dn> [-IncludeDeletedObjects]` — any object class, raw attributes. */
  getGenericObject(dn: string, includeDeleted: boolean): AdGenericObjectInfo | null;
  /** `Get-ADObject -Filter {...} [-SearchBase <dn>] [-IncludeDeletedObjects]`. */
  listGenericObjects(opts: { includeDeleted: boolean; searchBaseDn?: string }): AdGenericObjectInfo[];
  /** `Set-ADObject -Identity <dn> -Replace @{attr = value}`. */
  setGenericObject(dn: string, replace: Record<string, string>): AdOpResult;
  /** `Restore-ADObject -Identity <deletedObj> [-TargetPath <ou>]`. */
  restoreObject(dn: string, targetPathDn?: string): AdOpResult;

  getComputer(identity: string): AdComputerInfo | null;
  listComputers(): AdComputerInfo[];
  /** `Set-ADComputer -Identity <name> -AllowedToDelegateTo <svc1,svc2,...>` (PRD-Windows-Server-Advanced.md §5 P10) — the `msDS-AllowedToDelegateTo` list S4U2Proxy checks. */
  setComputerAllowedToDelegateTo(identity: string, targetServiceNames: string[]): AdOpResult;

  newOrganizationalUnit(name: string, path?: string, opts?: OrgUnitWriteOptions): AdOpResult;
  setOrganizationalUnit(identity: string, attributes: Record<string, string>, protectedFlag?: boolean, target?: RemoteDirectoryTarget): AdOpResult;
  removeOrganizationalUnit(identity: string, recursive?: boolean, target?: RemoteDirectoryTarget): AdOpResult;
  getOrganizationalUnit(identity: string): AdOrgUnitInfo | null;
  listOrganizationalUnits(): AdOrgUnitInfo[];

  /** `New-ADReplicationSite -Name <name> [-Description <text>]` (PRD-Windows-Server-Advanced.md §5 P6). */
  newReplicationSite(name: string, description?: string): AdOpResult;
  /** `Set-ADReplicationSite -Identity <old> -Name <new>`. */
  renameReplicationSite(identity: string, newName: string): AdOpResult;
  /** `Get-ADReplicationSite` (no `-Identity`: every site this DC knows about). */
  listReplicationSites(): AdSiteInfo[];
  /** `New-ADReplicationSubnet -Name <cidr> -Site <site> [-Description <text>]`. */
  newReplicationSubnet(cidr: string, siteName: string, description?: string): AdOpResult;
  /** `Get-ADReplicationSubnet -Filter *`. */
  listReplicationSubnets(): AdSubnetInfo[];

  /** `New-ADReplicationSiteLink -Name <name> -SitesIncluded <sites> [-Cost <n>] [-ReplicationFrequencyInMinutes <n>] [-InterSiteTransportProtocol IP|SMTP] [-Description <text>]` — bookkeeping only, no scheduling/cost enforcement (PRD-Repadmin.md §0.2, same "no KCC" boundary as `/kcc`/`/istg`). */
  newReplicationSiteLink(
    name: string, sitesIncluded: string[],
    opts?: { cost?: number; replicationFrequencyInMinutes?: number; transport?: AdSiteLinkTransport; description?: string },
  ): AdOpResult;
  /** `Get-ADReplicationSiteLink -Filter *`. */
  listReplicationSiteLinks(): AdSiteLinkInfo[];
  /** `Get-ADReplicationSiteLink -Identity <name>`. */
  getReplicationSiteLink(name: string): AdSiteLinkInfo | null;
  /** `Set-ADReplicationSiteLink -Identity <name> [-Cost <n>] [-ReplicationFrequencyInMinutes <n>] [-SitesIncluded <sites>] [-Description <text>]`. */
  setReplicationSiteLink(
    name: string, patch: { cost?: number; replicationFrequencyInMinutes?: number; sitesIncluded?: string[]; description?: string },
  ): AdOpResult;

  /** `Move-ADDirectoryServer -Identity <dc> -Site <site>` — explicit admin override of a DC's site membership. */
  moveDirectoryServer(identity: string, siteName: string): AdOpResult;
  /** `Get-ADReplicationUpToDatenessVectorTable -Target <dc>` — this DC's own view of how caught-up it is with each partner it has ever successfully pulled from. */
  listUpToDatenessVector(): AdUpToDatenessVectorRowInfo[];

  /** `New-ADAttribute` (PRD-Windows-Server-Advanced.md §5 P7, RFC 4512 §4). */
  newAttribute(schema: AdAttributeSchemaInfo): AdOpResult;
  /** `New-ADObjectClass`. */
  newObjectClass(schema: AdObjectClassSchemaInfo): AdOpResult;

  /** `New-ADDomain -NewDomainName ... -ParentDomainName ...` (PRD-Windows-Server-Advanced.md §5 P8) — a new child domain of the forest reached via `parentDcAddress`. */
  newDomain(
    newDomainDnsName: string, netbiosName: string | undefined, parentDomainName: string, parentDcAddress: string,
    credentialUser: string, credentialPassword: string, safeModeAdminPassword: string,
    opts?: { installDns?: boolean },
  ): AdOpResult;
  /** `Get-ADForest` — null if this server isn't a DC. */
  getForest(): AdForestInfo | null;
  /** `Get-ADDomain` — null if this server isn't a DC. */
  getDomain(): AdDomainInfo | null;
  /** `Move-ADDirectoryServerOperationMasterRole -Identity <dc> -OperationMasterRole <roles> [-Force]`. */
  moveOperationMasterRole(targetHostname: string, roles: string[], force: boolean): AdOpResult;

  /** `New-ADTrust`/`netdom trust` (PRD-Windows-Server-Advanced.md §5 P9) — a simple trust with the domain reached at `remoteDcAddress`. */
  newTrust(
    remoteRealm: string, remoteDcAddress: string, direction: AdTrustInfo['direction'], transitive: boolean,
    credentialUser: string, credentialPassword: string,
  ): AdOpResult;
  /** `Get-ADTrust -Identity <remoteRealm>` — null if no such trust exists (or this server isn't a DC). */
  getTrust(remoteRealm: string): AdTrustInfo | null;
  /** `Get-ADTrust` with no `-Identity`: every trust this DC knows about. */
  listTrusts(): AdTrustInfo[];

  /** `Get-ADReplicationConnection -Filter *` — this DC's connection objects to its replication partners (auto-generated only; no manual/KCC-computed topology modeled). */
  listReplicationConnections(): AdReplicationConnectionInfo[];
  /** `Get-ADReplicationFailure -Scope Forest` — every replication partner this DC currently has a persistent failure with (empty in a healthy lab). */
  listReplicationFailures(): AdReplicationFailureInfo[];

  getAcl(dn: string): AdAccessRuleInfo[] | null;
  setAcl(dn: string, rules: AdAccessRuleInfo[]): AdOpResult;

  /** `Get-ADDefaultDomainPasswordPolicy`. */
  getDefaultDomainPasswordPolicy(): AdPasswordPolicyInfo;
  /** `Set-ADDefaultDomainPasswordPolicy` — only the given fields change. */
  setDefaultDomainPasswordPolicy(patch: Partial<AdPasswordPolicyInfo>): AdOpResult;
  /** `New-ADFineGrainedPasswordPolicy`. */
  newFineGrainedPasswordPolicy(name: string, precedence: number, settings: Partial<AdPasswordPolicyInfo>, description?: string): AdOpResult;
  /** `Get-ADFineGrainedPasswordPolicy -Identity <name>`. */
  getFineGrainedPasswordPolicy(name: string): AdFineGrainedPasswordPolicyInfo | null;
  /** `Get-ADFineGrainedPasswordPolicy -Filter *`: every PSO in the domain. */
  listFineGrainedPasswordPolicies(): AdFineGrainedPasswordPolicyInfo[];
  /** `Add-ADFineGrainedPasswordPolicySubject` — subjects may be user or group SAM names. */
  addFineGrainedPasswordPolicySubject(name: string, subjects: string[]): AdOpResult;
  /** `Get-ADFineGrainedPasswordPolicySubject -Identity <name>`. */
  listFineGrainedPasswordPolicySubjects(name: string): string[];
  /** `Get-ADUserResultantPasswordPolicy` — null when no PSO applies (Default Domain Policy governs implicitly). */
  getResultantPasswordPolicy(userIdentity: string): AdFineGrainedPasswordPolicyInfo | null;

  // ── Managed Service Accounts (gMSA/sMSA) ────────────────────────────────
  /** `Add-KdsRootKey` — the real prerequisite `New-ADServiceAccount` (for a gMSA) refuses without. */
  addKdsRootKey(): AdKdsRootKeyInfo;
  /** `Get-KdsRootKey` — null before `Add-KdsRootKey` has ever run. */
  getKdsRootKey(): AdKdsRootKeyInfo | null;
  /** `New-ADServiceAccount` — a gMSA (`principalsAllowed` set) or an sMSA (`restrictToSingleComputer`). */
  newServiceAccount(name: string, opts: {
    dnsHostName: string; description?: string; path?: string;
    principalsAllowed?: string[]; managedPasswordIntervalDays?: number; restrictToSingleComputer?: boolean;
  }): AdOpResult;
  getServiceAccount(identity: string): AdServiceAccountInfo | null;
  /** `Set-ADServiceAccount -ServicePrincipalNames @{ Add = @(...) }`. */
  addServiceAccountSpns(identity: string, addSpns: string[]): AdOpResult;
  /** `Add-ADComputerServiceAccount -Identity <computer> -ServiceAccount <sMSA>`. */
  addComputerServiceAccount(computerIdentity: string, serviceAccountIdentity: string): AdOpResult;
}

export interface AdKdsRootKeyInfo { keyId: string; effectiveTime: string }
export interface AdServiceAccountInfo {
  sam: string; dn: string; dnsHostName: string; description: string; isGroupManaged: boolean;
  principalsAllowed: string[]; managedPasswordIntervalDays: number; hostComputerDn: string;
  servicePrincipalNames: string[]; passwordLastSet: string;
}

export interface AdPasswordPolicyInfo {
  minPasswordLength: number;
  passwordHistoryCount: number;
  maxPasswordAgeDays: number;
  minPasswordAgeDays: number;
  lockoutThreshold: number;
  lockoutDurationMinutes: number;
  lockoutObservationWindowMinutes: number;
  complexityEnabled: boolean;
  reversibleEncryptionEnabled: boolean;
}

export interface AdFineGrainedPasswordPolicyInfo extends AdPasswordPolicyInfo {
  name: string;
  precedence: number;
  description: string;
}

export interface AdReplicationConnectionInfo {
  name: string;
  autoGenerated: boolean;
  replicateFromDirectoryServer: string;
  interSiteTransportProtocol: string;
}

export interface AdReplicationFailureInfo {
  server: string;
  partner: string;
  firstFailureTime: string;
  failureCount: number;
  lastError: string;
  failureType: string;
}

export interface AdForestInfo {
  functionalLevel: string;
  domains: { dnsName: string; netbiosName: string; parentDnsName?: string }[];
  schemaMaster: string;
  domainNamingMaster: string;
}

export interface AdDomainInfo {
  dnsRoot: string;
  netBiosName: string;
  domainMode: string;
  infrastructureMaster: string;
  pdcEmulator: string;
  ridMaster: string;
}

export interface AdTrustInfo {
  remoteRealm: string;
  direction: 'Inbound' | 'Outbound' | 'Bidirectional';
  transitive: boolean;
}

export interface AdSiteInfo { name: string; dn: string }
export interface AdAttributeSchemaInfo { ldapDisplayName: string; attributeSyntax: string; isSingleValued: boolean }
export interface AdObjectClassSchemaInfo {
  ldapDisplayName: string; objectClassCategory: 'structural' | 'auxiliary' | 'abstract';
  mustContain: string[]; mayContain: string[]; subClassOf?: string;
}

export interface DomainMembershipInfo { dnsName: string; netbiosName: string; dcAddress: string; machineSecret: string }

export interface IComputerProvider {
  /**
   * `Add-Computer -DomainName` — real LDAP `AddRequest` join dialogue
   * against the DC (PRD-Windows-Server.md §5 P6), not a direct method
   * call into the DC's directory. `server` is an explicit DC hostname/IP
   * fallback — there is no DNS SRV `_ldap._tcp.dc._msdcs` discovery yet
   * (depends on the DNS Server role, P7); when omitted, the domain name
   * itself is resolved as a hostname.
   */
  join(domainName: string, credential: { username: string; password: string }, server?: string, opts?: { ouPath?: string; newName?: string }): AdOpResult;
  /** This machine's domain-join state, or null while in a workgroup. */
  getDomainInfo(): DomainMembershipInfo | null;
  /** `Get-ADDomainController -Discover` from a domain-joined machine that isn't itself a DC — a real CLDAP-style dial to the known DC address to learn its actual computer name (`DcHostnameDiscovery`), same mechanism `Add-Computer` already uses during join. `null` while in a workgroup, or if the DC can't be reached. */
  discoverDomainController(): { hostName: string } | null;
  /** `Test-ComputerSecureChannel` — a real LDAP bind to the DC as this machine's own computer account (`<name>$` / the cached machine secret), the same "does the DC still agree with my machine password" check NetLogon's secure channel verifies. `false` while in a workgroup or if the DC can't be reached. */
  testSecureChannel(): boolean;
  /** `Install-ADServiceAccount -Identity <gMSA|sMSA>` — a real LDAP search against the DC to verify this machine is authorized (`principalsAllowed` for a gMSA, or the sMSA's exclusive linked host) before caching the account locally as "installed", the same authorization gate real Windows enforces before letting a service run as the account. */
  installServiceAccount(identity: string): AdOpResult;
  /** `Test-ADServiceAccount -Identity <gMSA|sMSA>` — true only if `Install-ADServiceAccount` already succeeded on this machine. */
  testServiceAccount(identity: string): boolean;
  /**
   * `Remove-Computer`/`netdom remove` (docs/PRD-Netdom.md §2.1 P4) —
   * deletes this machine's computer account on the DC via a real LDAP
   * `DelRequest` and returns the machine to a workgroup. Real AD
   * deletes the object outright rather than disabling it.
   */
  remove(credential: { username: string; password: string }): AdOpResult;
  /**
   * `Rename-Computer`/`netdom renamecomputer` (docs/PRD-Netdom.md §2.1
   * P5) — renames this machine locally and, if domain-joined, its AD
   * computer object too (real LDAP `ModifyDNRequest`+`ModifyRequest`).
   * `credential` is required when domain-joined, optional in a workgroup.
   */
  rename(newName: string, credential?: { username: string; password: string }): AdOpResult;
}

// ── Group Policy (PRD-Windows-Server.md §5 P10) ─────────────────────────────

export interface GpoInfo { id: string; name: string; links: string[] }

/** A single `gPLink`, decoded — what `Get-GPInheritance ... GpoLinks | Select DisplayName, Enabled, Enforced, Order` reports per link. */
export interface GpoLinkResultInfo { displayName: string; enabled: boolean; enforced: boolean; order: number }

export interface GpLinkOptions { linkEnabled?: boolean; enforced?: boolean; order?: number }

export interface IGpoProvider {
  newGpo(name: string): AdOpResult;
  getGpo(name: string): GpoInfo | null;
  listGpos(): GpoInfo[];
  /** `New-GPLink -Target` accepts a distinguished name (domain root or an OU's DN, e.g. from `Get-ADOrganizationalUnit`). */
  newGPLink(gpoName: string, targetDn: string, opts?: GpLinkOptions): AdOpResult;
  /** `Set-GPLink` — updates `-LinkEnabled`/`-Enforced`/`-Order` on an existing link. */
  setGpLink(gpoName: string, targetDn: string, opts: GpLinkOptions): AdOpResult;
  /** `Set-GPRegistryValue` — records/updates a registry-based policy setting on a GPO. */
  setGpRegistryValue(gpoName: string, key: string, valueName: string, type: string, value: string): AdOpResult;
  getDomainDn(): string;
  setGpInheritance(targetDn: string, blocked: boolean): AdOpResult;
  getGpInheritance(targetDn: string): { dn: string; gpoInheritanceBlocked: boolean; gpoLinks: GpoLinkResultInfo[] } | null;
}

// ── Web Server / IIS role (PRD-Windows-Server.md §5 P11) ────────────────────

export interface IisOpResult { ok: boolean; message: string }
export interface WebsiteInfo {
  name: string; physicalPath: string; port: number; state: 'Started' | 'Stopped';
  httpsPort?: number; certificateThumbprint?: string; applicationPool: string;
}

export type AppPoolIdentityType = 'ApplicationPoolIdentity' | 'NetworkService' | 'LocalService' | 'LocalSystem';
export interface AppPoolInfo {
  name: string; state: 'Started' | 'Stopped'; managedRuntimeVersion: string; identityType: AppPoolIdentityType;
  periodicRestartMinutes: number; workerProcessCount: number; recycleCount: number;
}
export interface NewAppPoolOptions {
  managedRuntimeVersion?: string; identityType?: AppPoolIdentityType;
  periodicRestartMinutes?: number; workerProcessCount?: number;
}
export interface WebModuleInfo { name: string; type: string }

export interface IIisProvider {
  newWebsite(name: string, physicalPath: string, port: number, applicationPool?: string): IisOpResult;
  removeWebsite(name: string): IisOpResult;
  getWebsite(name: string): WebsiteInfo | null;
  listWebsites(): WebsiteInfo[];
  startWebsite(name: string): IisOpResult;
  stopWebsite(name: string): IisOpResult;
  /** `New-WebBinding -Protocol https -Port <port> -CertificateHash <thumbprint>` (PRD-Windows-Server-Advanced.md §5 P14). */
  newBinding(name: string, protocol: 'http' | 'https', port: number, certificateThumbprint?: string): IisOpResult;

  /** `New-WebAppPool`/`Get-IISAppPool` (PRD-Windows-Server-Advanced.md §5 P15) — process/isolation metadata only, no real .NET execution. */
  newAppPool(name: string, opts?: NewAppPoolOptions): IisOpResult;
  removeAppPool(name: string): IisOpResult;
  startAppPool(name: string): IisOpResult;
  stopAppPool(name: string): IisOpResult;
  recycleAppPool(name: string): IisOpResult;
  getAppPool(name: string): AppPoolInfo | null;
  listAppPools(): AppPoolInfo[];
  /** `Get-WebGlobalModule` — the static module registry already relevant to this role's own pipeline. */
  listGlobalModules(): WebModuleInfo[];
}

// ── Exchange Server (docs/PRD-Exchange.md §2.1 P1) ──────────────────────────

export interface ExchangeOpResult { ok: boolean; message: string }
export interface ExchangeServerInfo {
  readonly hostname: string;
  readonly roles: readonly string[];
  readonly organizationName: string;
  readonly installedAt: number;
}

export type MailFolderName = 'Inbox' | 'Sent Items' | 'Drafts' | 'Deleted Items' | 'Junk Email';
export interface MailboxOpResult { ok: boolean; message: string }
export interface MailboxInfo {
  readonly identity: string;
  readonly primarySmtpAddress: string;
  readonly proxyAddresses: readonly string[];
  readonly quotaBytes: number | null;
}
export interface MailboxStatisticsInfo {
  readonly identity: string;
  readonly totalItemSize: number;
  readonly itemCount: number;
  readonly folderItemCounts: Readonly<Record<MailFolderName, number>>;
}

export interface IExchangeProvider {
  installExchangeServer(organizationName: string, roles: readonly string[]): ExchangeOpResult;
  getExchangeServer(hostname?: string): ExchangeServerInfo | null;
  listExchangeServers(): ExchangeServerInfo[];

  enableMailbox(identity: string): MailboxOpResult;
  newMailbox(name: string, password: string): MailboxOpResult;
  getMailbox(identity: string): MailboxInfo | null;
  listMailboxes(): MailboxInfo[];
  setMailboxQuota(identity: string, quotaBytes: number | null): MailboxOpResult;
  getMailboxStatistics(identity: string): MailboxStatisticsInfo | null;
  disableMailbox(identity: string): MailboxOpResult;
  removeMailbox(identity: string): MailboxOpResult;

  newDistributionGroup(identity: string, type: 'Distribution' | 'Security'): ExchangeOpResult;
  setDistributionGroupPrimarySmtpAddress(identity: string, address: string): ExchangeOpResult;
  getDistributionGroup(identity: string): DistributionGroupInfo | null;
  listDistributionGroups(): DistributionGroupInfo[];
  addDistributionGroupMember(identity: string, member: string): ExchangeOpResult;
  getDistributionGroupMembers(identity: string): readonly string[] | null;

  getGlobalAddressList(): GalEntryInfo[];

  newReceiveConnector(def: ReceiveConnectorInfo): ExchangeOpResult;
  getReceiveConnector(name: string): ReceiveConnectorInfo | null;
  listReceiveConnectors(): ReceiveConnectorInfo[];
  newSendConnector(def: SendConnectorInfo): ExchangeOpResult;
  getSendConnector(name: string): SendConnectorInfo | null;
  listSendConnectors(): SendConnectorInfo[];

  newTransportRule(rule: TransportRuleInfo): ExchangeOpResult;
  getTransportRule(name: string): TransportRuleInfo | null;
  listTransportRules(): TransportRuleInfo[];

  listQueues(): QueueInfo[];
  retryQueue(identity: string): ExchangeOpResult;
  suspendQueue(identity: string): ExchangeOpResult;
  resumeQueue(identity: string): ExchangeOpResult;

  addMailboxPermission(identity: string, user: string): ExchangeOpResult;
  addRecipientPermission(identity: string, trustee: string): ExchangeOpResult;
  getMailboxPermissionTrustees(identity: string): string[];
  getRecipientPermissionTrustees(identity: string): string[];

  newJournalRule(journalEmailAddress: string): ExchangeOpResult;
  getJournalRule(): TransportRuleInfo | null;

  newDatabaseAvailabilityGroup(name: string): ExchangeOpResult;
  addDatabaseAvailabilityGroupServer(dagName: string, server: string): ExchangeOpResult;
  addMailboxDatabaseCopy(dagName: string, database: string, server: string): ExchangeOpResult;
  updateMailboxDatabaseCopy(dagName: string, database: string, server: string): ExchangeOpResult;
  getMailboxDatabaseCopyStatus(dagName: string, database?: string): MailboxDatabaseCopyInfo[];

  testServiceHealth(): ServiceHealthCheckInfo[];
  testMailflow(fromIdentity: string, toIdentity: string): MailflowTestResultInfo;
}

export interface ServiceHealthCheckInfo {
  readonly serviceName: string;
  readonly status: 'Running' | 'Stopped';
  readonly expected: boolean;
}
export interface MailflowTestResultInfo {
  readonly success: boolean;
  readonly fromMailbox: string;
  readonly toMailbox: string;
  readonly latencyMs: number;
  readonly failureReason?: string;
}

export type DatabaseCopyStatus = 'Mounted' | 'Healthy' | 'FailedAndSuspended' | 'Resynchronizing';
export interface MailboxDatabaseCopyInfo {
  readonly database: string;
  readonly server: string;
  readonly status: DatabaseCopyStatus;
  readonly copyQueueLength: number;
  readonly lastSyncedAt: number;
}

export interface QueueInfo {
  readonly identity: string;
  readonly nextHopDomain: string;
  readonly messageCount: number;
  readonly status: 'Active' | 'Suspended';
}

export type TransportRuleConditionInfo = {
  readonly field: 'From' | 'To' | 'SubjectContains' | 'HasAttachment';
  readonly value?: string;
};
export type TransportRuleActionInfo =
  | { readonly kind: 'Reject'; readonly message: string }
  | { readonly kind: 'AppendDisclaimer'; readonly text: string }
  | { readonly kind: 'RedirectTo'; readonly address: string }
  | { readonly kind: 'BlindCopyTo'; readonly address: string };
export interface TransportRuleInfo {
  readonly name: string;
  readonly priority: number;
  readonly conditions: readonly TransportRuleConditionInfo[];
  readonly actions: readonly TransportRuleActionInfo[];
  readonly enabled: boolean;
}

export interface ReceiveConnectorInfo {
  readonly name: string;
  readonly bindings: readonly string[];
  readonly remoteIpRanges: readonly string[];
  readonly authMechanisms: readonly ('TLS' | 'BasicAuth' | 'ExchangeServer')[];
}

export interface SendConnectorInfo {
  readonly name: string;
  readonly addressSpaces: readonly string[];
  readonly smartHosts: readonly string[];
  readonly costMetric: number;
}

export interface GalEntryInfo {
  readonly displayName: string;
  readonly samAccountName: string;
  readonly primarySmtpAddress: string;
  readonly kind: 'Mailbox' | 'DistributionGroup' | 'SecurityMailEnabled';
}

export interface DistributionGroupInfo {
  readonly identity: string;
  readonly type: 'Distribution' | 'SecurityMailEnabled';
  readonly primarySmtpAddress: string;
}

// ── AD CS (Certificate Services) role (PRD-Windows-Server-Advanced.md §5 P13) ──

export interface AdcsOpResult { ok: boolean; message: string }
export interface CaTemplateInfo { name: string; displayName: string; eku: readonly string[]; validityDays: number }
export interface IssuedCertInfo {
  serialNumber: string; subject: string; issuer: string; notBefore: number; notAfter: number;
}
export interface CertificateRequestResultInfo extends AdcsOpResult {
  certificate?: IssuedCertInfo;
}

export interface IAdcsProvider {
  /** `Install-AdcsCertificationAuthority -CACommonName <name>`. */
  installCA(caCommonName: string): AdcsOpResult;
  /** `Get-CATemplate` — every certificate template this CA can issue against. */
  listTemplates(): CaTemplateInfo[];
  /** `Add-CATemplate -TemplateName <name>` — publishes a known template to this CA. */
  addTemplate(name: string): AdcsOpResult;
  /** `Get-Certificate -Template <name> -DnsName <subject>` — submits and retrieves a new certificate (this simulator's `certreq -submit` never leaves a request "Pending", so enrollment is synchronous). */
  getCertificate(templateName: string, subject: string, requestedEku?: string): CertificateRequestResultInfo;
}

// ── Personal certificate store (PRD-Windows-Server-Advanced.md §5 P14) ─────

export interface IPkiProvider {
  /** `New-SelfSignedCertificate -DnsName <name>` — a locally-trusted, self-signed leaf cert good for `serverAuth`, stored in this device's personal store. */
  newSelfSignedCertificate(dnsName: string): IssuedCertInfo & { thumbprint: string };
  /** `Get-ChildItem Cert:\LocalMachine\My` — every certificate this device holds a private key for. */
  listCertificates(): (IssuedCertInfo & { thumbprint: string })[];
}

// ── DFS Namespaces + DFSR (PRD-Windows-Server-Advanced.md §5 P16) ──────────

export interface DfsOpResult { ok: boolean; message: string }
export type DfsReferralPriorityClassInfo =
  | 'GlobalHigh' | 'SiteCostNormal' | 'GlobalLow' | 'SiteCostHigh' | 'SiteCostLow';
export interface DfsTargetInfo { serverAddress: string; shareName: string; referralPriorityClass: DfsReferralPriorityClassInfo }
export type DfsNamespaceTypeInfo = 'Standalone' | 'DomainV1' | 'DomainV2';
export interface DfsRootInfo { namespacePath: string; type: DfsNamespaceTypeInfo; description: string; targets: readonly DfsTargetInfo[] }
export interface DfsFolderInfo { namespacePath: string; folderName: string; description: string; targets: readonly DfsTargetInfo[] }
export interface DfsrSyncResultInfo { ok: boolean; error?: string; applied: number }
export interface DfsrGroupInfoView { readonly name: string; readonly description: string }
export interface DfsrMembershipInfoView {
  readonly computerName: string; readonly folderName: string;
  readonly contentPath: string; readonly primaryMember: boolean;
}

export interface IDfsProvider {
  /** `New-DfsnRoot -Path <namespacePath> [-Type Standalone|DomainV1|DomainV2] [-TargetPath <\\server\share>] [-Description <text>]`. */
  newDfsnRoot(namespacePath: string, options?: { type?: DfsNamespaceTypeInfo; description?: string; target?: DfsTargetInfo }): DfsOpResult;
  /** `Get-DfsnRoot -Path <namespacePath>`. */
  getDfsnRoot(namespacePath: string): DfsRootInfo | null;
  /** `New-DfsnFolder -Path <namespacePath\folderName> -TargetPath <\\server\share> [-Description <text>]`. */
  newDfsnFolder(namespacePath: string, folderName: string, target: DfsTargetInfo, description?: string): DfsOpResult;
  /** `New-DfsnFolderTarget` — adds another target to an existing folder. */
  addDfsnFolderTarget(namespacePath: string, folderName: string, target: DfsTargetInfo): DfsOpResult;
  /** `Set-DfsnFolderTarget -ReferralPriorityClass <class>`. */
  setDfsnFolderTargetPriority(namespacePath: string, folderName: string, serverAddress: string, priorityClass: DfsReferralPriorityClassInfo): DfsOpResult;
  /** `Get-DfsnFolder` — the folder's current targets (this simulator's referral resolution). */
  getDfsnFolder(namespacePath: string, folderName: string): DfsFolderInfo | null;
  /** `Get-DfsnFolder -Path <namespacePath>\*` — every folder under a namespace. */
  listDfsnFolders(namespacePath: string): DfsFolderInfo[];

  /** `New-DfsReplicationGroup -GroupName <name> -ContentPath <localPath>` — this server's own membership. */
  newDfsReplicationGroup(groupName: string, contentPath: string): DfsOpResult;
  /** `Sync-DfsReplicationGroup -GroupName <name> -PartnerServer <address>` — one manually-triggered DFSR pull cycle. */
  syncDfsReplicationGroup(groupName: string, partnerAddress: string): DfsrSyncResultInfo;
  /** `New-DfsReplicationGroup -GroupName <name> [-Description <text>]` — real signature (admin topology, no ContentPath). */
  registerDfsrAdminGroup(groupName: string, description: string): DfsOpResult;
  /** `Get-DfsReplicationGroup -GroupName <name>`. */
  getDfsrAdminGroup(groupName: string): DfsrGroupInfoView | null;
  /** `Add-DfsrMember -GroupName <name> -ComputerName <name[]>`. */
  addDfsrMembers(groupName: string, computerNames: string[]): DfsOpResult;
  /** `Get-DfsrMember -GroupName <name>`. */
  listDfsrMembers(groupName: string): string[];
  /** `New-DfsReplicatedFolder -GroupName <name> -FolderName <name>`. */
  newDfsReplicatedFolderAdmin(groupName: string, folderName: string): DfsOpResult;
  /** `Add-DfsrConnection -GroupName <name> -SourceComputerName <a> -DestinationComputerName <b>`. */
  addDfsrConnection(groupName: string, source: string, destination: string): DfsOpResult;
  /** `Set-DfsrMembership -GroupName <name> -FolderName <name> -ComputerName <name> -ContentPath <path> -PrimaryMember <bool>`. */
  setDfsrMembership(groupName: string, folderName: string, computerName: string, contentPath: string, primaryMember: boolean): DfsOpResult;
  /** `Get-DfsrMembership -GroupName <name> -FolderName <name>`. */
  listDfsrMemberships(groupName: string, folderName: string): DfsrMembershipInfoView[];
}

// ── RDP (PRD-Windows-Server-Advanced.md §5 P17) ─────────────────────────────

export interface RdpOpResult { ok: boolean; message: string }
export interface RdpSessionInfo {
  sessionId: number; userName: string; state: 'Active' | 'Disconnected'; clientAddress: string;
}

export interface IRdpProvider {
  /** `Enable-RemoteDesktop`/`Disable-RemoteDesktop`. */
  enable(): RdpOpResult;
  disable(): RdpOpResult;
  /** `Get-RDUserSession`. */
  listSessions(): RdpSessionInfo[];
  /** `logoff`/`rwinsta` (PowerShell surface). */
  logoff(sessionId: number): RdpOpResult;
}

// ── Failover Clustering / WSFC (PRD-Windows-Server-Advanced.md §5 P18) ──────

export interface ClusterOpResult { ok: boolean; message: string }
export type ClusterNodeStateInfo = 'Up' | 'Down';
export interface ClusterNodeInfo { name: string; state: ClusterNodeStateInfo; lastHeartbeatAt: number }
export interface ClusterPeerInfo { name: string; ip: string }
export type ClusterResourceTypeInfo = 'FileServer';
export interface ClusterGroupInfo { name: string; ownerNode: string; resourceType: ClusterResourceTypeInfo }

export interface IClusterProvider {
  /** `New-Cluster -Name <clusterName> -Node <selfNodeName>,<peer1>,...` — run identically on every member server. */
  newCluster(clusterName: string, selfNodeName: string, peers: ClusterPeerInfo[]): ClusterOpResult;
  /** `Get-ClusterNode` — this node's own view of every member's liveness (via real UDP heartbeat). */
  getClusterNodes(): ClusterNodeInfo[];
  /** `Get-Cluster` quorum check — simple majority of live nodes, no witness disk/share. */
  hasClusterQuorum(): boolean;
  /** `Add-ClusterFileServerRole -Name <name> -Node <preferredOwner1,...>`. */
  addClusterFileServerRole(name: string, preferredOwners: string[]): ClusterOpResult;
  /** `Get-ClusterGroup`. */
  getClusterGroups(): ClusterGroupInfo[];
  /** `Move-ClusterGroup -Name <name> -Node <target>`. */
  moveClusterGroup(name: string, targetNode: string): ClusterOpResult;
}

// ── WSUS (PRD-Windows-Server-Advanced.md §5 P19) ────────────────────────────

export interface WsusOpResult { ok: boolean; message: string }
export type WsusSeverityInfo = 'Critical' | 'Important' | 'Moderate' | 'Low';
export interface WsusUpdateInfo { kbId: string; title: string; category: string; severity: WsusSeverityInfo }
export type WsusApprovalActionInfo = 'Install' | 'Decline';

export interface IWsusProvider {
  /** `Get-WsusUpdate` — the full catalog this WSUS server knows about (metadata only, no binary patch content). */
  listCatalog(): WsusUpdateInfo[];
  /** `Approve-WsusUpdate -Updates <kbId> -TargetGroupName <group> -Action Install|Decline`. */
  approveUpdate(kbId: string, targetGroup: string, action: WsusApprovalActionInfo): WsusOpResult;
}

// ── Windows Update client (PRD-Windows-Server-Advanced.md §5 P19) ──────────
// Unconditional (no RoleManager gate): every Windows SKU has a Windows
// Update client, not just servers with the WSUS role installed.

export interface IWindowsUpdateProvider {
  /** `Set-WUSettings -WUServer <address> -TargetGroup <name>` — redirects this client to a WSUS server instead of Windows Update directly. */
  setWuSettings(wuServer: string, targetGroup?: string): void;
  /** `Get-WindowsUpdate` — every update approved for this client's configured target group; empty if unconfigured or unreachable. */
  getWindowsUpdates(): WsusUpdateInfo[];
}

// ── Print and Document Services (PRD-Windows-Server-Advanced.md §5 P20) ────

export interface PrintOpResult { ok: boolean; message: string }
export type PrintJobStatusInfo = 'Spooling' | 'Printing' | 'Completed' | 'Error';
export interface PrintJobInfo {
  id: number; document: string; owner: string; submittedAt: number; size: number; status: PrintJobStatusInfo;
}

export interface IPrintProvider {
  /** `Add-Printer -ShareName <name>` — exposes a new shared queue, reachable by remote hosts via LPD (RFC 1179, TCP/515). */
  addPrinter(shareName: string): PrintOpResult;
  /** `Get-PrintJob -PrinterName <shareName>`. */
  getPrintJobs(shareName: string): PrintJobInfo[];
  /** `Remove-PrintJob -PrinterName <shareName> -ID <jobId>`. */
  removePrintJob(shareName: string, jobId: number): PrintOpResult;
}

// ── Activation/licensing (PRD-Windows-Server-Advanced.md §5 P21) ───────────
// Unconditional (no RoleManager gate): every Windows SKU has a licensing
// state; mutated via `slmgr /ipk`/`/ato` (cmd.exe, not PowerShell), read
// back here for `Get-CimInstance SoftwareLicensingProduct`.

export type LicenseStateInfo = 'Unlicensed' | 'Licensed' | 'OutOfBoxGrace' | 'Notification';

export interface ILicensingProvider {
  getProductName(): string;
  getState(): LicenseStateInfo;
  getProductKey(): string | null;
}

// ── DNS Server role (PRD-Windows-Server.md §5 P7) ───────────────────────────

export interface DnsOpResult { ok: boolean; message: string }
export interface DnsZoneInfo { name: string; recordCount: number; dynamicUpdate: DnsDynamicUpdateMode }
export type DnsDynamicUpdateMode = 'None' | 'NonsecureAndSecure' | 'Secure';
export interface DnsRecordInfo { name: string; type: string; ttl: number; text: string }

export interface IDnsServerProvider {
  addPrimaryZone(name: string, adminEmail?: string): DnsOpResult;
  removeZone(name: string): DnsOpResult;
  getZone(name: string): DnsZoneInfo | null;
  listZones(): DnsZoneInfo[];

  addARecord(zone: string, name: string, ipv4: string, ttl?: number): DnsOpResult;
  addAaaaRecord(zone: string, name: string, ipv6: string, ttl?: number): DnsOpResult;
  addCnameRecord(zone: string, name: string, hostNameAlias: string, ttl?: number): DnsOpResult;
  addMxRecord(zone: string, name: string, preference: number, mailExchange: string, ttl?: number): DnsOpResult;
  addPtrRecord(zone: string, name: string, ptrDomainName: string, ttl?: number): DnsOpResult;
  addSrvRecord(zone: string, name: string, target: { priority: number; weight: number; port: number; target: string }, ttl?: number): DnsOpResult;
  removeRecord(zone: string, name: string, type: string): DnsOpResult;
  getRecords(zone: string, name?: string): DnsRecordInfo[] | null;

  setForwarders(addresses: string[]): DnsOpResult;
  getForwarders(): string[];

  setZoneDynamicUpdate(zone: string, mode: DnsDynamicUpdateMode): DnsOpResult;
  addTsigKey(name: string, algorithm: string, secret: string): DnsOpResult;
  removeTsigKey(name: string): DnsOpResult;
  listTsigKeys(): { name: string; algorithm: string }[];
}

// ── DHCP Server role (PRD-Windows-Server.md §5 P8) ──────────────────────────

export interface DhcpOpResult { ok: boolean; message: string }
export interface DhcpScopeInfo { scopeId: string; name: string; startRange: string; endRange: string; subnetMask: string; leaseDuration: number; state: 'Active' | 'Inactive' }
export interface DhcpReservationInfo { scopeName: string; ipAddress: string; clientId: string }
export interface DhcpExclusionInfo { start: string; end: string }
export interface DhcpOptionInfo { optionId: number; name: string; values: string[] }
export interface DhcpScopeStats { total: number; inUse: number; free: number; percentInUse: number }
export interface DhcpServerStats { scopes: number; totalAddresses: number; inUse: number; free: number }
export interface DhcpLeaseInfo { ipAddress: string; clientId: string; scopeId: string; scopeName: string; leaseExpiration: number; type: 'automatic' | 'manual' }

export interface IDhcpServerProvider {
  addScope(name: string, startRange: string, endRange: string, subnetMask: string, leaseDurationSeconds?: number): DhcpOpResult;
  getScope(name: string): DhcpScopeInfo | null;
  listScopes(): DhcpScopeInfo[];

  addExclusionRange(startRange: string, endRange: string): DhcpOpResult;
  addReservation(scopeName: string, ipAddress: string, clientId: string): DhcpOpResult;
  setOptionValue(scopeName: string | undefined, optionId: number, values: string[]): DhcpOpResult;
  getLeases(scopeName?: string): DhcpLeaseInfo[];

  setScope(name: string, changes: { newName?: string; leaseDuration?: number; state?: 'Active' | 'Inactive' }): DhcpOpResult;
  removeScope(name: string): DhcpOpResult;
  listExclusionRanges(): DhcpExclusionInfo[];
  removeExclusionRange(startRange: string, endRange: string): DhcpOpResult;
  listReservations(scopeName?: string): DhcpReservationInfo[];
  removeReservation(scopeName: string, ipAddress: string): DhcpOpResult;
  removeLease(ipAddress: string): DhcpOpResult;
  hasScope(scopeName: string): boolean;
  listOptionValues(scopeName?: string): DhcpOptionInfo[];
  removeOptionValue(scopeName: string | undefined, optionId: number): DhcpOpResult;
  scopeStatistics(scopeName: string): DhcpScopeStats | null;
  serverStatistics(): DhcpServerStats;

  authorizeInDC(dnsName?: string, ipAddress?: string): DhcpOpResult;
  registeredIdentity(): { dnsName: string | null; ipAddress: string | null };
  listBindings(): Array<{ interfaceAlias: string; ipAddress: string; subnetMask: string; bindingState: boolean }>;
  getDnsSettings(): { dynamicUpdates: string; deleteDnsRRonLeaseExpiry: boolean; updateDnsRRForOlderClients: boolean; nameProtection: boolean };
  setDnsSettings(changes: Record<string, unknown>): DhcpOpResult;
  isAuthorizedInDC(): boolean;
  isRegisteredInDC(): boolean;
  revokeInDC(): DhcpOpResult;
  getConflictDetectionAttempts(): number;
  setConflictDetectionAttempts(attempts: number): DhcpOpResult;
  serverAddress(): string;
  serverName(): string;
}

// ── NPS (RADIUS) role (PRD-Windows-Server.md §5 P9) ─────────────────────────

export interface NpsOpResult { ok: boolean; message: string }
export interface NasClientInfo { name: string; ipAddress: string; nasType?: string }
export interface NetworkPolicyInfo { name: string; group: string; vlanId?: number; sessionTimeoutSec?: number }

/** `New-NpsConnectionRequestPolicy` conditions (PRD-Windows-Server-Advanced.md §5 P22). */
export interface ConnectionRequestPolicyConditionsInfo {
  group?: string;
  nasType?: string;
  clientIpAddress?: string;
  daysAndTimes?: { days: readonly number[]; startHour: number; endHour: number };
}
export interface ConnectionRequestPolicyInfo { name: string; conditions: ConnectionRequestPolicyConditionsInfo }

export interface INpsProvider {
  addNasClient(name: string, ipAddress: string, sharedSecret: string, nasType?: string): NpsOpResult;
  removeNasClient(name: string): NpsOpResult;
  getNasClient(name: string): NasClientInfo | null;
  listNasClients(): NasClientInfo[];

  addNetworkPolicy(name: string, group: string, vlanId?: number, sessionTimeoutSec?: number): NpsOpResult;
  removeNetworkPolicy(name: string): NpsOpResult;
  listNetworkPolicies(): NetworkPolicyInfo[];

  /** `New-NpsConnectionRequestPolicy` — multi-condition policy, evaluated in priority order before network policies. */
  addConnectionRequestPolicy(name: string, conditions: ConnectionRequestPolicyConditionsInfo): NpsOpResult;
  removeConnectionRequestPolicy(name: string): NpsOpResult;
  listConnectionRequestPolicies(): ConnectionRequestPolicyInfo[];

  /** `Set-NpsAccountingConfiguration -SqlLogging` — redirects RADIUS accounting records into the simulated SQL table instead of a flat file. */
  setSqlAccounting(enabled: boolean): NpsOpResult;
  isSqlAccountingEnabled(): boolean;
  /** Runs a read query (e.g. `SELECT * FROM RADIUS_ACCOUNTING`) against the accounting table — each row as a plain object keyed by (uppercased) column name; null until SQL logging has been enabled. */
  queryAccounting(sql: string): Record<string, import('@/powershell/runtime/PSEnvironment').PSValue>[] | null;
}

export interface IRemotingProvider {
  /**
   * Resolve a computer name/IP to a remoting-capable target — over the
   * REAL network (TCP/5985 dial through cables/routing/firewalls, not a
   * topology-wide lookup). Without `credential`, only reachability and a
   * listening WinRM service are checked (Test-WSMan's semantics — no
   * auth). With `credential`, a full connect+negotiate+auth handshake is
   * required (Invoke-Command/Enter-PSSession's semantics); returns null
   * on any failure (unreachable, WinRM not listening, or bad credentials).
   */
  resolveComputer(name: string, credential?: { username: string; password: string }): IRemoteComputer | null;
  /** `Enable-PSRemoting` on THIS (local) device. */
  enablePSRemoting(): void;
  /** This device's own WinRM enabled state (Test-WSMan with no -ComputerName). */
  isLocalRemotingEnabled(): boolean;
  /** This device's own CredSSP delegation state (Get-WSManCredSSP). */
  isLocalCredSSPEnabled(): boolean;
}

// ─── Provider interfaces ────────────────────────────────────────────────────

export interface IFileSystemProvider {
  /** Check if a path exists (file or directory). */
  exists(path: string): boolean;
  /** Read a file's full text content. Throws if not found. */
  readFile(path: string): string;
  /** Read the last n lines of a file. */
  tailFile(path: string, lines: number): string[];
  /** Write (overwrite) a file. Creates if needed. */
  writeFile(path: string, content: string): void;
  /** Append text to a file. Creates if needed. */
  appendFile(path: string, content: string): void;
  /** List directory entries. */
  listDir(path: string): DirEntry[];
  /** Create a new empty file. */
  createFile(path: string): void;
  /** Create a directory (and parents if needed). */
  createDir(path: string): void;
  /** Delete a path. If recurse=false and path is non-empty dir, throw. */
  remove(path: string, recurse: boolean): void;
  /** Copy src to dest. */
  copy(src: string, dest: string): void;
  /** Move (rename) src to dest. */
  move(src: string, dest: string): void;
  /** Resolve to absolute path given current working directory. */
  normalizePath(path: string, cwd: string): string;
  /** Return current working directory. */
  getCwd(): string;
  /** Update current working directory. */
  setCwd(path: string): void;
  /** Check if path is a directory. */
  isDirectory(path: string): boolean;
  /** Get ACL info for a path. */
  getAcl(path: string): { owner: string; acl: Array<{ principal: string; type: string; permissions: string[] }> } | null;
  /** Set the owner of a path. Returns true on success. */
  setOwner(path: string, owner: string): boolean;
  /** Add an ACE (Access Control Entry) to a path. Returns true on success. */
  addAce(path: string, ace: { principal: string; type: 'allow' | 'deny'; permissions: string[] }): boolean;
  /** Enable/disable inheritance (real NTFS `SetAccessRuleProtection`/`icacls /inheritance:r`). Returns true on success. */
  setAclProtected(path: string, isProtected: boolean): boolean;
  /** SACL — la liste d'audit, distincte de la DACL (`Get-Acl -Audit`). */
  getAudit?(path: string): Array<{ principal: string; flags: Array<'success' | 'failure'>; permissions: string[] }>;
  setAudit?(path: string, rules: Array<{ principal: string; flags: Array<'success' | 'failure'>; permissions: string[] }>): boolean;
}

export interface IRegistryProvider {
  testPath(path: string): boolean;
  getItem(path: string): string;
  getChildItem(path: string): string;
  newItem(path: string, force: boolean): string;
  removeItem(path: string, recurse: boolean): string;
  getItemProperty(path: string, name?: string): string;
  /**
   * Read registry values as a structured object: `{ propName: value, ... }`.
   * Returns `null` when the path does not exist. Used by Get-ItemProperty to
   * expose individual properties (`(Get-ItemProperty ...).PropName`) without
   * parsing the human-readable formatted string.
   */
  getItemPropertyValues?(path: string): Record<string, string | number> | null;
  setItemProperty(path: string, name: string, value: string | number): string;
  removeItemProperty(path: string, name: string): string;
  getPSDrive(): string;
}

export interface IServiceProvider {
  listServices(nameFilter?: string): ServiceInfo[];
  getService(name: string): ServiceInfo | null;
  startService(name: string): string;
  stopService(name: string, force?: boolean): string;
  restartService(name: string, force?: boolean): string;
  setService(name: string, opts: { startType?: string; description?: string; displayName?: string; status?: string }): string;
  suspendService(name: string): string;
  resumeService(name: string): string;
  newService(name: string, opts: { binaryPath: string; displayName?: string; startType?: string; description?: string; dependsOn?: string[] }): string;
  removeService(name: string): string;
  /**
   * The primitive `Register-WmiEvent … -Query "… WHERE TargetInstance ISA
   * 'Win32_Service' …"` polls on top of: fires `cb` every time the named
   * service's state changes. Returns a subscription id for unregistering.
   */
  registerInstanceWatcher(serviceName: string, cb: (evt: { previousState: string; newState: string; timestamp: Date }) => void): string;
  unregisterInstanceWatcher(id: string): void;
}

export interface IProcessProvider {
  listProcesses(nameFilter?: string): ProcessInfo[];
  getProcess(nameOrPid: string | number): ProcessInfo | null;
  killProcess(nameOrPid: string | number, force: boolean): string;
  /**
   * Spawn a new process. Used by `Start-Process` and cmd `start <prog>`
   * so the device's process table is shared between both shells.
   * Returns the new ProcessInfo (or `null` if the call was rejected).
   */
  startProcess?(imageName: string, opts?: { arguments?: string; user?: string }): ProcessInfo | null;
  /**
   * Verifies a local account's password — used by `Start-Process -Credential`
   * (PRD-Nslookup-Dig-Rndc-Runas.md §2.1.7/P14) before spawning the process
   * under that identity. The runas/PSCredential counterpart of
   * WindowsUserManager.checkPassword.
   */
  checkCredential?(userName: string, password: string): boolean;
}

export interface JobInfo {
  id: number;
  name: string;
  state: string;
  hasMoreData: boolean;
  output: unknown[];
}

export interface IJobProvider {
  beginRecording(): void;
  recordSleep(ms: number): void;
  endRecording(): number;
  startJob(name: string | undefined, output: unknown[], durationMs: number): JobInfo;
  listJobs(): JobInfo[];
  getJob(idOrName: string | number): JobInfo | null;
  receiveJob(idOrName: string | number): unknown[];
  waitJob(idOrName: string | number): JobInfo | null;
}


export interface NetRouteAttributes {
  publish?: 'No' | 'Age' | 'Yes';
  protocol?: string;
  policyStore?: 'ActiveStore' | 'PersistentStore';
  addressFamily?: string;
  ifIndex?: number;
  validLifetimeSeconds?: number;
  preferredLifetimeSeconds?: number;
}

export interface NetIPAddressUpdate {
  prefixLength?: number;
  skipAsSource?: boolean;
  validLifetimeSeconds?: number;
  preferredLifetimeSeconds?: number;
}

export interface NetIPAddressOptions {
  gateway?: string;
  skipAsSource?: boolean;
  type?: 'Unicast' | 'Anycast';
  policyStore?: 'ActiveStore' | 'PersistentStore';
  validLifetimeSeconds?: number;
  preferredLifetimeSeconds?: number;
}

export type NeighborInfo = NetNeighborRow;

export interface AdapterStatisticsInfo {
  name: string;
  receivedBytes: number;
  receivedUnicastPackets: number;
  receivedDiscardedPackets: number;
  receivedPacketErrors: number;
  sentBytes: number;
  sentUnicastPackets: number;
  outboundDiscardedPackets: number;
  outboundPacketErrors: number;
}

export interface NicTeamInfo {
  name: string;
  members: string[];
  teamNics: string[];
  teamingMode: string;
  loadBalancingAlgorithm: string;
  lacpTimer: string;
  status: string;
}

export interface NicTeamNicInfo {
  name: string;
  team: string;
  vlanId: number | null;
  primary: boolean;
  isDefault: boolean;
}

export interface NicTeamMemberInfo {
  name: string;
  interfaceDescription: string;
  team: string;
  administrativeMode: string;
  operationalStatus: string;
  transmitLinkSpeed: string;
  receiveLinkSpeed: string;
  failureReason: string;
}

export interface NewNicTeamRequest {
  name: string;
  teamMembers: string[];
  teamNicName?: string;
  teamingMode?: string;
  loadBalancingAlgorithm?: string;
  lacpTimer?: string;
}

export interface SetNicTeamRequest {
  teamingMode?: string;
  loadBalancingAlgorithm?: string;
  lacpTimer?: string;
}

export interface INetworkProvider {
  getNicTeams?(): NicTeamInfo[];
  newNicTeam?(request: NewNicTeamRequest): string;
  setNicTeam?(name: string, request: SetNicTeamRequest): string;
  removeNicTeam?(name: string): string;
  getNicTeamMembers?(team?: string): NicTeamMemberInfo[];
  getNicTeamNics?(team?: string): NicTeamNicInfo[];
  addNicTeamNic?(team: string, vlanId: number, name?: string): string;
  removeNicTeamNic?(team: string, vlanId: number): string;
  setNicTeamNic?(name: string, patch: { vlanId?: number; isDefault?: boolean }): string;
  addNicTeamMember?(team: string, name: string, administrativeMode?: string): string;
  setNicTeamMember?(name: string, administrativeMode: string): string;
  removeNicTeamMember?(name: string): string;
  getHostname(): string;
  getAdapters(): NetAdapterEntry[];
  getAdapter(name: string): NetAdapterEntry | null;
  setAdapterMac(portName: string, mac: import('@/network/core/types').MACAddress): void;
  getAdapterStatistics(name: string): AdapterStatisticsInfo | null;
  getIPAddresses(ifAlias?: string): IPAddressInfo[];
  addIPAddress(ip: string, prefixLength: number, ifAlias: string, opts?: NetIPAddressOptions): void;
  removeIPAddress(ip: string, ifAlias?: string): void;
  resolveNetInterface(spec: { alias?: string; index?: number }): { alias: string; ifIndex: number } | null;
  setDhcpEnabled(ifAlias: string, enabled: boolean): void;
  getRoutes(ifAlias?: string): RouteInfo[];
  getNeighbors(): NeighborInfo[];
  addNeighbor(plan: NetNeighborPlan): string;
  removeNeighbors(rows: readonly NeighborInfo[]): number;
  setNeighborLinkLayer(rows: readonly NeighborInfo[], linkLayerAddress: import('@/network/core/types').MACAddress): number;
  clearNeighbors(ifAlias?: string): void;
  addRoute(dest: string, ifAlias: string, nextHop: string, metric: number, opts?: NetRouteAttributes): void;
  removeRoute(route: NetRouteIdentity): void;
  setRoute(route: NetRouteIdentity, update: NetRouteUpdate): string;
  /** Modify properties of an existing IP — usually prefixLength. */
  setIPAddress(ip: string, ifAlias: string, opts: NetIPAddressUpdate): string;
  getDnsServers(ifAlias: string): string[];
  setDnsServers(ifAlias: string, servers: string[]): void;
  getDefaultGateway(): string | null;
  isDHCPConfigured(ifAlias: string): boolean;
  getDhcpServer?(ifAlias: string): string | null;
  /** Test-Connection (ping) */
  testConnection(target: string): boolean;
  /**
   * Synchronous reachability probe: send a real ICMP echo, capture the
   * reply via the bus's synchronous publish, return the outcome. Returns
   * null only when the target cannot be resolved to an IP.
   */
  testPingProbe(target: string): { success: boolean; rttMs: number; resolvedIp: string } | null;
  /**
   * Synchronous TCP probe: open the socket, observe whether the handshake
   * settles to established inline. The simulator's bus is synchronous so
   * the SYN/SYN-ACK/ACK exchange completes within the connect() call.
   */
  testTcpProbe(target: string, port: number): boolean;
  /** Egress {sourceIp, interfaceAlias, nextHop} for a target IP, or null. */
  egressInfoFor(target: string): { sourceIp: string; interfaceAlias: string; nextHop: string } | null;
  /** Traceroute hop IP addresses ('0.0.0.0' for a timed-out/unreachable hop). */
  traceRoute(target: string): string[];
  /** Resolve-DnsName */
  resolveDns(name: string): string[];
  /**
   * `Resolve-DnsName` avec ses restrictions d'ordre (`-DnsOnly`,
   * `-LlmnrOnly`, `-NoHostsFile`, `-CacheOnly`) — la seule façon, la
   * cmdlet ne nommant pas le protocole qui a répondu, de savoir laquelle
   * des étapes a servi le nom.
   */
  resolveDnsWithOptions?(name: string, options: {
    dnsOnly?: boolean; llmnrOnly?: boolean;
    noHostsFile?: boolean; cacheOnly?: boolean;
  }): string[];
  /** Resolve-DnsName -Server: query a specific resolver over the wire. */
  resolveDnsViaServer?(name: string, server: string): string[];
  /** Resolve-DnsName -Server, with each answer's real TTL (does not touch the client cache). */
  resolveDnsViaServerWithTtl?(name: string, server: string): Array<{ ip: string; ttl: number }>;
  /** Get-DnsClientCache */
  getDnsClientCache?(): DnsCacheRow[];
  /** Clear-DnsClientCache */
  clearDnsClientCache?(): void;
  /**
   * `Invoke-WebRequest -Uri` (PRD-Windows-Server.md §5 P11): resolves the
   * host (same real DNS chain as `Resolve-DnsName`) then dials a real
   * HTTP request over `TcpStack` — reaches the IIS role (or any other
   * real HTTP-hosting device) on the simulated network, not a stub.
   */
  invokeWebRequest?(url: string): { ok: boolean; error?: string; statusCode?: number; statusDescription?: string; content?: string; headers?: Record<string, string> };
  /**
   * `Send-MailMessage`: a real outbound SMTP client transaction (DNS
   * resolution + `TcpStack` + `SmtpClientSession`, same engine as
   * `relay.ts`/Exchange transport, docs/PRD-SMTP.md §0.2) — not a stub
   * that unconditionally reports success.
   */
  sendMailMessage?(opts: {
    from: string; to: readonly string[]; cc?: readonly string[]; bcc?: readonly string[];
    subject: string; body: string; smtpServer: string; port?: number;
    useSsl?: boolean; credential?: { username: string; password: string };
  }): { ok: boolean; error?: string };
  /** Get-NetTCPConnection */
  getTcpConnections(): Array<{ localAddress: string; localPort: number; remoteAddress: string; remotePort: number; state: string; pid: number }>;
  /**
   * `Get-NetUDPEndpoint` — le pendant UDP de `Get-NetTCPConnection`. UDP
   * n'ayant pas d'état, un point de terminaison est une écoute et rien
   * d'autre : c'est par là qu'on voit qu'un répondeur de lien tient
   * réellement son port.
   */
  getUdpEndpoints?(): Array<{ localAddress: string; localPort: number; pid: number; processName: string }>;
  getFirewallRules(): NetFirewallRuleEntry[];
  addFirewallRule(rule: NetFirewallRuleEntry): string;
  updateFirewallRule(name: string, patch: Partial<NetFirewallRuleEntry>): void;
  removeFirewallRule(name: string): void;
  /** Adapter enable/disable/rename */
  setAdapterStatus(name: string, status: 'Up' | 'Down'): void;
  renameAdapter(name: string, newName: string): void;
  /** Network profiles */
  getNetworkProfile(ifIndex: number): string;
  setNetworkProfile(ifIndex: number, category: string): void;
  /** WLAN */
  getWlanSSID(): string;
  getWlanProfiles(): string[];
  /** WinHTTP proxy */
  getWinhttpProxy(): string;
  setWinhttpProxy(proxy: string): void;
  /** Execute a CMD-level native command (ping, ipconfig, tracert, etc.) */
  executeCmdCommand(cmd: string): Promise<string>;
  /**
   * Synchronous variant for native commands whose underlying handler is
   * sync (ipconfig / netsh / arp / route / getmac / systeminfo / ver /
   * nslookup). Returns null when the command is async or unknown — callers
   * should fall back to executeCmdCommand or skip the call.
   */
  runSyncNativeCommand(cmd: string, args: string[]): string | null;
}

export interface IUserProvider {
  listUsers(): UserInfo[];
  getUser(name: string): UserInfo | null;
  createUser(name: string, opts: { password?: string; fullName?: string; description?: string }): string;
  removeUser(name: string): string;
  setUser(name: string, opts: { enabled?: boolean; fullName?: string; description?: string; password?: string }): string;
  enableUser(name: string): string;
  disableUser(name: string): string;
  renameUser(oldName: string, newName: string): string;

  listGroups(): GroupInfo[];
  getGroup(name: string): GroupInfo | null;
  createGroup(name: string, opts?: { description?: string }): string;
  removeGroup(name: string): string;
  renameGroup(oldName: string, newName: string): string;
  addGroupMember(group: string, member: string): string;
  removeGroupMember(group: string, member: string): string;
  getGroupMembers(group: string): UserInfo[];
  isAdmin(userName: string): boolean;
}

export interface ScheduledTaskInfo {
  taskName: string;
  taskPath: string;
  state: 'Ready' | 'Running' | 'Disabled';
  command?: string;
  runAt?: Date;
  intervalMs?: number;
  principal?: { userId: string; runLevel: string };
  /** Renseigné par le planificateur après chaque exécution. */
  lastRunTime?: Date;
  lastResult?: string;
  /**
   * Ce que `schtasks /query /v` imprime en plus des trois colonnes.
   * Décrit la même ligne de la même table que `WinScheduledTask` : une
   * tâche posée par `Register-ScheduledTask` doit se relire par `schtasks`
   * aussi complètement qu'une posée par `/create`, sans quoi la moitié de
   * la vue détaillée dépend de la commande qui a créé la tâche.
   */
  author?: string;
  runAsUser?: string;
  scheduleType?: string;
  /** Occurrences passées pendant que le planificateur était arrêté. */
  missedRuns?: number;
  startTime?: string;
  startDate?: Date;
  days?: string;
  months?: string;
}

export interface IScheduledTaskProvider {
  listTasks(nameFilter?: string): ScheduledTaskInfo[];
  registerTask(task: ScheduledTaskInfo): string;
  unregisterTask(name: string): string;
  /** The device's own simulated clock — anchors trigger `-At` times. */
  now?(): Date;
  /**
   * Change one task in place — what `Enable-`, `Disable-` and
   * `Set-ScheduledTask` do. Returns an error message, or `''`.
   */
  updateTask?(name: string, patch: Partial<ScheduledTaskInfo>): string;
  /** Run a task now, whatever its trigger says — `Start-ScheduledTask`. */
  runTask?(name: string): string;
}

export interface DiskInfo {
  number: number;
  friendlyName: string;
  size: number;       // bytes
  partitionStyle: string;
  operationalStatus: string;
}
export interface VolumeInfo {
  driveLetter: string;
  fileSystemLabel: string;
  fileSystem: string;
  sizeRemaining: number;
  size: number;
  driveType: string;
}
export interface IEnvironmentProvider {
  /** Returns every environment variable visible on the device. */
  list(): Array<{ Name: string; Value: string }>;
  /** Reads one variable (case-insensitive on Windows). */
  get(name: string): string | undefined;
  /** Persists a variable on the device so cmd subshells see it too. */
  set(name: string, value: string): void;
  /** Removes a variable. */
  remove(name: string): void;
}

export interface IDiskProvider {
  listDisks(): DiskInfo[];
  listVolumes(): VolumeInfo[];
}

export interface VpnConnectionInfo {
  name: string;
  serverAddress: string;
  tunnelType: string;
  encryptionLevel: string;
  authMethod: string;
  splitTunneling: boolean;
  destinationPrefixes: string[];
  connectionStatus: 'Disconnected' | 'Connected';
}

export interface IVpnProvider {
  listConnections(nameFilter?: string): VpnConnectionInfo[];
  getConnection(name: string): VpnConnectionInfo | null;
  addConnection(conn: VpnConnectionInfo): void;
  setConnection(name: string, opts: Partial<Omit<VpnConnectionInfo, 'name'>>): string;
  removeConnection(name: string): string;
  addConnectionRoute(name: string, destinationPrefix: string): string;
  /** Actually establish the tunnel: real routes installed against the host's routing table. */
  connect(name: string): string;
  /** Tear down the tunnel: removes the routes installed by connect(). */
  disconnect(name: string): string;
}

export interface IEventLogProvider {
  listLogs(): Array<{ logName: string; entries: number; maxSizeKB: number }>;
  getEntries(logName: string, opts?: { newest?: number; entryType?: string; source?: string }): EventLogEntryInfo[];
  writeEntry(logName: string, source: string, eventId: number, entryType: string, message: string, data?: Record<string, string>): void;
  clearLog(logName: string): string;
  newLog(logName: string, source: string): string;
  limitLog(logName: string, maxSizeKB: number): void;
}

// ─── PSProviders bag ────────────────────────────────────────────────────────

/**
 * DI bag injected into every CmdletContext.
 * Fields are null when running without a device (standalone PSInterpreter).
 * Windows-specific cmdlets check for null before using a provider:
 *
 *   if (!ctx.providers.filesystem) throw new PSRuntimeError('No filesystem available');
 */
/**
 * Le fuseau horaire de la machine (`docs/PRD-NTP-Tutoriel.md` §5).
 *
 * C'est un PORT etroit, et non un acces a l'identite systeme entiere :
 * `Get-TimeZone`/`Set-TimeZone` n'ont besoin que de lire et d'ecrire ce
 * champ, et le partager avec `timedatectl` est ce qui empeche une
 * machine Windows et une machine Linux de donner deux fuseaux
 * differents pour la meme configuration.
 */
export interface ITimezoneProvider {
  readonly timezone: string;
  setTimezone(nom: string): void;
}

export interface PSProviders {
  readonly identity:       ITimezoneProvider       | null;
  readonly filesystem:     IFileSystemProvider     | null;
  readonly registry:       IRegistryProvider       | null;
  readonly services:       IServiceProvider        | null;
  readonly network:        INetworkProvider        | null;
  readonly processes:      IProcessProvider        | null;
  readonly jobs:           IJobProvider            | null;
  readonly users:          IUserProvider           | null;
  readonly eventLog:       IEventLogProvider       | null;
  readonly vpn:            IVpnProvider            | null;
  readonly scheduledTasks: IScheduledTaskProvider  | null;
  readonly disks:          IDiskProvider           | null;
  readonly environment:    IEnvironmentProvider    | null;
  readonly remoting:       IRemotingProvider       | null;
  readonly roles:          IRoleProvider           | null;
  readonly smb:            ISmbProvider            | null;
  readonly ad:             IAdProvider             | null;
  readonly computer:       IComputerProvider       | null;
  readonly dns:            IDnsServerProvider      | null;
  readonly dhcp:           IDhcpServerProvider     | null;
  readonly nps:            INpsProvider            | null;
  readonly gpo:            IGpoProvider            | null;
  readonly iis:            IIisProvider            | null;
  readonly exchange:       IExchangeProvider       | null;
  readonly adcs:           IAdcsProvider           | null;
  readonly pki:            IPkiProvider            | null;
  readonly dfs:            IDfsProvider            | null;
  readonly rdp:            IRdpProvider            | null;
  readonly cluster:        IClusterProvider        | null;
  readonly wsus:           IWsusProvider           | null;
  readonly windowsUpdate:  IWindowsUpdateProvider  | null;
  readonly print:          IPrintProvider          | null;
  readonly licensing:      ILicensingProvider      | null;
}
