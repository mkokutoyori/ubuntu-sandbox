import {
  AclEntry,
  AuditPolicyApi,
  FileAttributes,
  FileNodeType,
  FileStat,
  FileSystemActor,
  FileSystemApi,
  GroupInfo,
  GroupManagementApi,
  HardwareProfile as CkHardwareProfile,
  MachineApi,
  MacroApi,
  NetExeApi,
  NetworkApi,
  OsIdentity,
  PowerApi,
  PrintApi,
  ProcessApi,
  ProcessInfo as CkProcessInfo,
  RegistryApi,
  SchedulingApi,
  SecurityIdentity,
  ServiceManagementApi,
  SocketInfo,
  UserManagementApi,
  WinRmApi,
} from '@/command-kernel/machine/types';
import { FileSystemError } from '@/command-kernel/errors';
import { User } from '@/command-kernel/session/types';
import type { Port } from '@/network/hardware/Port';
import type { IPAddress } from '@/network/core/types';
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
import type { WinRegistryProvider } from '../WinRegCommand';
import type { WindowsAuditPolicy } from '../WindowsAuditPolicy';
import type { WindowsWinRmConfig } from '../WindowsWinRmConfig';
import { cmdSc } from '../WinSc';
import { cmdNetUser, cmdNetLocalgroup } from '../WinNetUser';
import { cmdNetStart, cmdNetStop } from '../WinNetStart';
import { cmdNetShare } from '../WinNetShare';
import { cmdNetUse } from '../WinNetUse';
import { cmdSchtasks } from '../WinSystemCommands';
import { cmdPrint } from '../WinPrint';
import { cmdAuditpol } from '../WindowsAuditPolicy';
import { cmdWinrm } from '../WindowsWinRmConfig';
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
}

class WindowsServiceManagementApi implements ServiceManagementApi {
  constructor(
    private readonly serviceManager: WindowsServiceManager,
    private readonly processManager: WindowsProcessManager,
  ) {}

  async execute(argv: readonly string[], caller: { isAdmin: boolean; userName: string }): Promise<string> {
    return cmdSc(
      { serviceManager: this.serviceManager, processManager: this.processManager, isAdmin: caller.isAdmin, currentUser: caller.userName },
      [...argv],
    );
  }
}

function formatNetSessions(sessions: readonly { clientComputerName: string; user: string; numOpens: number }[]): string {
  const header =
    'Computer             User name            Client Type       Opens Idle time\n' +
    '-------------------------------------------------------------------------\n';
  if (sessions.length === 0) return header + 'There are no entries in the list.';
  const rows = sessions.map((s) =>
    `\\\\${s.clientComputerName}`.padEnd(22) + s.user.padEnd(21) + ''.padEnd(18) + String(s.numOpens).padStart(5) + '  00:00:00');
  return header + rows.join('\n') + '\nThe command completed successfully.';
}

class WindowsNetExeApi implements NetExeApi {
  constructor(
    private readonly deps: Pick<WindowsMachineApiDeps,
      'hostname' | 'userManager' | 'processManager' | 'serviceManager' | 'getDirectoryStore' |
      'smbShares' | 'smbSessions' | 'netUseTable' | 'accountsPolicy' | 'resolveHostname' | 'dialSmbShare'>,
  ) {}

  private isServiceRunning(name: string): boolean {
    return this.deps.serviceManager.getService(name)?.state === 'Running';
  }

  private netSession(args: readonly string[]): string {
    if (args.some((a) => a.toLowerCase() === '/delete')) {
      const target = args.find((a) => a.startsWith('\\\\'));
      for (const s of this.deps.smbSessions.list()) {
        if (!target || s.clientIp === target.slice(2) || s.clientComputerName === target.slice(2)) {
          this.deps.smbSessions.close(s.id);
        }
      }
      return 'The command completed successfully.';
    }
    return formatNetSessions(this.deps.smbSessions.list());
  }

  private netAccounts(args: readonly string[]): string {
    if (args.length === 0) return this.deps.accountsPolicy.render();
    for (const arg of args) {
      const m = /^\/(\w+):(.+)$/.exec(arg);
      if (!m) continue;
      const err = this.deps.accountsPolicy.apply(m[1], m[2]);
      if (err) return `System error.\n\n${err}`;
    }
    return 'The command completed successfully.';
  }

