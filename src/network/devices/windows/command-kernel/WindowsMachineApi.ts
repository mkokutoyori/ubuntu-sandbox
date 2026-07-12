import {
  AccountDetail,
  AccountMutationResult,
  AclEntry,
  AccountsPolicyApi,
  AuditPolicyApi,
  FileAttributes,
  FileNodeType,
  FileStat,
  FileSystemActor,
  FileSystemApi,
  GroupDetail,
  GroupInfo,
  GroupManagementApi,
  HardwareProfile as CkHardwareProfile,
  MachineApi,
  MacroApi,
  NetUseApi,
  NetUseMappingInfo,
  NetworkApi,
  OsIdentity,
  PowerApi,
  PrintApi,
  ProcessApi,
  ProcessInfo as CkProcessInfo,
  RegistryApi,
  ScheduledTaskInfo,
  SchedulingApi,
  SecurityIdentity,
  ServiceControlResult,
  ServiceFailureConfig,
  ServiceManagementApi,
  ServiceOpResult,
  SmbSessionApi,
  SmbSessionInfo,
  SmbShareApi,
  SmbShareInfo,
  SocketInfo,
  UserManagementApi,
  WindowsAdapterInfo,
  WindowsArpEntry,
  WindowsDhcpLease,
  WindowsDnsCacheEntry,
  WindowsIPv6AddressEntry,
  WindowsIPv6RouteEntry,
  WindowsBridge,
  WindowsBridgeStore,
  WindowsDhcpScope,
  WindowsDhcpServerApi,
  WindowsFirewallApi,
  WindowsFirewallRule,
  WindowsHttpSslCert,
  WindowsEventLogEntry,
  WindowsNasClient,
  WindowsNpsApi,
  WindowsServerOpResult,
  EventLogApi,
  DomainApi,
  WindowsGpResult,
  DomainControllerLocation,
  DomainControllerDiagnostics,
  KerberosCachedTicket,
  DomainTrustDirection,
  DnsServerAdminApi,
  DnsServerZoneRecord,
  DnsSrvRecordData,
  RunAsApi,
  LicensingApi,
  PrintClientApi,
  WindowsHttpStore,
  WindowsIpsecDynamicSettings,
  WindowsIpsecFilter,
  WindowsIpsecFilterAction,
  WindowsIpsecFilterList,
  WindowsIpsecPolicy,
  WindowsIpsecRule,
  WindowsIpsecStore,
  WindowsLanProfile,
  WindowsLanStore,
  WindowsNetConfigApi,
  WindowsNrptPolicy,
  WindowsNrptStore,
  WindowsWlanProfile,
  WindowsWlanStore,
  WindowsPingReply,
  WindowsPortProxyRule,
  WindowsRouteEntry,
  WindowsTracerouteHop,
  WinRmApi,
  WinRmListenerInfo,
} from '@/command-kernel/machine/types';
import { FileSystemError } from '@/command-kernel/errors';
import { User } from '@/command-kernel/session/types';
import type { Port } from '@/network/hardware/Port';
import { IPAddress, IPv6Address, MACAddress, SubnetMask } from '@/network/core/types';
import type { ARPEntry, HostRouteEntry } from '@/network/devices/EndHost';
import type { PingResult, TracerouteHop } from '@/network/devices/windows/WinCommandExecutor';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { PortProxyRule, PORT_PROXY_FAMILIES, type PortProxyFamily } from '../PortProxyRule';
import type { SystemIdentity } from '@/network/devices/host/identity/SystemIdentity';
import type { HardwareProfile } from '@/network/devices/host/hardware/HardwareProfile';
import { WindowsFileSystem } from '../WindowsFileSystem';
import type { WindowsProcessManager, WindowsProcess } from '../WindowsProcessManager';
import type { WindowsUserManager } from '../WindowsUserManager';
import type { WindowsServiceManager } from '../WindowsServiceManager';
import type { DoskeyTable } from '../cli/DoskeyTable';
import type { DomainSession } from '../domain/DomainTypes';
import type { DirectoryStore } from '../server/ad/DirectoryStore';
import type { SmbShareTable } from '../server/smb/SmbShareTable';
import type { SmbSessionTable } from '../server/smb/SmbSessionTable';
import type { SmbDialResult } from '../server/smb/SmbClient';
import type { NetUseEntry } from '../WinNetUse';
import type { WindowsAccountsPolicy } from '../security/WindowsAccountsPolicy';
import type { WinScheduledTask } from '../WinSystemCommands';
import { runScheduledProgram } from '../WinSystemCommands';
import type { WinRegistryProvider } from '../WinRegCommand';
import type { WindowsAuditPolicy } from '../WindowsAuditPolicy';
import type { WindowsWinRmConfig } from '../WindowsWinRmConfig';
import type { WindowsDnsCache } from '../WinDnsCache';
import { numericIdFromSid, resolveWindowsUser } from './WindowsUser';

export interface WindowsMachineApiDeps {
  readonly fs: WindowsFileSystem;
  readonly userManager: WindowsUserManager;
  readonly processManager: WindowsProcessManager;
  readonly hostname: string;
  readonly ports: readonly Port[];
  readonly identity: SystemIdentity;
  readonly hardware: HardwareProfile;
  readonly socketTable: import('@/network/core/SocketTable').SocketTable;
  readonly serviceManager: WindowsServiceManager;
  getDomainSession(): DomainSession | null;
  readonly doskey: DoskeyTable;
  getDirectoryStore(): DirectoryStore | null;
  readonly smbShares: SmbShareTable;
  readonly smbSessions: SmbSessionTable;
  readonly netUseTable: Map<string, NetUseEntry>;
  readonly accountsPolicy: WindowsAccountsPolicy;
  resolveHostname(name: string): Promise<IPAddress | null>;
  dialSmbShare(targetIp: string, shareName: string, username: string, password: string): SmbDialResult;
  readonly scheduledTasks: Map<string, WinScheduledTask>;
  readonly registry: WinRegistryProvider;
  readonly auditPolicy: WindowsAuditPolicy;
  readonly winrm: WindowsWinRmConfig;
  /** Table ARP — référence live, jamais réassignée (mutée via `.set`/`.delete`/`.clear`), comme `smbShares`/`smbSessions`. */
  readonly arpTable: Map<string, ARPEntry>;
  /** Table de routage déjà résolue (connectées + statiques + défaut) — méthode, pas un champ : `routingTable` est réassigné en interne à chaque mutation. */
  getRoutingTable(): HostRouteEntry[];
  addStaticRoute(network: IPAddress, mask: SubnetMask, nextHop: IPAddress, metric: number): boolean;
  removeRoute(network: IPAddress, mask: SubnetMask): boolean;
  setDefaultGateway(gw: IPAddress): void;
  clearDefaultGateway(): void;
  addStaticARP(ip: IPAddress, mac: MACAddress, iface: string): void;
  deleteARP(ip: IPAddress): boolean;
  clearARPTable(): void;
  executePingSequence(target: IPAddress, count: number, timeoutMs?: number, ttl?: number): Promise<PingResult[]>;
  executeTraceroute(target: IPAddress, maxHops?: number, timeoutMs?: number): Promise<TracerouteHop[]>;
  reverseLookup(ip: string): string | null;
  resolveViaHostsFile(name: string): string | null;
  firstConfiguredDnsServer(): string;
  queryDnsServer(server: IPAddress, name: string, qtype: string, timeoutMs?: number): Promise<DnsMessage | null>;
  isDHCPConfigured(ifName: string): boolean;
  getConnectionDnsSuffix(ifName: string): string;
  getDefaultGateway6(): IPv6Address | null;
  effectiveDnsServers(ifName: string): string[];
  /** Méthode, pas un champ : le suffixe DNS principal est réassigné en interne (`netsh`/`Set-DnsClientGlobalSetting`), un snapshot figé au premier appel de `getCommandKernelShell()` deviendrait obsolète. */
  getDnsSuffix(): string;
  getClassId(ifName: string): string | null;
  setClassId(ifName: string, classId: string | null): void;
  getClassId6(ifName: string): string | null;
  setClassId6(ifName: string, classId: string | null): void;
  sendRouterSolicitation(ifName: string): void;
  autoDiscoverDHCPServers(): void;
  getDhcpLease(ifName: string): { ipAddress: string; serverIdentifier: string; leaseStart: number; expiration: number; dnsServers: string[] } | null;
  /** Libère le bail (le cas échéant) et réinitialise l'état du client DHCP à `INIT` — appelé pour CHAQUE interface ciblée, avec ou sans bail actif (comportement `ipconfig /release` réel). */
  releaseDhcpLease(ifName: string): void;
  /** Redemande un bail ; l'appelant relit `getDhcpLease` ensuite pour déterminer le résultat (auto-configuration `0.0.0.0`, bail obtenu, ou échec). */
  requestDhcpLease(ifName: string): void;
  releaseDynamicIPv6(ifName: string): string[];
  readonly dnsCache: WindowsDnsCache;
  /** Interfaces réseau vues LIVE depuis la table de ports (nom = clé de la map, pas `port.getName()` — le renommage `netsh` re-clé la map sans muter le port). */
  netInterfaces(): readonly { name: string; port: Port }[];
  /** Résout un nom d'interface façon `netsh` (nom réel, nom d'affichage, "Local Area Connection"...) — retourne `name` inchangé si aucune interface ne correspond, à charge pour l'appelant de vérifier l'existence. */
  resolveAdapterName(name: string): string;
  configureInterface(ifName: string, ip: IPAddress, mask: SubnetMask): boolean;
  setAddressDhcp(ifName: string): void;
  clearInterfaceIP(ifName: string): void;
  setDnsServers(ifName: string, servers: readonly string[]): void;
  getDnsMode(ifName: string): 'static' | 'dhcp';
  setDnsMode(ifName: string, mode: 'static' | 'dhcp'): void;
  getInterfaceAdmin(ifName: string): boolean;
  setInterfaceAdmin(ifName: string, enabled: boolean): void;
  renameInterface(oldName: string, newName: string): boolean;
  resetTcpIpStack(): void;
  resetWinsockCatalog(): void;
  addIPv6Route(entry: { prefix: string; prefixLen: number; iface: string; nexthop: string; metric: number; published: boolean }): void;
  getIPv6Routes(): { prefix: string; prefixLen: number; iface: string; nexthop: string; metric: number; published: boolean }[];
  readonly portProxy: import('../PortProxyTable').PortProxyTable;
  getWinhttpProxy(): string;
  setWinhttpProxy(proxy: string): void;
  setPrimaryDnsSuffix(suffix: string): void;
  isServiceRunning(name: string): boolean;
  readonly dhcpClientNetsh: { installed: boolean; tracingEnabled: boolean; tracingOutput: string; traceEnabled: boolean; releasedIfaces: Set<string> };
  readonly ipsecNetsh: WinIpsecMutableState;
  readonly netshFeatures: WinNetshFeatureState;
  readonly dynamicFirewallRules: FirewallRuleMap;
  getDhcpServerRole(): DhcpServerRoleLike | null;
  getNpsRole(): NpsRoleLike | null;
  getDnsServerRole(): DnsServerRoleLike | null;
  eventLogEntries(logName: string): readonly WindowsEventLogEntry[] | null;
  dhcpEventLog(): readonly string[];
  syncDhcpEvents(): void;
  addDhcpEvent(type: string, message: string): void;
  gpupdateForce(): { ok: boolean; message: string };
  groupPolicyResult(): WindowsGpResult | null;
  runasGetUser(name: string): { readonly name: string; readonly enabled: boolean } | undefined;
  runasCurrentUser(): string;
  runasCommandAs(userName: string, command: string): Promise<string>;
  licensingInstallProductKey(key: string): { ok: boolean; message: string };
  licensingActivate(): { ok: boolean; message: string };
  licensingProductKey(): string | null;
  licensingState(): string;
  lprSubmitJob(server: string, queue: string, jobName: string, content: Uint8Array): { ok: boolean; error?: string };
  locateDomainController(domain: string): DomainControllerLocation;
  dcDiagnostics(): DomainControllerDiagnostics;
  kerberosTickets(): readonly KerberosCachedTicket[];
  joinDomain(domain: string, dcAddress: string, user: string, password: string): { ok: boolean; message: string };
  resolveDcAddress(domain: string): string | null;
  establishTrust(remoteRealm: string, dcAddress: string, direction: DomainTrustDirection, transitive: boolean, user: string, password: string): { ok: boolean; message: string } | null;
  bootedAt(): Date | null;
  now(): Date;
  powerOn(): void;
  powerOff(): void;
}

