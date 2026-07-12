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
  WindowsNetConfigApi,
  WindowsPingReply,
  WindowsRouteEntry,
  WindowsTracerouteHop,
  WinRmApi,
  WinRmListenerInfo,
} from '@/command-kernel/machine/types';
import { FileSystemError } from '@/command-kernel/errors';
import { User } from '@/command-kernel/session/types';
import type { Port } from '@/network/hardware/Port';
import { IPAddress, MACAddress, SubnetMask } from '@/network/core/types';
import type { ARPEntry, HostRouteEntry } from '@/network/devices/EndHost';
import type { PingResult, TracerouteHop } from '@/network/devices/windows/WinCommandExecutor';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
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
      : `${this.hostname.toLowerCase()}\\${name.toLowerCase()}`;

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

class WindowsNetConfigApiImpl implements WindowsNetConfigApi {
  constructor(
    private readonly ports: () => readonly Port[],
    private readonly deps: Pick<WindowsMachineApiDeps,
      'arpTable' | 'getRoutingTable' | 'addStaticRoute' | 'removeRoute' | 'setDefaultGateway' | 'clearDefaultGateway'
      | 'addStaticARP' | 'deleteARP' | 'clearARPTable' | 'resolveHostname' | 'executePingSequence'
      | 'executeTraceroute' | 'reverseLookup' | 'resolveViaHostsFile' | 'firstConfiguredDnsServer' | 'queryDnsServer'>,
  ) {}

  adapters(): readonly WindowsAdapterInfo[] {
    return this.ports().map((port) => ({
      name: port.getName(),
      mac: port.getMAC().toString(),
      ip: port.getIPAddress()?.toString(),
      isUp: port.getIsUp(),
      isConnected: port.isConnected(),
      isAdminDown: port.isAdminDown(),
    }));
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
  readonly hostname: string;
  readonly os: OsIdentity;
  readonly hardware: CkHardwareProfile;
  private readonly bootedAtFn: () => Date | null;
  private readonly nowFn: () => Date;

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
  }

  bootedAt(): Date | null {
    return this.bootedAtFn();
  }

  now(): Date {
    return this.nowFn();
  }
}
