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
}

export interface NetworkAdapterInfo {
  name: string;
  displayName: string;
  ifIndex: number;
  status: string;
  macAddress: string;
  linkSpeed: string;
}

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
}

export interface RouteInfo {
  destinationPrefix: string;
  ifAlias: string;
  nextHop: string;
  routeMetric: number;
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
  psModule?: string;
}

export interface IRoleProvider {
  listFeatures(): WindowsFeatureInfo[];
  getFeature(name: string): WindowsFeatureInfo | null;
  isInstalled(name: string): boolean;
  installFeature(name: string, opts?: { includeManagementTools?: boolean }):
    { ok: boolean; message: string; changed: WindowsFeatureInfo[] };
  uninstallFeature(name: string): { ok: boolean; message: string; changed: WindowsFeatureInfo[] };
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
  sam: string; upn: string; dn: string; enabled: boolean; memberOf: string[]; fullName: string;
}
export interface AdGroupInfo {
  sam: string; dn: string; scope: 'DomainLocal' | 'Global' | 'Universal'; members: string[];
}
export interface AdComputerInfo { name: string; dn: string; enabled: boolean }
export interface AdOrgUnitInfo { name: string; dn: string; gpLinks: string[] }
export interface AdOpResult { ok: boolean; message: string }

export interface IAdProvider {
  /** `Install-ADDSForest` — promotes this server to a new forest's first DC. Fails if already promoted. */
  installForest(domainName: string, netbiosName: string | undefined, safeModeAdminPassword: string): AdOpResult;
  /** Whether this server has already been promoted (`Install-ADDSForest` succeeded). */
  isForestInstalled(): boolean;
  /** `Install-ADDSDomainController` (PRD-Windows-Server-Advanced.md §5 P5) — promotes this server as an additional DC of a domain that already exists at `sourceDcAddress`, via a real initial replication sync. */
  installDomainController(
    domainName: string, netbiosName: string | undefined, sourceDcAddress: string,
    credentialUser: string, credentialPassword: string, safeModeAdminPassword: string,
  ): AdOpResult;
  /** `Get-ADDomainController` — every domain controller this DC currently knows about (itself, plus any replicated in). */
  listDomainControllers(): AdComputerInfo[];

  newUser(sam: string, opts: { password: string; fullName?: string; path?: string; enabled?: boolean }): AdOpResult;
  getUser(identity: string): AdUserInfo | null;
  setUser(identity: string, opts: { enabled?: boolean; fullName?: string; password?: string }): AdOpResult;
  removeUser(identity: string): AdOpResult;

  newGroup(sam: string, scope: AdGroupInfo['scope'], path?: string): AdOpResult;
  getGroup(identity: string): AdGroupInfo | null;
  addGroupMember(groupIdentity: string, members: string[]): AdOpResult;
  removeGroupMember(groupIdentity: string, members: string[]): AdOpResult;

  getComputer(identity: string): AdComputerInfo | null;
  /** `Set-ADComputer -Identity <name> -AllowedToDelegateTo <svc1,svc2,...>` (PRD-Windows-Server-Advanced.md §5 P10) — the `msDS-AllowedToDelegateTo` list S4U2Proxy checks. */
  setComputerAllowedToDelegateTo(identity: string, targetServiceNames: string[]): AdOpResult;

  newOrganizationalUnit(name: string, path?: string): AdOpResult;
  getOrganizationalUnit(identity: string): AdOrgUnitInfo | null;

  /** `New-ADReplicationSite` (PRD-Windows-Server-Advanced.md §5 P6). */
  newReplicationSite(name: string): AdOpResult;
  /** `Get-ADReplicationSite` (no `-Identity`: every site this DC knows about). */
  listReplicationSites(): AdSiteInfo[];
  /** `New-ADReplicationSubnet -Name <cidr> -Site <site>`. */
  newReplicationSubnet(cidr: string, siteName: string): AdOpResult;

  /** `New-ADAttribute` (PRD-Windows-Server-Advanced.md §5 P7, RFC 4512 §4). */
  newAttribute(schema: AdAttributeSchemaInfo): AdOpResult;
  /** `New-ADObjectClass`. */
  newObjectClass(schema: AdObjectClassSchemaInfo): AdOpResult;

  /** `New-ADDomain -NewDomainName ... -ParentDomainName ...` (PRD-Windows-Server-Advanced.md §5 P8) — a new child domain of the forest reached via `parentDcAddress`. */
  newDomain(
    newDomainDnsName: string, netbiosName: string | undefined, parentDomainName: string, parentDcAddress: string,
    credentialUser: string, credentialPassword: string, safeModeAdminPassword: string,
  ): AdOpResult;
  /** `Get-ADForest` — null if this server isn't a DC. */
  getForest(): AdForestInfo | null;