  async execute(argv: readonly string[], caller: { isAdmin: boolean; userName: string }): Promise<string> {
    if (argv.length === 0) {
      return 'More help is available by typing NET HELP command.';
    }
    const subCmd = argv[0].toLowerCase();
    const subArgs = argv.slice(1);
    const netUserCtx = { hostname: this.deps.hostname, userManager: this.deps.userManager, directoryStore: this.deps.getDirectoryStore() };
    const netStartCtx = { serviceManager: this.deps.serviceManager, processManager: this.deps.processManager, isAdmin: caller.isAdmin };
    const gateCtx = { isServiceRunning: (name: string) => this.isServiceRunning(name) };

    switch (subCmd) {
      case 'user': return cmdNetUser(netUserCtx, subArgs);
      case 'localgroup': return cmdNetLocalgroup(netUserCtx, subArgs);
      case 'start': return cmdNetStart(netStartCtx, subArgs);
      case 'stop': return cmdNetStop(netStartCtx, subArgs);
      case 'share': return cmdNetShare({ ...gateCtx, smbShares: this.deps.smbShares }, subArgs);
      case 'session': return this.netSession(subArgs);
      case 'accounts': return this.netAccounts(subArgs);
      case 'use': return cmdNetUse({
        ...gateCtx,
        netUseTable: this.deps.netUseTable,
        resolveHostname: this.deps.resolveHostname,
        dialSmbShare: this.deps.dialSmbShare,
      }, subArgs);
      default: return 'The command syntax is incorrect.';
    }
  }
}

class WindowsSchedulingApi implements SchedulingApi {
  constructor(
    private readonly deps: Pick<WindowsMachineApiDeps, 'serviceManager' | 'processManager' | 'scheduledTasks' | 'now'>,
  ) {}

  async execute(argv: readonly string[]): Promise<string> {
    return cmdSchtasks({
      isServiceRunning: (name) => this.deps.serviceManager.getService(name)?.state === 'Running',
      processManager: this.deps.processManager,
      scheduledTasks: this.deps.scheduledTasks,
      now: this.deps.now,
    }, [...argv]);
  }
}

class WindowsPrintApi implements PrintApi {
  constructor(private readonly deps: Pick<WindowsMachineApiDeps, 'hostname' | 'serviceManager'>) {}

  async execute(argv: readonly string[]): Promise<string> {
    return cmdPrint({
      hostname: this.deps.hostname,
      isServiceRunning: (name) => this.deps.serviceManager.getService(name)?.state === 'Running',
    }, [...argv]);
  }
}

class WindowsAuditPolicyApi implements AuditPolicyApi {
  constructor(private readonly policy: WindowsAuditPolicy) {}

  async execute(argv: readonly string[]): Promise<string> {
    return cmdAuditpol(this.policy, [...argv]);
  }
}

class WindowsWinRmApi implements WinRmApi {
  constructor(private readonly config: WindowsWinRmConfig) {}

  async execute(argv: readonly string[]): Promise<string> {
    return cmdWinrm(this.config, [...argv]);
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
  readonly netExe: NetExeApi;
  readonly scheduling: SchedulingApi;
  readonly printing: PrintApi;
  readonly registry: RegistryApi;
  readonly auditPolicy: AuditPolicyApi;
  readonly winRm: WinRmApi;
  readonly hostname: string;
  readonly os: OsIdentity;
  readonly hardware: CkHardwareProfile;
  private readonly bootedAtFn: () => Date | null;
  private readonly nowFn: () => Date;

  constructor(deps: WindowsMachineApiDeps) {
    this.fs = new WindowsFileSystemApi(deps.fs);
    this.proc = new WindowsProcessApi(deps.processManager, deps.hostname, () => deps.userManager.currentUser);
    this.net = new WindowsNetworkApi(() => deps.ports, deps.isDHCPConfigured, deps.socketTable);
    this.users = new WindowsUserManagementApi(deps.userManager, deps.hostname, deps.getDomainSession);
    this.groups = new WindowsGroupManagementApi(deps.userManager);
    this.power = new WindowsPowerApi(deps);
    this.services = new WindowsServiceManagementApi(deps.serviceManager, deps.processManager);
    this.macros = new WindowsMacroApi(deps.doskey);
    this.netExe = new WindowsNetExeApi(deps);
    this.scheduling = new WindowsSchedulingApi(deps);
    this.printing = new WindowsPrintApi(deps);
    this.registry = deps.registry;
    this.auditPolicy = new WindowsAuditPolicyApi(deps.auditPolicy);
    this.winRm = new WindowsWinRmApi(deps.winrm);
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