const FILE_NODE_TYPE: Record<'file' | 'directory', FileNodeType> = {
  file: 'file',
  directory: 'directory',
};

/**
 * NTFS has no POSIX mode bits or numeric ownership — command-kernel's
 * `FileSystemApi` contract requires them regardless, so every stat carries a
 * fixed placeholder. No migrated `cmd` command reads `mode`/`ownerUid`/
 * `ownerGid` (real ownership/permissions go through `getAcl`/`grantAcl`),
 * so this is inert plumbing, not user-visible fiction.
 */
const PLACEHOLDER_MODE = 0o666;

const ATTR_MAP: Record<keyof FileAttributes, string> = {
  readOnly: 'readonly',
  archive: 'archive',
  hidden: 'hidden',
  system: 'system',
};

class WindowsFileSystemApi implements FileSystemApi {
  constructor(private readonly winfs: WindowsFileSystem) {}

  private toStat(path: string, entry: { type: 'file' | 'directory'; size: number; mtime: Date }): FileStat {
    return {
      path,
      type: FILE_NODE_TYPE[entry.type],
      size: entry.size,
      ownerUid: 0,
      ownerGid: 0,
      mode: PLACEHOLDER_MODE,
      linkCount: 1,
      inode: 0,
      modifiedAt: entry.mtime,
    };
  }

  async readFile(path: string, _actor: FileSystemActor): Promise<string> {
    const result = this.winfs.readFile(path);
    if (!result.ok) throw new FileSystemError(path, 'ENOENT', result.error ?? `${path}: file not found`);
    return result.content ?? '';
  }

  async writeFile(path: string, content: string, _actor: FileSystemActor, append = false): Promise<void> {
    const result = append ? this.winfs.appendFile(path, content) : this.winfs.createFile(path, content);
    if (!result.ok) throw new FileSystemError(path, 'EACCES', result.error ?? `${path}: access denied`);
  }

  async touch(path: string, _actor: FileSystemActor): Promise<void> {
    if (this.winfs.exists(path)) return;
    const result = this.winfs.createFile(path, '');
    if (!result.ok) throw new FileSystemError(path, 'EACCES', result.error ?? `${path}: access denied`);
  }

  async list(path: string, _actor: FileSystemActor): Promise<FileStat[]> {
    if (!this.winfs.isDirectory(path)) {
      throw new FileSystemError(path, 'ENOTDIR', `${path}: not a directory`);
    }
    return this.winfs.listDirectory(path).map((e) =>
      this.toStat(`${path}\\${e.name}`, { type: e.entry.type, size: e.entry.size, mtime: e.entry.mtime }));
  }

  async stat(path: string, _actor: FileSystemActor): Promise<FileStat> {
    const entry = this.winfs.resolve(path);
    if (!entry) throw new FileSystemError(path, 'ENOENT', `${path}: file not found`);
    return this.toStat(path, entry);
  }

  async lstat(path: string, actor: FileSystemActor): Promise<FileStat> {
    return this.stat(path, actor);
  }

  async exists(path: string, _actor: FileSystemActor): Promise<boolean> {
    return this.winfs.exists(path);
  }

  async remove(path: string, _actor: FileSystemActor, recursive = false): Promise<void> {
    // `rmdir`/`rmdirRecursive` (not `deleteDirectory`, which skips the
    // "not empty"/"invalid directory name" checks) — matches exactly what
    // legacy `cmdRmdir` called.
    const result = this.winfs.isDirectory(path)
      ? (recursive ? this.winfs.rmdirRecursive(path) : this.winfs.rmdir(path))
      : this.winfs.deleteFile(path);
    if (!result.ok) throw new FileSystemError(path, 'EACCES', result.error ?? `${path}: access denied`);
  }

  async rmdir(path: string, _actor: FileSystemActor): Promise<void> {
    const result = this.winfs.rmdir(path);
    if (!result.ok) throw new FileSystemError(path, 'EACCES', result.error ?? `${path}: access denied`);
  }

  async mkdir(path: string, _actor: FileSystemActor, parents = false): Promise<void> {
    if (parents) {
      this.winfs.mkdirp(path);
      return;
    }
    const result = this.winfs.mkdir(path);
    if (!result.ok) throw new FileSystemError(path, 'EEXIST', result.error ?? `${path}: already exists`);
  }

  async chmod(): Promise<void> {
    // No POSIX permission bits on NTFS — real ACL mutation goes through
    // `getAcl`/`grantAcl` (backing `icacls`), not numeric mode bits.
  }

  async chown(): Promise<void> {
    // See chmod() above — ownership goes through ACL principals, not
    // numeric uid/gid. Not reachable by any migrated cmd command yet.
  }

  async copy(source: string, destination: string, _actor: FileSystemActor): Promise<void> {
    const result = this.winfs.copyFile(source, destination);
    if (!result.ok) throw new FileSystemError(destination, 'EACCES', result.error ?? `${destination}: access denied`);
  }

  async rename(source: string, destination: string, _actor: FileSystemActor): Promise<void> {
    const result = this.winfs.moveFile(source, destination);
    if (!result.ok) throw new FileSystemError(destination, 'EACCES', result.error ?? `${destination}: access denied`);
  }

  async symlink(): Promise<void> {
    throw new FileSystemError('', 'EACCES', 'symbolic links are not supported on this filesystem');
  }

  async link(): Promise<void> {
    throw new FileSystemError('', 'EACCES', 'hard links are not supported on this filesystem');
  }

  async readlink(path: string): Promise<string> {
    throw new FileSystemError(path, 'EACCES', 'symbolic links are not supported on this filesystem');
  }

  resolve(cwd: string, path: string): string {
    return this.winfs.normalizePath(path, cwd);
  }

  async volumeInfo(path: string): Promise<{ serial: string; freeBytes: number; totalBytes: number } | undefined> {
    const drive = /^[A-Za-z]:/.test(path) ? path[0].toUpperCase() : undefined;
    if (!drive) return undefined;
    return {
      serial: this.winfs.getVolumeSerialNumber(drive),
      freeBytes: this.winfs.getFreeDiskSpace(drive),
      totalBytes: this.winfs.getDriveCapacity(drive),
    };
  }

  async listDrives(): Promise<string[]> {
    return this.winfs.listDrives();
  }

  async getAcl(path: string): Promise<readonly AclEntry[]> {
    return this.winfs.getACL(path).map((ace) => ({ principal: ace.principal, type: ace.type, permissions: ace.permissions }));
  }

  async grantAcl(path: string, entry: AclEntry): Promise<void> {
    this.winfs.addACE(path, { principal: entry.principal, type: entry.type, permissions: [...entry.permissions] });
  }

  async removeAcl(path: string, principal: string): Promise<void> {
    this.winfs.removeACEs(path, principal);
  }

  async getAttributes(path: string): Promise<FileAttributes> {
    const entry = this.winfs.resolve(path);
    const attrs = entry?.attributes ?? new Set<string>();
    return {
      readOnly: attrs.has('readonly'),
      archive: attrs.has('archive'),
      hidden: attrs.has('hidden'),
      system: attrs.has('system'),
    };
  }

  async setAttributes(path: string, changes: Partial<FileAttributes>): Promise<void> {
    const entry = this.winfs.resolve(path);
    if (!entry) throw new FileSystemError(path, 'ENOENT', `${path}: file not found`);
    for (const key of Object.keys(changes) as (keyof FileAttributes)[]) {
      const value = changes[key];
      if (value === undefined) continue;
      if (value) entry.attributes.add(ATTR_MAP[key]);
      else entry.attributes.delete(ATTR_MAP[key]);
    }
  }
}

function toProcessInfo(p: WindowsProcess, ownerName: string): CkProcessInfo {
  return {
    pid: p.pid,
    command: p.name,
    ownerUid: 0,
    ownerName,
    sessionName: p.session,
    sessionNumber: p.sessionId,
    memoryKib: p.wsK,
    cpuSeconds: p.cpuSec,
    status: p.status,
    windowTitle: p.windowTitle || undefined,
    hostedServices: p.hostedServices,
    critical: p.critical,
    systemOwned: p.systemOwned,
  };
}