  /** `New-ADTrust`/`netdom trust` (PRD-Windows-Server-Advanced.md §5 P9) — a simple trust with the domain reached at `remoteDcAddress`. */
  newTrust(
    remoteRealm: string, remoteDcAddress: string, direction: AdTrustInfo['direction'], transitive: boolean,
    credentialUser: string, credentialPassword: string,
  ): AdOpResult;
  /** `Get-ADTrust -Identity <remoteRealm>` — null if no such trust exists (or this server isn't a DC). */
  getTrust(remoteRealm: string): AdTrustInfo | null;
  /** `Get-ADTrust` with no `-Identity`: every trust this DC knows about. */
  listTrusts(): AdTrustInfo[];
}

export interface AdForestInfo {
  functionalLevel: string;
  domains: { dnsName: string; netbiosName: string; parentDnsName?: string }[];
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

export interface DomainMembershipInfo { dnsName: string; netbiosName: string; dcAddress: string }

export interface IComputerProvider {
  /**
   * `Add-Computer -DomainName` — real LDAP `AddRequest` join dialogue
   * against the DC (PRD-Windows-Server.md §5 P6), not a direct method
   * call into the DC's directory. `server` is an explicit DC hostname/IP
   * fallback — there is no DNS SRV `_ldap._tcp.dc._msdcs` discovery yet
   * (depends on the DNS Server role, P7); when omitted, the domain name
   * itself is resolved as a hostname.
   */
  join(domainName: string, credential: { username: string; password: string }, server?: string): AdOpResult;
  /** This machine's domain-join state, or null while in a workgroup. */
  getDomainInfo(): DomainMembershipInfo | null;
}

// ── Group Policy (PRD-Windows-Server.md §5 P10) ─────────────────────────────

export interface GpoInfo { id: string; name: string; links: string[] }

export interface IGpoProvider {
  newGpo(name: string): AdOpResult;
  getGpo(name: string): GpoInfo | null;
  listGpos(): GpoInfo[];
  /** `New-GPLink -Target` accepts a distinguished name (domain root or an OU's DN, e.g. from `Get-ADOrganizationalUnit`). */
  newGPLink(gpoName: string, targetDn: string): AdOpResult;
  getDomainDn(): string;
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
export interface DfsTargetInfo { serverAddress: string; shareName: string }
export interface DfsFolderInfo { namespacePath: string; folderName: string; targets: readonly DfsTargetInfo[] }
export interface DfsrSyncResultInfo { ok: boolean; error?: string; applied: number }

export interface IDfsProvider {
  /** `New-DfsnRoot -Path <namespacePath>`. */
  newDfsnRoot(namespacePath: string): DfsOpResult;
  /** `New-DfsnFolder -Path <namespacePath\folderName> -TargetPath <\\server\share>`. */
  newDfsnFolder(namespacePath: string, folderName: string, target: DfsTargetInfo): DfsOpResult;
  /** `New-DfsnFolderTarget` — adds another target to an existing folder. */
  addDfsnFolderTarget(namespacePath: string, folderName: string, target: DfsTargetInfo): DfsOpResult;
  /** `Get-DfsnFolder` — the folder's current targets (this simulator's referral resolution). */
  getDfsnFolder(namespacePath: string, folderName: string): DfsFolderInfo | null;

  /** `New-DfsReplicationGroup -GroupName <name> -ContentPath <localPath>` — this server's own membership. */
  newDfsReplicationGroup(groupName: string, contentPath: string): DfsOpResult;
  /** `Sync-DfsReplicationGroup -GroupName <name> -PartnerServer <address>` — one manually-triggered DFSR pull cycle. */
  syncDfsReplicationGroup(groupName: string, partnerAddress: string): DfsrSyncResultInfo;
}

// ── DNS Server role (PRD-Windows-Server.md §5 P7) ───────────────────────────

export interface DnsOpResult { ok: boolean; message: string }
export interface DnsZoneInfo { name: string; recordCount: number }
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
}

// ── DHCP Server role (PRD-Windows-Server.md §5 P8) ──────────────────────────

export interface DhcpOpResult { ok: boolean; message: string }
export interface DhcpScopeInfo { name: string; startRange: string; endRange: string; subnetMask: string; leaseDuration: number }
export interface DhcpLeaseInfo { ipAddress: string; clientId: string; scopeName: string; leaseExpiration: number; type: 'automatic' | 'manual' }

export interface IDhcpServerProvider {
  addScope(name: string, startRange: string, endRange: string, subnetMask: string, leaseDurationSeconds?: number): DhcpOpResult;
  getScope(name: string): DhcpScopeInfo | null;
  listScopes(): DhcpScopeInfo[];

  addExclusionRange(startRange: string, endRange: string): DhcpOpResult;
  addReservation(scopeName: string, ipAddress: string, clientId: string): DhcpOpResult;
  setOptionValue(scopeName: string, optionId: number, values: string[]): DhcpOpResult;
  getLeases(scopeName?: string): DhcpLeaseInfo[];

  authorizeInDC(): DhcpOpResult;
}

// ── NPS (RADIUS) role (PRD-Windows-Server.md §5 P9) ─────────────────────────

export interface NpsOpResult { ok: boolean; message: string }
export interface NasClientInfo { name: string; ipAddress: string }
export interface NetworkPolicyInfo { name: string; group: string; vlanId?: number; sessionTimeoutSec?: number }

export interface INpsProvider {
  addNasClient(name: string, ipAddress: string, sharedSecret: string): NpsOpResult;
  removeNasClient(name: string): NpsOpResult;
  getNasClient(name: string): NasClientInfo | null;
  listNasClients(): NasClientInfo[];

  addNetworkPolicy(name: string, group: string, vlanId?: number, sessionTimeoutSec?: number): NpsOpResult;
  removeNetworkPolicy(name: string): NpsOpResult;
  listNetworkPolicies(): NetworkPolicyInfo[];
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


export interface NeighborInfo {
  ifIndex: number;
  ifAlias: string;
  ipAddress: string;
  linkLayerAddress: string;
  state: 'Reachable' | 'Permanent' | 'Unreachable' | 'Stale' | 'Incomplete';
  addressFamily: 'IPv4' | 'IPv6';
  policyStore: 'ActiveStore' | 'PersistentStore';
}

export interface INetworkProvider {
  getHostname(): string;
  getAdapters(): NetworkAdapterInfo[];
  getAdapter(name: string): NetworkAdapterInfo | null;
  getIPAddresses(ifAlias?: string): IPAddressInfo[];
  addIPAddress(ip: string, prefixLength: number, ifAlias: string, opts?: { gateway?: string }): void;
  removeIPAddress(ip: string, ifAlias?: string): void;
  getRoutes(ifAlias?: string): RouteInfo[];
  getNeighbors(filter?: { ipAddress?: import('@/network/core/types').IPAddress; state?: string; ifIndex?: number }): NeighborInfo[];
  addNeighbor(ipAddress: import('@/network/core/types').IPAddress, linkLayerAddress: import('@/network/core/types').MACAddress, ifAlias: string): string;
  removeNeighbor(ipAddress: import('@/network/core/types').IPAddress, ifAlias?: string): string;
  setNeighbor(ipAddress: import('@/network/core/types').IPAddress, linkLayerAddress: import('@/network/core/types').MACAddress, ifAlias?: string): string;
  addRoute(dest: string, ifAlias: string, nextHop: string, metric: number): void;
  removeRoute(dest: string, ifAlias?: string): void;
  /** Modify properties of an existing route — usually nextHop or metric. */
  setRoute(dest: string, opts: { nextHop?: string; routeMetric?: number; ifAlias?: string }): string;
  /** Modify properties of an existing IP — usually prefixLength. */
  setIPAddress(ip: string, opts: { prefixLength?: number }): string;
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
  /** Resolve-DnsName */
  resolveDns(name: string): string[];
  /** Resolve-DnsName -Server: query a specific resolver over the wire. */
  resolveDnsViaServer?(name: string, server: string): string[];
  /** Resolve-DnsName -Server, with each answer's real TTL (does not touch the client cache). */
  resolveDnsViaServerWithTtl?(name: string, server: string): Array<{ ip: string; ttl: number }>;
  /** Get-DnsClientCache */
  getDnsClientCache?(): Array<{ name: string; type: string; value: string; ttl: number }>;
  /** Clear-DnsClientCache */
  clearDnsClientCache?(): void;
  /**
   * `Invoke-WebRequest -Uri` (PRD-Windows-Server.md §5 P11): resolves the
   * host (same real DNS chain as `Resolve-DnsName`) then dials a real
   * HTTP request over `TcpStack` — reaches the IIS role (or any other
   * real HTTP-hosting device) on the simulated network, not a stub.
   */
  invokeWebRequest?(url: string): { ok: boolean; error?: string; statusCode?: number; statusDescription?: string; content?: string; headers?: Record<string, string> };
  /** Get-NetTCPConnection */
  getTcpConnections(): Array<{ localAddress: string; localPort: number; remoteAddress: string; remotePort: number; state: string; pid: number }>;
  getFirewallRules(): Array<{ name: string; displayName: string; enabled: boolean; action: string; direction: string; protocol: string; localPort: string; remotePort: string; description: string }>;
  addFirewallRule(rule: { name: string; displayName?: string; enabled?: boolean; action: string; direction: string; protocol?: string; localPort?: string; remotePort?: string; description?: string }): void;
  setFirewallRule(name: string, opts: { enabled?: boolean; action?: string }): string;
  removeFirewallRule(name: string): string;
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
}

export interface IScheduledTaskProvider {
  listTasks(nameFilter?: string): ScheduledTaskInfo[];
  registerTask(task: ScheduledTaskInfo): string;
  unregisterTask(name: string): string;
  /** The device's own simulated clock — anchors trigger `-At` times. */
  now?(): Date;
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
  writeEntry(logName: string, source: string, eventId: number, entryType: string, message: string): void;
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
export interface PSProviders {
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
  readonly adcs:           IAdcsProvider           | null;
  readonly pki:            IPkiProvider            | null;
  readonly dfs:            IDfsProvider            | null;
}