class WindowsProcessApi implements ProcessApi {
  constructor(
    private readonly processManager: WindowsProcessManager,
    private readonly hostname: string,
    private readonly currentUser: () => string,
  ) {}

  private resolveOwner(p: WindowsProcess): string {
    const raw = this.processManager.resolveOwner(p, this.currentUser());
    return raw.includes('\\') ? raw : `${this.hostname}\\${raw}`;
  }

  async list(): Promise<CkProcessInfo[]> {
    return this.processManager.getAllProcesses().map((p) => toProcessInfo(p, this.resolveOwner(p)));
  }

  async descendants(pid: number): Promise<readonly CkProcessInfo[]> {
    return this.processManager.getDescendants(pid).map((p) => toProcessInfo(p, this.resolveOwner(p)));
  }

  async kill(pid: number): Promise<void> {
    const err = this.processManager.killProcess(pid, true, true);
    if (err) throw new Error(err);
  }

  async spawn(command: string, argv: readonly string[]): Promise<CkProcessInfo> {
    const proc = this.processManager.spawnProcess([command, ...argv].join(' '), 0, 'SYSTEM');
    return toProcessInfo(proc, this.resolveOwner(proc));
  }
}

class WindowsNetworkApi implements NetworkApi {
  constructor(
    private readonly ports: () => readonly Port[],
    private readonly isDHCPConfigured: (ifName: string) => boolean,
    private readonly socketTable: import('@/network/core/SocketTable').SocketTable,
  ) {}

  async interfaces(): Promise<{ name: string; ip: string; up: boolean; dhcp?: boolean }[]> {
    return this.ports().map((port) => ({
      name: port.getName(),
      ip: port.getIPAddress()?.toString() ?? '',
      up: !port.isAdminDown(),
      dhcp: this.isDHCPConfigured(port.getName()),
    }));
  }

  async setInterfaceState(name: string, up: boolean): Promise<void> {
    const port = this.ports().find((p) => p.getName() === name);
    if (!port) throw new Error(`interface introuvable : ${name}`);
    port.setAdminDown(!up);
  }

  async connections(): Promise<readonly SocketInfo[]> {
    return this.socketTable.getAll().map((sock) => ({
      protocol: sock.protocol,
      localAddress: sock.localAddress,
      localPort: sock.localPort,
      remoteAddress: sock.remoteAddress,
      remotePort: sock.remotePort,
      state: sock.state,
      pid: sock.pid,
    }));
  }
}

const WELL_KNOWN_GROUPS: readonly { displayName: string; type: string; sid: string; attributes: string }[] = [
  { displayName: 'Everyone', type: 'Well-known', sid: 'S-1-1-0', attributes: 'Mandatory group, Enabled by default' },
  { displayName: 'NT AUTHORITY\\Local account', type: 'Well-known', sid: 'S-1-5-113', attributes: 'Mandatory group, Enabled by default' },
];

function domainSid(netbiosName: string): string {
  let hash = 0;
  for (const ch of netbiosName.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `S-1-5-21-${1000000 + (hash % 8999999)}-500`;
}

class WindowsUserManagementApi implements UserManagementApi {
  constructor(
    private readonly userManager: WindowsUserManager,
    private readonly hostname: string,
    private readonly domainSession: () => DomainSession | null,
    private readonly getDirectoryStore: () => DirectoryStore | null,
  ) {}

  async findByName(name: string): Promise<User | undefined> {
    try {
      return resolveWindowsUser(this.userManager, name);
    } catch {
      return undefined;
    }
  }

  async findByUid(uid: number): Promise<User | undefined> {
    for (const account of this.userManager.getAllUsers()) {
      if (numericIdFromSid(account.sid) === uid) return this.findByName(account.name);
    }
    return undefined;
  }

  async create(): Promise<User> {
    throw new Error('création de compte Windows non prise en charge par ce pont');
  }

  async delete(): Promise<void> {
    throw new Error('suppression de compte Windows non prise en charge par ce pont');
  }

  async securityIdentity(name: string): Promise<SecurityIdentity | undefined> {
    if (!this.userManager.getUser(name)) return undefined;
    const session = this.domainSession();
    const domain = session && session.sam.toLowerCase() === name.toLowerCase() ? session : null;

    const sid = domain ? domainSid(domain.netbiosName) : (this.userManager.getUserSID(name) ?? 'S-1-5-21-0-0-0-0');
    const accountName = domain
      ? `${domain.netbiosName.toLowerCase()}\\${name.toLowerCase()}`
      : `${this.hostname.toLowerCase()}\\${name}`;

    const groups = domain
      ? domain.groups.map((g) => ({
          displayName: `${domain.netbiosName}\\${g}`,
          type: 'Group',
          sid: domainSid(domain.netbiosName),
          attributes: 'Mandatory group, Enabled by default',
        }))
      : this.userManager.getGroupsForUser(name).map((g) => ({
          displayName: `BUILTIN\\${g.name}`,
          type: 'Alias',
          sid: g.sid,
          attributes: 'Mandatory group, Enabled by default',
        }));

    const privileges = this.userManager.getPrivileges(name).map(([privName, description, state]) => ({ name: privName, description, state }));

    return {
      accountName,
      sid,
      groups: domain ? groups : [...WELL_KNOWN_GROUPS, ...groups],
      privileges,
    };
  }

  listAccountNames(): readonly string[] {
    return this.userManager.getAllUsers().map((u) => u.name);
  }

  getAccountDetail(name: string): AccountDetail | undefined {
    const user = this.userManager.getUser(name);
    if (!user) return undefined;
    return {
      name: user.name,
      fullName: user.fullName,
      description: user.description,
      enabled: user.enabled,
      passwordLastSet: user.passwordLastSet,
      passwordRequired: user.passwordRequired,
      userMayChangePassword: user.userMayChangePassword,
      lastLogon: user.lastLogon,
      localGroups: this.userManager.getGroupsForUser(user.name).map((g) => g.name),
    };
  }

  createAccount(name: string, password: string): AccountMutationResult {
    const err = this.userManager.createUser(name, password);
    return err ? { ok: false, error: err } : { ok: true };
  }

  deleteAccount(name: string): AccountMutationResult {
    const err = this.userManager.deleteUser(name);
    return err ? { ok: false, error: err } : { ok: true };
  }

  setAccountProperty(name: string, property: 'active' | 'fullname' | 'comment' | 'password', value: string): AccountMutationResult {
    const err = this.userManager.setUserProperty(name, property, value);
    return err ? { ok: false, error: err } : { ok: true };
  }

  callerIsAdmin(): boolean {
    return this.userManager.isCurrentUserAdmin();
  }

  domainAccountNames(): readonly string[] | undefined {
    const store = this.getDirectoryStore();
    return store ? store.listUsers().map((u) => u.sam) : undefined;
  }

  getDomainAccountDetail(sam: string) {
    const store = this.getDirectoryStore();
    const user = store?.getUser(sam);
    if (!store || !user) return undefined;
    return {
      sam: user.sam,
      fullName: user.fullName,
      enabled: user.enabled,
      globalGroups: store.groupsForUser(user.sam).map((g) => g.sam),
    };
  }
}

class WindowsGroupManagementApi implements GroupManagementApi {
  constructor(private readonly userManager: WindowsUserManager) {}

  async findByGid(gid: number): Promise<GroupInfo | undefined> {
    const group = this.userManager.getAllGroups().find((g) => numericIdFromSid(g.sid) === gid);
    return group ? { gid: numericIdFromSid(group.sid), name: group.name } : undefined;
  }

  async findByName(name: string): Promise<GroupInfo | undefined> {
    const group = this.userManager.getGroup(name);
    return group ? { gid: numericIdFromSid(group.sid), name: group.name } : undefined;
  }

  listGroupNames(): readonly string[] {
    return this.userManager.getAllGroups().map((g) => g.name);
  }

  getGroupDetail(name: string): GroupDetail | undefined {
    const group = this.userManager.getGroup(name);
    if (!group) return undefined;
    return { name: group.name, description: group.description, members: this.userManager.getGroupMembers(name).members };
  }

  createGroup(name: string, description: string): AccountMutationResult {
    const err = this.userManager.createGroup(name, description);
    return err ? { ok: false, error: err } : { ok: true };
  }

  deleteGroup(name: string): AccountMutationResult {
    const err = this.userManager.deleteGroup(name);
    return err ? { ok: false, error: err } : { ok: true };
  }

  addGroupMember(groupName: string, memberName: string): AccountMutationResult {
    const err = this.userManager.addGroupMember(groupName, memberName);
    return err ? { ok: false, error: err } : { ok: true };
  }

  removeGroupMember(groupName: string, memberName: string): AccountMutationResult {
    const err = this.userManager.removeGroupMember(groupName, memberName);
    return err ? { ok: false, error: err } : { ok: true };
  }
}

class WindowsServiceManagementApi implements ServiceManagementApi {
  constructor(
    private readonly serviceManager: WindowsServiceManager,
    private readonly processManager: WindowsProcessManager,
  ) {}

  exists(name: string): boolean {
    return this.serviceManager.getService(name) !== undefined;
  }

  displayNameFor(name: string): string | undefined {
    return this.serviceManager.getService(name)?.displayName;
  }

  resolveName(nameOrDisplayName: string): string | undefined {
    const exact = this.serviceManager.getService(nameOrDisplayName);
    if (exact) return exact.name;
    const byDisplay = this.serviceManager.getAllServices().find((s) => s.displayName.toLowerCase() === nameOrDisplayName.toLowerCase());
    return byDisplay?.name;
  }

  isRunning(name: string): boolean {
    return this.serviceManager.getService(name)?.state === 'Running';
  }

  runningServiceNames(): readonly string[] {
    return this.serviceManager.getRunningServices().map((s) => s.name);
  }

  allServiceNames(): readonly string[] {
    return this.serviceManager.getAllServices().map((s) => s.name);
  }

  pidFor(name: string): number {
    return this.processManager.getPidForService(name);
  }

  formatQuery(name: string): string | undefined {
    const svc = this.serviceManager.getService(name);
    return svc && this.serviceManager.formatScQuery(svc);
  }

  formatQueryAllRunning(): readonly string[] {
    return this.serviceManager.getRunningServices().map((s) => this.serviceManager.formatScQuery(s));
  }

  formatQueryAll(): readonly string[] {
    return this.serviceManager.getAllServices().map((s) => this.serviceManager.formatScQuery(s));
  }

  formatQueryEx(name: string): string | undefined {
    const svc = this.serviceManager.getService(name);
    return svc && this.serviceManager.formatScQueryEx(svc, this.pidFor(svc.name));
  }

  formatQueryExAllRunning(): readonly string[] {
    return this.serviceManager.getRunningServices().map((s) => this.serviceManager.formatScQueryEx(s, this.pidFor(s.name)));
  }

  formatQueryExAll(): readonly string[] {
    return this.serviceManager.getAllServices().map((s) => this.serviceManager.formatScQueryEx(s, this.pidFor(s.name)));
  }

  formatQc(name: string): string | undefined {
    const svc = this.serviceManager.getService(name);
    return svc && this.serviceManager.formatScQc(svc);
  }

  formatDescription(name: string): string | undefined {
    const svc = this.serviceManager.getService(name);
    return svc && this.serviceManager.formatScDescription(svc);
  }

  formatQfailure(name: string): string | undefined {
    const svc = this.serviceManager.getService(name);
    return svc && this.serviceManager.formatScQfailure(svc);
  }

  start(name: string, isAdmin: boolean): ServiceControlResult {
    const err = this.serviceManager.startService(name, isAdmin);
    if (err) return { ok: false, error: err };
    const svc = this.serviceManager.getService(name);
    if (!svc) return { ok: true, formattedStatus: '' };
    this.processManager.onServiceStarted(svc.name, svc.processName);
    const saved = svc.state;
    svc.state = 'StartPending';
    const formattedStatus = this.serviceManager.formatServiceStatus(svc, { waitHint: 0x7d0 });
    svc.state = saved;
    return { ok: true, formattedStatus };
  }

  stop(name: string, isAdmin: boolean): ServiceControlResult {
    const svc = this.serviceManager.getService(name);
    const err = this.serviceManager.stopService(name, isAdmin);
    if (err) return { ok: false, error: err };
    if (!svc) return { ok: true, formattedStatus: '' };
    this.processManager.onServiceStopped(svc.name);
    const saved = svc.state;
    svc.state = 'StopPending';
    const formattedStatus = this.serviceManager.formatServiceStatus(svc);
    svc.state = saved;
    return { ok: true, formattedStatus };
  }

  pause(name: string, isAdmin: boolean): ServiceControlResult {
    const err = this.serviceManager.pauseService(name, isAdmin);
    if (err) return { ok: false, error: err };
    const svc = this.serviceManager.getService(name)!;
    const saved = svc.state;
    svc.state = 'PausePending';
    const formattedStatus = this.serviceManager.formatServiceStatus(svc);
    svc.state = saved;
    return { ok: true, formattedStatus };
  }

  resume(name: string, isAdmin: boolean): ServiceControlResult {
    const err = this.serviceManager.resumeService(name, isAdmin);
    if (err) return { ok: false, error: err };
    const svc = this.serviceManager.getService(name)!;
    const saved = svc.state;
    svc.state = 'ContinuePending';
    const formattedStatus = this.serviceManager.formatServiceStatus(svc);
    svc.state = saved;
    return { ok: true, formattedStatus };
  }

  setStartType(name: string, startType: 'Automatic' | 'Manual' | 'Disabled', isAdmin: boolean): ServiceOpResult {
    const err = this.serviceManager.setStartType(name, startType, isAdmin);
    return err ? { ok: false, error: err } : { ok: true };
  }

  setDependencies(name: string, dependencies: readonly string[], isAdmin: boolean): ServiceOpResult {
    const err = this.serviceManager.setDependencies(name, [...dependencies], isAdmin);
    return err ? { ok: false, error: err } : { ok: true };
  }

  setAccount(name: string, account: string, isAdmin: boolean, changedBy: string): ServiceOpResult {
    const err = this.serviceManager.setAccount(name, account, isAdmin, changedBy);
    return err ? { ok: false, error: err } : { ok: true };
  }

  setDescription(name: string, description: string, isAdmin: boolean): ServiceOpResult {
    const err = this.serviceManager.setDescription(name, description, isAdmin);
    return err ? { ok: false, error: err } : { ok: true };
  }

  setFailureConfig(name: string, config: ServiceFailureConfig, isAdmin: boolean): ServiceOpResult {
    const err = this.serviceManager.setFailureConfig(name, { resetPeriodSec: config.resetPeriodSec, actions: config.actions.map((a) => ({ ...a })), command: config.command }, isAdmin);
    return err ? { ok: false, error: err } : { ok: true };
  }

  create(
    name: string,
    opts: { binaryPath: string; displayName?: string; startType?: 'Automatic' | 'Manual' | 'Disabled'; dependencies?: readonly string[] },
    isAdmin: boolean,
    installedBy: string,
  ): ServiceOpResult {
    const err = this.serviceManager.createService(name, {
      binaryPath: opts.binaryPath,
      displayName: opts.displayName,
      startType: opts.startType,
      dependencies: opts.dependencies ? [...opts.dependencies] : undefined,
    }, isAdmin, installedBy);
    return err ? { ok: false, error: err } : { ok: true };
  }

  delete(name: string, isAdmin: boolean): ServiceOpResult {
    const err = this.serviceManager.deleteService(name, isAdmin);
    return err ? { ok: false, error: err } : { ok: true };
  }
}

class WindowsSmbShareApi implements SmbShareApi {
  constructor(private readonly deps: Pick<WindowsMachineApiDeps, 'serviceManager' | 'smbShares'>) {}

  isServerRunning(): boolean {
    return this.deps.serviceManager.getService('LanmanServer')?.state === 'Running';
  }

  list(): readonly SmbShareInfo[] {
    return this.deps.smbShares.list().map((s) => ({ name: s.name, path: s.path, description: s.description }));
  }

  add(name: string, resource: string, description: string): AccountMutationResult {
    // Classic net.exe defaults an ad-hoc share to Everyone:Full (unlike the
    // modern New-SmbShare cmdlet, which defaults to Everyone:Read).
    const result = this.deps.smbShares.add(name, resource, { description, permissions: new Map([['Everyone', 'Full']]) });
    return result.ok ? { ok: true } : { ok: false, error: result.message };
  }

  remove(name: string): AccountMutationResult {
    const result = this.deps.smbShares.remove(name);
    return result.ok ? { ok: true } : { ok: false, error: result.message };
  }
}

class WindowsSmbSessionApi implements SmbSessionApi {
  constructor(private readonly smbSessions: SmbSessionTable) {}

  list(): readonly SmbSessionInfo[] {
    return this.smbSessions.list().map((s) => ({ clientComputerName: s.clientComputerName, clientIp: s.clientIp, user: s.user, numOpens: s.numOpens }));
  }

  closeMatching(target?: string): void {
    for (const s of this.smbSessions.list()) {
      if (!target || s.clientIp === target || s.clientComputerName === target) {
        this.smbSessions.close(s.id);
      }
    }
  }
}

class WindowsNetUseApi implements NetUseApi {
  constructor(
    private readonly deps: Pick<WindowsMachineApiDeps, 'serviceManager' | 'netUseTable' | 'resolveHostname' | 'dialSmbShare'>,
  ) {}

  isWorkstationRunning(): boolean {
    return this.deps.serviceManager.getService('LanmanWorkstation')?.state === 'Running';
  }

  list(): readonly NetUseMappingInfo[] {
    return Array.from(this.deps.netUseTable.values()).map((e) => ({ local: e.local, remote: e.remote, status: e.status }));
  }

  async connect(drive: string, uncPath: string, username: string, password: string): Promise<AccountMutationResult> {
    const m = /^\\\\([^\\]+)\\([^\\]+)/.exec(uncPath);
    if (!m) return { ok: false, error: 'The network path was not found.' };
    const [, server, share] = m;
    const targetIp = await this.deps.resolveHostname(server);
    if (!targetIp) return { ok: false, error: 'System error 53 has occurred.\n\nThe network path was not found.' };
    const dial = this.deps.dialSmbShare(targetIp.toString(), share, username, password);
    if (!dial.ok) return { ok: false, error: dial.error ?? 'System error 53 has occurred.\n\nThe network path was not found.' };
    this.deps.netUseTable.set(drive.toUpperCase(), {
      local: drive.toUpperCase(), remote: uncPath, status: 'OK', user: username, persistent: false, connection: dial.connection,
    });
    return { ok: true };
  }

  disconnect(drive: string): boolean {
    const key = drive.toUpperCase();
    const existing = this.deps.netUseTable.get(key);
    if (!existing) return false;
    existing.connection?.disconnect();
    this.deps.netUseTable.delete(key);
    return true;
  }

  disconnectAll(): number {
    const n = this.deps.netUseTable.size;
    for (const e of this.deps.netUseTable.values()) e.connection?.disconnect();
    this.deps.netUseTable.clear();
    return n;
  }
}

class WindowsAccountsPolicyApi implements AccountsPolicyApi {
  constructor(private readonly policy: WindowsAccountsPolicy) {}

  render(): string {
    return this.policy.render();
  }

  apply(flag: string, value: string): string | undefined {
    const err = this.policy.apply(flag, value);
    return err || undefined;
  }
}

function parseSchtasksTime(st: string, base: Date): Date {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(st);
  if (!m) return new Date(base);
  const d = new Date(base);
  d.setHours(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 0, 0);
  if (d.getTime() <= base.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

class WindowsSchedulingApi implements SchedulingApi {
  constructor(
    private readonly deps: Pick<WindowsMachineApiDeps, 'serviceManager' | 'processManager' | 'scheduledTasks' | 'now'>,
  ) {}

  isServiceRunning(): boolean {
    return this.deps.serviceManager.getService('Schedule')?.state === 'Running';
  }

  list(nameFilter?: string): readonly ScheduledTaskInfo[] {
    const tasks = Array.from(this.deps.scheduledTasks.values());
    const filtered = nameFilter ? tasks.filter((t) => t.taskName.toLowerCase() === nameFilter.toLowerCase()) : tasks;
    return filtered.map((t) => ({ name: t.taskName, runAt: t.runAt ?? null, state: t.state }));
  }

  create(name: string, opts: { schedule?: string; startTime?: string; intervalCount?: number; command?: string }): void {
    const base = this.deps.now();
    const task: WinScheduledTask = { taskName: name, taskPath: '\\', state: 'Ready', command: opts.command };
    const sc = opts.schedule?.toUpperCase();
    const recurUnit = sc === 'MINUTE' ? 60_000 : sc === 'HOURLY' ? 3_600_000 : sc === 'DAILY' ? 86_400_000 : 0;
    if (recurUnit > 0) {
      task.intervalMs = (opts.intervalCount ?? 1) * recurUnit;
      task.runAt = opts.startTime ? parseSchtasksTime(opts.startTime, base) : new Date(base.getTime() + task.intervalMs);
    } else if (opts.startTime && (!sc || sc === 'ONCE')) {
      task.runAt = parseSchtasksTime(opts.startTime, base);
    }
    this.deps.scheduledTasks.set(name.toLowerCase(), task);
  }

  delete(name: string): boolean {
    return this.deps.scheduledTasks.delete(name.toLowerCase());
  }

  run(name: string): boolean {
    const task = this.deps.scheduledTasks.get(name.toLowerCase());
    if (!task) return false;
    runScheduledProgram(task, this.deps.processManager, this.deps.now());
    return true;
  }
}

class WindowsPrintApi implements PrintApi {
  private readonly queue: { document: string; owner: string; printer: string }[] = [];

  constructor(private readonly deps: Pick<WindowsMachineApiDeps, 'serviceManager'>) {}

  isSpoolerRunning(): boolean {
    return this.deps.serviceManager.getService('Spooler')?.state === 'Running';
  }

  submit(document: string, printer: string, owner: string): void {
    this.queue.push({ document, printer, owner });
  }
}

class WindowsAuditPolicyApi implements AuditPolicyApi {
  constructor(private readonly policy: WindowsAuditPolicy) {}

  get(subcategory: string) {
    return this.policy.get(subcategory);
  }

  set(subcategory: string, changes: { success?: boolean; failure?: boolean }): void {
    this.policy.set(subcategory, changes);
  }
}

class WindowsWinRmApi implements WinRmApi {
  constructor(private readonly config: WindowsWinRmConfig) {}

  isEnabled(): boolean {
    return this.config.enabled;
  }

  listeners(): readonly WinRmListenerInfo[] {
    return this.config.listeners.map((l) => ({ transport: l.transport, port: l.port }));
  }

  enable(): void {
    this.config.enable();
  }
}

/** Forme mutable du magasin IPsec `netsh`, détenue par `WindowsPC` (par-instance). */
export interface WinIpsecMutableState {
  policies: { name: string; description: string; assigned: boolean }[];
  filterLists: { name: string; filters: WindowsIpsecFilter[] }[];
  filterActions: { name: string; action: 'permit' | 'block' | 'negotiate'; description: string }[];
  rules: { name: string; policy: string; filterlist: string; filteraction: string }[];
  dynamic: { mmSecMethods: string; qmSecMethods: string; ikeLogging: number; config: Record<string, string> };
}

class WindowsIpsecStoreImpl implements WindowsIpsecStore {
  constructor(private readonly s: WinIpsecMutableState) {}

  policies(): readonly WindowsIpsecPolicy[] { return this.s.policies; }
  addPolicy(policy: WindowsIpsecPolicy): void { this.s.policies.push({ ...policy }); }
  deletePolicy(name: string): boolean {
    const i = this.s.policies.findIndex((p) => p.name === name);
    if (i < 0) return false;
    this.s.policies.splice(i, 1);
    return true;
  }
  deleteAllPolicies(): void { this.s.policies.length = 0; }
  setPolicy(name: string, changes: { assigned?: boolean; description?: string }): boolean {
    const p = this.s.policies.find((x) => x.name === name);
    if (!p) return false;
    if (changes.assigned !== undefined) p.assigned = changes.assigned;
    if (changes.description !== undefined) p.description = changes.description;
    return true;
  }

  filterLists(): readonly WindowsIpsecFilterList[] { return this.s.filterLists; }
  addFilterList(name: string): void { this.s.filterLists.push({ name, filters: [] }); }
  deleteFilterList(name: string): boolean {
    const i = this.s.filterLists.findIndex((f) => f.name === name);
    if (i < 0) return false;
    this.s.filterLists.splice(i, 1);
    return true;
  }
  deleteAllFilterLists(): void { this.s.filterLists.length = 0; }
  addFilter(filterListName: string, filter: WindowsIpsecFilter): boolean {
    const fl = this.s.filterLists.find((f) => f.name === filterListName);
    if (!fl) return false;
    fl.filters.push({ ...filter });
    return true;
  }
  filterListInUse(name: string): boolean { return this.s.rules.some((r) => r.filterlist === name); }

  filterActions(): readonly WindowsIpsecFilterAction[] { return this.s.filterActions; }
  addFilterAction(action: WindowsIpsecFilterAction): void { this.s.filterActions.push({ ...action }); }
  deleteFilterAction(name: string): boolean {
    const i = this.s.filterActions.findIndex((f) => f.name === name);
    if (i < 0) return false;
    this.s.filterActions.splice(i, 1);
    return true;
  }
  deleteAllFilterActions(): void { this.s.filterActions.length = 0; }

  rules(): readonly WindowsIpsecRule[] { return this.s.rules; }
  addRule(rule: WindowsIpsecRule): void { this.s.rules.push({ ...rule }); }
  deleteRule(name: string, policy?: string): boolean {
    const i = this.s.rules.findIndex((r) => r.name === name && (!policy || r.policy === policy));
    if (i < 0) return false;
    this.s.rules.splice(i, 1);
    return true;
  }

  dynamic(): WindowsIpsecDynamicSettings {
    return {
      mmSecMethods: this.s.dynamic.mmSecMethods,
      qmSecMethods: this.s.dynamic.qmSecMethods,
      ikeLogging: this.s.dynamic.ikeLogging,
      config: { ...this.s.dynamic.config },
    };
  }
  setDynamicMainMode(mmSecMethods: string): void { this.s.dynamic.mmSecMethods = mmSecMethods; }
  setDynamicQm(qmSecMethods: string): void { this.s.dynamic.qmSecMethods = qmSecMethods; }
  setDynamicConfig(key: string, value: string): void {
    if (key === 'ikelogging') this.s.dynamic.ikeLogging = parseInt(value, 10) || 0;
    else this.s.dynamic.config[key] = value;
  }
}

/** Formes mutables des magasins `netsh` de fonctionnalités, détenues par `WindowsPC` (par-instance). */
export interface WinNetshFeatureState {
  lan: { profiles: { name: string; interface: string }[]; tracingEnabled: boolean; autoconnect: Map<string, boolean> };
  wlan: { profiles: { name: string; ssid: string }[] };
  http: { ipListen: string[]; sslCerts: { ipport: string; certhash: string; appid: string }[] };
  bridge: { bridges: { name: string; members: string[] }[] };
  nrpt: { policies: { name: string; namespace: string; dnsservers: string }[] };
}

class WindowsLanStoreImpl implements WindowsLanStore {
  constructor(private readonly s: WinNetshFeatureState['lan']) {}
  profiles(): readonly WindowsLanProfile[] { return this.s.profiles; }
  addProfile(p: WindowsLanProfile): void { this.s.profiles.push({ name: p.name, interface: p.interface }); }
  deleteProfile(name: string): boolean {
    const i = this.s.profiles.findIndex((x) => x.name === name);
    if (i < 0) return false;
    this.s.profiles.splice(i, 1);
    return true;
  }
  deleteAllProfiles(): void { this.s.profiles.length = 0; }
  tracingEnabled(): boolean { return this.s.tracingEnabled; }
  setTracing(enabled: boolean): void { this.s.tracingEnabled = enabled; }
  autoconnect(ifName: string): boolean | undefined { return this.s.autoconnect.get(ifName); }
  setAutoconnect(ifName: string, enabled: boolean): void { this.s.autoconnect.set(ifName, enabled); }
}

class WindowsWlanStoreImpl implements WindowsWlanStore {
  constructor(private readonly s: WinNetshFeatureState['wlan']) {}
  profiles(): readonly WindowsWlanProfile[] { return this.s.profiles; }
  addProfile(p: WindowsWlanProfile): void { this.s.profiles.push({ name: p.name, ssid: p.ssid }); }
  deleteProfile(name: string): boolean {
    const i = this.s.profiles.findIndex((x) => x.name === name);
    if (i < 0) return false;
    this.s.profiles.splice(i, 1);
    return true;
  }
}

class WindowsHttpStoreImpl implements WindowsHttpStore {
  constructor(private readonly s: WinNetshFeatureState['http']) {}
  ipListen(): readonly string[] { return this.s.ipListen; }
  addIpListen(ip: string): void { this.s.ipListen.push(ip); }
  removeIpListen(ip: string): boolean {
    const i = this.s.ipListen.indexOf(ip);
    if (i < 0) return false;
    this.s.ipListen.splice(i, 1);
    return true;
  }
  sslCerts(): readonly WindowsHttpSslCert[] { return this.s.sslCerts; }
  addSslCert(cert: WindowsHttpSslCert): void { this.s.sslCerts.push({ ...cert }); }
}

class WindowsBridgeStoreImpl implements WindowsBridgeStore {
  constructor(private readonly s: WinNetshFeatureState['bridge']) {}
  bridges(): readonly WindowsBridge[] { return this.s.bridges; }
  create(name: string): boolean {
    if (this.s.bridges.find((b) => b.name === name)) return false;
    this.s.bridges.push({ name, members: [] });
    return true;
  }
  addMember(bridgeName: string, adapter: string): boolean {
    const b = this.s.bridges.find((x) => x.name === bridgeName);
    if (!b) return false;
    if (adapter && !b.members.includes(adapter)) b.members.push(adapter);
    return true;
  }
  delete(name: string): void {
    const i = this.s.bridges.findIndex((b) => b.name === name);
    if (i >= 0) this.s.bridges.splice(i, 1);
  }
}

class WindowsNrptStoreImpl implements WindowsNrptStore {
  constructor(private readonly s: WinNetshFeatureState['nrpt']) {}
  policies(): readonly WindowsNrptPolicy[] { return this.s.policies; }
  add(p: WindowsNrptPolicy): void { this.s.policies.push({ name: p.name, namespace: p.namespace, dnsservers: p.dnsservers }); }
}

/** Type de la valeur du magasin de règles pare-feu partagé (`WindowsPC.dynamicFirewallRules`). */
type FirewallRuleMap = Map<string, { name: string; displayName: string; enabled: boolean; action: string; direction: string; protocol: string; localPort: string; remotePort: string; description: string }>;

class WindowsFirewallApiImpl implements WindowsFirewallApi {
  constructor(private readonly map: FirewallRuleMap) {}
  private key(name: string): string { return name.trim().toLowerCase(); }
  rules(): readonly WindowsFirewallRule[] { return [...this.map.values()]; }
  hasRule(name: string): boolean { return this.map.has(this.key(name)); }
  addRule(rule: WindowsFirewallRule): void { this.map.set(this.key(rule.name), { ...rule }); }
  deleteRules(name?: string): number {
    let removed = 0;
    for (const [k, r] of [...this.map.entries()]) {
      if (!name || r.name === name) { this.map.delete(k); removed++; }
    }
    return removed;
  }
  clearRules(): void { this.map.clear(); }
}

/** Sous-ensemble du rôle Serveur DHCP réellement consommé par `netsh dhcp server`. */
interface DhcpServerRoleLike {
  addScope(name: string, startRange: string, endRange: string, subnetMask: string): WindowsServerOpResult;
  listScopes(): readonly { name: string; startRange: string; subnetMask: string }[];
  addExclusionRange(startRange: string, endRange: string): WindowsServerOpResult;
  addReservation(scopeName: string, ipAddress: string, clientId: string): WindowsServerOpResult;
}

/** Sous-ensemble structurel de `WindowsDnsServerRole` requis par `dnscmd` (délégué à l'identique). */
interface DnsServerRoleLike {
  addPrimaryZone(name: string): WindowsServerOpResult;
  addARecord(zone: string, node: string, ipv4: string): WindowsServerOpResult;
  addAaaaRecord(zone: string, node: string, ipv6: string): WindowsServerOpResult;
  addCnameRecord(zone: string, node: string, hostNameAlias: string): WindowsServerOpResult;
  addPtrRecord(zone: string, node: string, ptrDomainName: string): WindowsServerOpResult;
  addMxRecord(zone: string, node: string, preference: number, mailExchange: string): WindowsServerOpResult;
  addSrvRecord(zone: string, node: string, data: { priority: number; weight: number; port: number; target: string }): WindowsServerOpResult;
  removeRecord(zone: string, node: string, type: string): WindowsServerOpResult;
  getRecords(zone: string): readonly { name: string; type: string; ttl: number; text: string }[] | null;
  listZones(): readonly { name: string }[];
  setForwarders(addresses: readonly string[]): WindowsServerOpResult;
}

class WindowsDnsServerApiImpl implements DnsServerAdminApi {
  constructor(private readonly role: DnsServerRoleLike) {}
  addPrimaryZone(zone: string): WindowsServerOpResult { return this.role.addPrimaryZone(zone); }
  addARecord(zone: string, node: string, ipv4: string): WindowsServerOpResult { return this.role.addARecord(zone, node, ipv4); }
  addAaaaRecord(zone: string, node: string, ipv6: string): WindowsServerOpResult { return this.role.addAaaaRecord(zone, node, ipv6); }
  addCnameRecord(zone: string, node: string, target: string): WindowsServerOpResult { return this.role.addCnameRecord(zone, node, target); }
  addPtrRecord(zone: string, node: string, ptrDomain: string): WindowsServerOpResult { return this.role.addPtrRecord(zone, node, ptrDomain); }
  addMxRecord(zone: string, node: string, preference: number, mailExchange: string): WindowsServerOpResult {
    return this.role.addMxRecord(zone, node, preference, mailExchange);
  }
  addSrvRecord(zone: string, node: string, data: DnsSrvRecordData): WindowsServerOpResult {
    return this.role.addSrvRecord(zone, node, { priority: data.priority, weight: data.weight, port: data.port, target: data.target });
  }
  removeRecord(zone: string, node: string, type: string): WindowsServerOpResult { return this.role.removeRecord(zone, node, type); }
  getRecords(zone: string): readonly DnsServerZoneRecord[] | null {
    const records = this.role.getRecords(zone);
    return records ? records.map((r) => ({ name: r.name, ttl: r.ttl, type: r.type, text: r.text })) : null;
  }
  listZones(): readonly { readonly name: string }[] {
    return this.role.listZones().map((z) => ({ name: z.name }));
  }
  setForwarders(addresses: readonly string[]): WindowsServerOpResult { return this.role.setForwarders(addresses); }
}

class WindowsDhcpServerApiImpl implements WindowsDhcpServerApi {
  constructor(private readonly role: DhcpServerRoleLike) {}
  addScope(name: string, startRange: string, endRange: string, subnetMask: string): WindowsServerOpResult {
    return this.role.addScope(name, startRange, endRange, subnetMask);
  }
  scopes(): readonly WindowsDhcpScope[] {
    return this.role.listScopes().map((s) => ({ name: s.name, startRange: s.startRange, subnetMask: s.subnetMask }));
  }
  addExclusionRange(startRange: string, endRange: string): WindowsServerOpResult {
    return this.role.addExclusionRange(startRange, endRange);
  }
  addReservation(scopeName: string, ipAddress: string, clientMac: string): WindowsServerOpResult {
    return this.role.addReservation(scopeName, ipAddress, clientMac);
  }
  findScope(scopeAddressOrName: string): WindowsDhcpScope | null {
    const found = this.role.listScopes().find((s) => {
      if (s.name === scopeAddressOrName) return true;
      try {
        return new IPAddress(s.startRange).networkAddress(new SubnetMask(s.subnetMask)).toString() === scopeAddressOrName;
      } catch { return false; }
    });
    return found ? { name: found.name, startRange: found.startRange, subnetMask: found.subnetMask } : null;
  }
}

/** Sous-ensemble du rôle NPS réellement consommé par `netsh nps`. */
interface NpsRoleLike {
  addNasClient(name: string, ipAddress: string, sharedSecret: string): WindowsServerOpResult;
  listNasClients(): readonly { name: string; ipAddress: string }[];
}

class WindowsNpsApiImpl implements WindowsNpsApi {
  constructor(private readonly role: NpsRoleLike) {}
  addNasClient(name: string, address: string, secret: string): WindowsServerOpResult {
    return this.role.addNasClient(name, address, secret);
  }
  nasClients(): readonly WindowsNasClient[] {
    return this.role.listNasClients().map((c) => ({ name: c.name, ipAddress: c.ipAddress }));
  }
}

class WindowsNetConfigApiImpl implements WindowsNetConfigApi {
  readonly ipsec: WindowsIpsecStore;
  readonly lan: WindowsLanStore;
  readonly wlan: WindowsWlanStore;
  readonly http: WindowsHttpStore;
  readonly bridge: WindowsBridgeStore;
  readonly nrpt: WindowsNrptStore;
  readonly firewall: WindowsFirewallApi;

  /** Getters live : le rôle peut être installé APRÈS la construction du shell (mémoïsé une fois), ex. `Install-WindowsFeature DHCP`. */
  get dhcpServer(): WindowsDhcpServerApi | null {
    const role = this.deps.getDhcpServerRole();
    return role ? new WindowsDhcpServerApiImpl(role) : null;
  }
  get nps(): WindowsNpsApi | null {
    const role = this.deps.getNpsRole();
    return role ? new WindowsNpsApiImpl(role) : null;
  }

  constructor(
    private readonly ports: () => readonly Port[],
    private readonly deps: Pick<WindowsMachineApiDeps,
      'arpTable' | 'getRoutingTable' | 'addStaticRoute' | 'removeRoute' | 'setDefaultGateway' | 'clearDefaultGateway'
      | 'addStaticARP' | 'deleteARP' | 'clearARPTable' | 'resolveHostname' | 'executePingSequence'
      | 'executeTraceroute' | 'reverseLookup' | 'resolveViaHostsFile' | 'firstConfiguredDnsServer' | 'queryDnsServer'
      | 'isDHCPConfigured' | 'getConnectionDnsSuffix' | 'getDefaultGateway6' | 'effectiveDnsServers' | 'getDnsSuffix'
      | 'getClassId' | 'setClassId' | 'getClassId6' | 'setClassId6' | 'sendRouterSolicitation' | 'autoDiscoverDHCPServers'
      | 'getDhcpLease' | 'releaseDhcpLease' | 'requestDhcpLease' | 'releaseDynamicIPv6' | 'dnsCache'
      | 'netInterfaces' | 'resolveAdapterName' | 'configureInterface' | 'setAddressDhcp' | 'clearInterfaceIP' | 'setDnsServers'
      | 'getDnsMode' | 'setDnsMode' | 'getInterfaceAdmin' | 'setInterfaceAdmin' | 'renameInterface'
      | 'resetTcpIpStack' | 'resetWinsockCatalog' | 'addIPv6Route' | 'getIPv6Routes' | 'portProxy'
      | 'getWinhttpProxy' | 'setWinhttpProxy' | 'setPrimaryDnsSuffix' | 'isServiceRunning' | 'dhcpClientNetsh'
      | 'ipsecNetsh' | 'netshFeatures' | 'dynamicFirewallRules' | 'getDhcpServerRole' | 'getNpsRole'>,
  ) {
    this.ipsec = new WindowsIpsecStoreImpl(deps.ipsecNetsh);
    this.lan = new WindowsLanStoreImpl(deps.netshFeatures.lan);
    this.wlan = new WindowsWlanStoreImpl(deps.netshFeatures.wlan);
    this.http = new WindowsHttpStoreImpl(deps.netshFeatures.http);
    this.bridge = new WindowsBridgeStoreImpl(deps.netshFeatures.bridge);
    this.nrpt = new WindowsNrptStoreImpl(deps.netshFeatures.nrpt);
    this.firewall = new WindowsFirewallApiImpl(deps.dynamicFirewallRules);
  }

  adapters(): readonly WindowsAdapterInfo[] {
    // `name` = clé de la table de ports (reflète un renommage `netsh`), pas
    // `port.getName()` qui reste figé (nom interne immuable du port).
    return this.deps.netInterfaces().map(({ name, port }) => ({
      name,
      mac: port.getMAC().toString(),
      ip: port.getIPAddress()?.toString(),
      mask: port.getSubnetMask()?.toString(),
      globalIPv6: port.getGlobalIPv6()?.toString(),
      linkLocalIPv6: port.getLinkLocalIPv6()?.toString(),
      isUp: port.getIsUp(),
      isConnected: port.isConnected(),
      isAdminDown: port.isAdminDown(),
      connectionDnsSuffix: this.deps.getConnectionDnsSuffix(name),
      isDhcp: this.deps.isDHCPConfigured(name),
      dnsMode: this.deps.getDnsMode(name),
      adminEnabled: this.deps.getInterfaceAdmin(name),
      secondaryIps: port.getSecondaryIPs().map((e) => ({ ip: e.ip.toString(), mask: e.mask.toString() })),
      ipv6Addresses: this.mapIPv6Addresses(port),
    }));
  }

  private mapIPv6Addresses(port: Port): readonly WindowsIPv6AddressEntry[] {
    return port.getIPv6Addresses().map((e) => ({
      address: e.address.toString(),
      prefixLength: e.prefixLength,
      origin: e.origin,
    }));
  }

  private findPort(ifName: string): Port | undefined {
    return this.deps.netInterfaces().find((e) => e.name === ifName)?.port;
  }

  arpEntries(): readonly WindowsArpEntry[] {
    return [...this.deps.arpTable.entries()].map(([ip, entry]) => ({
      ip,
      mac: entry.mac.toString(),
      iface: entry.iface,
      type: entry.type,
    }));
  }

  addStaticArp(ip: string, mac: string, iface: string): { ok: boolean; error?: string } {
    try {
      this.deps.addStaticARP(new IPAddress(ip), new MACAddress(mac), iface);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  deleteArp(ip: string): void {
    this.deps.deleteARP(new IPAddress(ip));
  }

  clearArp(): void {
    this.deps.clearARPTable();
  }

  routes(): readonly WindowsRouteEntry[] {
    return this.deps.getRoutingTable().map((r) => ({
      network: r.network.toString(),
      mask: r.mask.toString(),
      nextHop: r.nextHop ? r.nextHop.toString() : null,
      iface: r.iface,
      metric: r.metric,
      type: r.type,
    }));
  }

  addRoute(network: string, mask: string, nextHop: string, metric: number): boolean {
    return this.deps.addStaticRoute(new IPAddress(network), new SubnetMask(mask), new IPAddress(nextHop), metric);
  }

  removeRoute(network: string, mask: string): boolean {
    return this.deps.removeRoute(new IPAddress(network), new SubnetMask(mask));
  }

  setDefaultGateway(gw: string): void {
    this.deps.setDefaultGateway(new IPAddress(gw));
  }

  clearDefaultGateway(): void {
    this.deps.clearDefaultGateway();
  }

  async resolveHostname(name: string): Promise<string | null> {
    const ip = await this.deps.resolveHostname(name);
    return ip ? ip.toString() : null;
  }

  async pingSequence(targetIp: string, count: number, timeoutMs?: number, ttl?: number): Promise<readonly WindowsPingReply[]> {
    const results = await this.deps.executePingSequence(new IPAddress(targetIp), count, timeoutMs, ttl);
    return results.map((r) => ({
      success: r.success,
      fromIP: r.fromIP,
      ttl: r.ttl,
      rttMs: r.rttMs,
      error: r.error,
    }));
  }

  async traceroute(targetIp: string, maxHops?: number, timeoutMs?: number): Promise<readonly WindowsTracerouteHop[]> {
    return this.deps.executeTraceroute(new IPAddress(targetIp), maxHops, timeoutMs);
  }

  reverseLookup(ip: string): string | null {
    return this.deps.reverseLookup(ip);
  }

  resolveViaHostsFile(name: string): string | null {
    return this.deps.resolveViaHostsFile(name);
  }

  firstConfiguredDnsServer(): string {
    return this.deps.firstConfiguredDnsServer();
  }

  async queryDnsServer(server: string, name: string, qtype: string, timeoutMs?: number): Promise<DnsMessage | null> {
    let serverIP: IPAddress;
    try { serverIP = new IPAddress(server); } catch { return null; }
    return this.deps.queryDnsServer(serverIP, name, qtype, timeoutMs);
  }

  defaultGateway(): string | null {
    // Passerelle IPv4 : déjà portée par la route par défaut de `routes()`.
    const def = this.deps.getRoutingTable().find((r) => r.type === 'default');
    return def?.nextHop ? def.nextHop.toString() : null;
  }

  defaultGateway6(): string | null {
    return this.deps.getDefaultGateway6()?.toString() ?? null;
  }

  primaryDnsSuffix(): string {
    return this.deps.getDnsSuffix();
  }

  staticDnsServers(ifName: string): readonly string[] {
    return this.deps.effectiveDnsServers(ifName);
  }

  dhcpLease(ifName: string): WindowsDhcpLease | null {
    const lease = this.deps.getDhcpLease(ifName);
    if (!lease) return null;
    return {
      ipAddress: lease.ipAddress,
      serverIdentifier: lease.serverIdentifier,
      leaseStartMs: lease.leaseStart,
      expirationMs: lease.expiration,
      dnsServers: lease.dnsServers,
    };
  }

  releaseLease(ifName: string): void {
    this.deps.releaseDhcpLease(ifName);
  }

  requestLease(ifName: string): void {
    this.deps.requestDhcpLease(ifName);
  }

  autoDiscoverDhcpServers(): void {
    this.deps.autoDiscoverDHCPServers();
  }

  releaseDynamicIPv6(ifName: string): readonly string[] {
    return this.deps.releaseDynamicIPv6(ifName);
  }

  sendRouterSolicitation(ifName: string): void {
    this.deps.sendRouterSolicitation(ifName);
  }

  classId(ifName: string, isV6: boolean): string | null {
    return isV6 ? this.deps.getClassId6(ifName) : this.deps.getClassId(ifName);
  }

  setClassId(ifName: string, isV6: boolean, classId: string | null): void {
    if (isV6) this.deps.setClassId6(ifName, classId);
    else this.deps.setClassId(ifName, classId);
  }

  flushDnsCache(): void {
    this.deps.dnsCache.flush();
  }

  dnsCacheEntries(): readonly WindowsDnsCacheEntry[] {
    const now = this.deps.dnsCache.now();
    return this.deps.dnsCache.activeEntries().map((e) => ({
      name: e.name,
      type: e.type,
      value: e.value,
      ttlRemainingSec: Math.max(0, e.ttl - Math.floor((now - e.insertedAt) / 1000)),
    }));
  }

  resolveAdapterName(name: string): string | null {
    const resolved = this.deps.resolveAdapterName(name);
    return this.findPort(resolved) ? resolved : null;
  }

  configureAddress(ifName: string, ip: string, mask: string): { ok: boolean; error?: string } {
    try {
      this.deps.configureInterface(ifName, new IPAddress(ip), new SubnetMask(mask));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  setAddressDhcp(ifName: string): void {
    this.deps.setAddressDhcp(ifName);
  }

  clearInterfaceIP(ifName: string): void {
    this.deps.clearInterfaceIP(ifName);
  }

  addSecondaryIp(ifName: string, ip: string, mask: string): { ok: boolean; error?: string } {
    const port = this.findPort(ifName);
    if (!port) return { ok: false, error: `interface introuvable : ${ifName}` };
    try {
      port.addSecondaryIP(new IPAddress(ip), new SubnetMask(mask));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  removeSecondaryIp(ifName: string, ip: string): void {
    const port = this.findPort(ifName);
    port?.removeSecondaryIP(new IPAddress(ip));
  }

  setDnsServers(ifName: string, servers: readonly string[]): void {
    this.deps.setDnsServers(ifName, servers);
  }

  setDnsMode(ifName: string, mode: 'static' | 'dhcp'): void {
    this.deps.setDnsMode(ifName, mode);
  }

  setInterfaceAdmin(ifName: string, enabled: boolean): void {
    this.deps.setInterfaceAdmin(ifName, enabled);
  }

  renameInterface(oldName: string, newName: string): boolean {
    return this.deps.renameInterface(oldName, newName);
  }

  resetTcpIpStack(): void {
    this.deps.resetTcpIpStack();
  }

  resetWinsockCatalog(): void {
    this.deps.resetWinsockCatalog();
  }

  addIPv6Address(ifName: string, address: string, prefixLength: number): { ok: boolean; error?: string } {
    const port = this.findPort(ifName);
    if (!port) return { ok: false, error: `interface introuvable : ${ifName}` };
    try {
      port.configureIPv6(new IPv6Address(address), prefixLength);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  removeIPv6Address(ifName: string, address: string): boolean {
    const port = this.findPort(ifName);
    if (!port) return false;
    try {
      return port.removeIPv6Address(new IPv6Address(address));
    } catch {
      return false;
    }
  }

  ipv6Routes(): readonly WindowsIPv6RouteEntry[] {
    return this.deps.getIPv6Routes();
  }

  addIPv6Route(entry: WindowsIPv6RouteEntry): void {
    this.deps.addIPv6Route(entry);
  }

  portProxyRules(family?: string): readonly WindowsPortProxyRule[] {
    const families = family ? [family as PortProxyFamily] : [...PORT_PROXY_FAMILIES];
    const out: WindowsPortProxyRule[] = [];
    for (const f of families) {
      for (const r of this.deps.portProxy.byFamily(f)) {
        out.push({ family: r.family, listenAddress: r.listenAddress, listenPort: r.listenPort, connectAddress: r.connectAddress, connectPort: r.connectPort });
      }
    }
    return out;
  }

  addPortProxyRule(rule: WindowsPortProxyRule): void {
    this.deps.portProxy.add(new PortProxyRule(rule.family, rule.listenAddress, rule.listenPort, rule.connectAddress, rule.connectPort));
  }

  removePortProxyRule(family: string, listenAddress: string, listenPort: number): boolean {
    return this.deps.portProxy.remove(family as PortProxyFamily, listenAddress, listenPort);
  }

  resetPortProxy(): void {
    this.deps.portProxy.reset();
  }

  winhttpProxy(): string {
    return this.deps.getWinhttpProxy();
  }

  setWinhttpProxy(proxy: string): void {
    this.deps.setWinhttpProxy(proxy);
  }

  setPrimaryDnsSuffix(suffix: string): void {
    this.deps.setPrimaryDnsSuffix(suffix);
  }

  isDhcpClientRunning(): boolean {
    return this.deps.isServiceRunning('dhcp');
  }

  isDnsClientRunning(): boolean {
    return this.deps.isServiceRunning('dnscache');
  }

  dhcpClientConfig() {
    const s = this.deps.dhcpClientNetsh;
    return { installed: s.installed, tracingEnabled: s.tracingEnabled, tracingOutput: s.tracingOutput, traceEnabled: s.traceEnabled };
  }

  setDhcpClientInstalled(installed: boolean): void {
    this.deps.dhcpClientNetsh.installed = installed;
  }

  setDhcpClientTracing(enabled: boolean, output?: string): void {
    this.deps.dhcpClientNetsh.tracingEnabled = enabled;
    if (output !== undefined) this.deps.dhcpClientNetsh.tracingOutput = output;
  }

  setDhcpClientTraceEnabled(enabled: boolean): void {
    this.deps.dhcpClientNetsh.traceEnabled = enabled;
  }

  setInterfaceReleased(ifName: string, released: boolean): void {
    if (released) this.deps.dhcpClientNetsh.releasedIfaces.add(ifName);
    else this.deps.dhcpClientNetsh.releasedIfaces.delete(ifName);
  }

  isInterfaceReleased(ifName: string): boolean {
    return this.deps.dhcpClientNetsh.releasedIfaces.has(ifName);
  }
}

class WindowsPowerApi implements PowerApi {
  constructor(private readonly deps: Pick<WindowsMachineApiDeps, 'powerOn' | 'powerOff'>) {}

  async shutdown(): Promise<void> {
    this.deps.powerOff();
  }

  async reboot(): Promise<void> {
    this.deps.powerOff();
    this.deps.powerOn();
  }
}

class WindowsMacroApi implements MacroApi {
  constructor(private readonly doskey: DoskeyTable) {}

  list(): readonly { head: string; body: string }[] {
    return this.doskey.entries();
  }

  define(definition: string): void {
    this.doskey.define(definition);
  }
}

class WindowsEventLogApiImpl implements EventLogApi {
  constructor(private readonly deps: Pick<WindowsMachineApiDeps, 'eventLogEntries' | 'dhcpEventLog' | 'syncDhcpEvents' | 'addDhcpEvent'>) {}
  entries(logName: string): readonly WindowsEventLogEntry[] | null {
    return this.deps.eventLogEntries(logName);
  }
  dhcpEventLog(): readonly string[] {
    this.deps.syncDhcpEvents();
    return this.deps.dhcpEventLog();
  }
  ensureDhcpInitEvent(): void {
    this.deps.syncDhcpEvents();
    if (this.deps.dhcpEventLog().length === 0) {
      this.deps.addDhcpEvent('INIT', 'Dhcp-Client service initialized');
    }
  }
}

class WindowsDomainApiImpl implements DomainApi {
  constructor(private readonly deps: Pick<WindowsMachineApiDeps,
    'gpupdateForce' | 'groupPolicyResult' | 'locateDomainController' | 'dcDiagnostics' | 'kerberosTickets'
    | 'joinDomain' | 'resolveDcAddress' | 'establishTrust'>) {}
  gpupdateForce(): { ok: boolean; message: string } {
    return this.deps.gpupdateForce();
  }
  groupPolicyResult(): WindowsGpResult | null {
    return this.deps.groupPolicyResult();
  }
  locateDomainController(domain: string): DomainControllerLocation {
    return this.deps.locateDomainController(domain);
  }
  dcDiagnostics(): DomainControllerDiagnostics {
    return this.deps.dcDiagnostics();
  }
  kerberosTickets(): readonly KerberosCachedTicket[] {
    return this.deps.kerberosTickets();
  }
  joinDomain(domain: string, dcAddress: string, user: string, password: string): { ok: boolean; message: string } {
    return this.deps.joinDomain(domain, dcAddress, user, password);
  }
  resolveDcAddress(domain: string): string | null {
    return this.deps.resolveDcAddress(domain);
  }
  establishTrust(remoteRealm: string, dcAddress: string, direction: DomainTrustDirection, transitive: boolean, user: string, password: string): { ok: boolean; message: string } | null {
    return this.deps.establishTrust(remoteRealm, dcAddress, direction, transitive, user, password);
  }
}

class WindowsRunAsApiImpl implements RunAsApi {
  constructor(private readonly deps: Pick<WindowsMachineApiDeps, 'runasGetUser' | 'runasCurrentUser' | 'runasCommandAs'>) {}
  getUser(name: string): { readonly name: string; readonly enabled: boolean } | undefined {
    return this.deps.runasGetUser(name);
  }
  currentUser(): string {
    return this.deps.runasCurrentUser();
  }
  runCommandAs(userName: string, command: string): Promise<string> {
    return this.deps.runasCommandAs(userName, command);
  }
}

class WindowsLicensingApiImpl implements LicensingApi {
  constructor(private readonly deps: Pick<WindowsMachineApiDeps,
    'licensingInstallProductKey' | 'licensingActivate' | 'licensingProductKey' | 'licensingState'>) {}
  installProductKey(key: string): { ok: boolean; message: string } {
    return this.deps.licensingInstallProductKey(key);
  }
  activate(): { ok: boolean; message: string } {
    return this.deps.licensingActivate();
  }
  productKey(): string | null {
    return this.deps.licensingProductKey();
  }
  state(): string {
    return this.deps.licensingState();
  }
}

class WindowsPrintClientApiImpl implements PrintClientApi {
  constructor(private readonly deps: Pick<WindowsMachineApiDeps, 'lprSubmitJob'>) {}
  submitLpdJob(server: string, queue: string, jobName: string, content: Uint8Array): { ok: boolean; error?: string } {
    return this.deps.lprSubmitJob(server, queue, jobName, content);
  }
}

export class WindowsMachineApi implements MachineApi {
  readonly fs: FileSystemApi;
  readonly proc: ProcessApi;
  readonly net: NetworkApi;
  readonly users: UserManagementApi;
  readonly groups: GroupManagementApi;
  readonly power: PowerApi;
  readonly services: ServiceManagementApi;
  readonly macros: MacroApi;
  readonly smbShares: SmbShareApi;
  readonly smbSessions: SmbSessionApi;
  readonly netUse: NetUseApi;
  readonly accountsPolicy: AccountsPolicyApi;
  readonly scheduling: SchedulingApi;
  readonly printing: PrintApi;
  readonly registry: RegistryApi;
  readonly auditPolicy: AuditPolicyApi;
  readonly winRm: WinRmApi;
  readonly netConfig: WindowsNetConfigApi;
  readonly eventLog: EventLogApi;
  readonly domain: DomainApi;
  readonly runAs: RunAsApi;
  readonly licensing: LicensingApi;
  readonly printClient: PrintClientApi;
  readonly hostname: string;
  readonly os: OsIdentity;
  readonly hardware: CkHardwareProfile;
  private readonly bootedAtFn: () => Date | null;
  private readonly nowFn: () => Date;
  private readonly getDnsServerRoleFn: () => DnsServerRoleLike | null;

  /**
   * `dnscmd` — administration du serveur DNS. Getter live (jamais mémoïsé)
   * car le rôle DNS peut être installé après la construction du shell ;
   * `null` tant que le rôle n'est pas installé (donc « not recognized » sur
   * un simple poste, sans exposition de fonctionnalité serveur).
   */
  get dnsServer(): DnsServerAdminApi | null {
    const role = this.getDnsServerRoleFn();
    return role ? new WindowsDnsServerApiImpl(role) : null;
  }

  constructor(deps: WindowsMachineApiDeps) {
    this.fs = new WindowsFileSystemApi(deps.fs);
    this.proc = new WindowsProcessApi(deps.processManager, deps.hostname, () => deps.userManager.currentUser);
    this.net = new WindowsNetworkApi(() => deps.ports, deps.isDHCPConfigured, deps.socketTable);
    this.users = new WindowsUserManagementApi(deps.userManager, deps.hostname, deps.getDomainSession, deps.getDirectoryStore);
    this.groups = new WindowsGroupManagementApi(deps.userManager);
    this.power = new WindowsPowerApi(deps);
    this.services = new WindowsServiceManagementApi(deps.serviceManager, deps.processManager);
    this.macros = new WindowsMacroApi(deps.doskey);
    this.smbShares = new WindowsSmbShareApi(deps);
    this.smbSessions = new WindowsSmbSessionApi(deps.smbSessions);
    this.netUse = new WindowsNetUseApi(deps);
    this.accountsPolicy = new WindowsAccountsPolicyApi(deps.accountsPolicy);
    this.scheduling = new WindowsSchedulingApi(deps);
    this.printing = new WindowsPrintApi(deps);
    this.registry = deps.registry;
    this.auditPolicy = new WindowsAuditPolicyApi(deps.auditPolicy);
    this.winRm = new WindowsWinRmApi(deps.winrm);
    this.netConfig = new WindowsNetConfigApiImpl(() => deps.ports, deps);
    this.eventLog = new WindowsEventLogApiImpl(deps);
    this.domain = new WindowsDomainApiImpl(deps);
    this.runAs = new WindowsRunAsApiImpl(deps);
    this.licensing = new WindowsLicensingApiImpl(deps);
    this.printClient = new WindowsPrintClientApiImpl(deps);
    this.hostname = deps.hostname;
    this.os = {
      name: deps.identity.os.name,
      prettyName: deps.identity.os.prettyName,
      version: deps.identity.os.version,
      kernelRelease: deps.identity.kernel.release,
    };
    this.hardware = {
      manufacturer: deps.hardware.manufacturer,
      productName: deps.hardware.productName,
      cpu: {
        sockets: deps.hardware.cpu.sockets,
        cpuFamily: deps.hardware.cpu.cpuFamily,
        model: deps.hardware.cpu.model,
        stepping: deps.hardware.cpu.stepping,
        vendor: deps.hardware.cpu.vendor,
        clockMhz: deps.hardware.cpu.clockMhz,
      },
      memory: {
        totalKib: deps.hardware.memory.totalKib,
        availableKib: deps.hardware.memory.availableKib,
        swapTotalKib: deps.hardware.memory.swapTotalKib,
      },
      firmware: {
        vendor: deps.hardware.firmware.vendor,
        version: deps.hardware.firmware.version,
        releaseDate: deps.hardware.firmware.releaseDate,
      },
    };
    this.bootedAtFn = deps.bootedAt;
    this.nowFn = deps.now;
    this.getDnsServerRoleFn = deps.getDnsServerRole;
  }

  bootedAt(): Date | null {
    return this.bootedAtFn();
  }

  now(): Date {
    return this.nowFn();
  }
}
