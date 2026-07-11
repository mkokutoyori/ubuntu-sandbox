import {
  FileNodeType,
  FileStat,
  FileSystemActor,
  FileSystemApi,
  GroupInfo,
  GroupManagementApi,
  HardwareProfile as CkHardwareProfile,
  MachineApi,
  NetworkApi,
  OsIdentity,
  PowerApi,
  ProcessApi,
  ProcessInfo as CkProcessInfo,
  UserManagementApi,
} from '@/command-kernel/machine/types';
import { FileSystemError } from '@/command-kernel/errors';
import { User } from '@/command-kernel/session/types';
import type { Port } from '@/network/hardware/Port';
import type { SystemIdentity } from '@/network/devices/host/identity/SystemIdentity';
import type { HardwareProfile } from '@/network/devices/host/hardware/HardwareProfile';
import { WindowsFileSystem } from '../WindowsFileSystem';
import type { WindowsProcessManager } from '../WindowsProcessManager';
import type { WindowsUserManager } from '../WindowsUserManager';
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
  readonly serviceManager: import('../WindowsServiceManager').WindowsServiceManager;
  isDHCPConfigured(ifName: string): boolean;
  bootedAt(): Date | null;
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
 * `ownerGid` (real ownership/permissions go through the ACL API — `icacls` —
 * which stays on the legacy path), so this is inert plumbing, not
 * user-visible fiction.
 */
const PLACEHOLDER_MODE = 0o666;

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
    // `icacls`, which is not migrated yet. No cmd command reaches this.
  }

  async chown(): Promise<void> {
    // See chmod() above — ownership goes through ACL principals (`setOwner`),
    // not numeric uid/gid. Not reachable by any migrated cmd command yet.
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
}

class WindowsProcessApi implements ProcessApi {
  readonly native: WindowsProcessManager;

  constructor(private readonly processManager: WindowsProcessManager) {
    this.native = processManager;
  }

  async list(): Promise<CkProcessInfo[]> {
    return this.processManager.getAllProcesses().map((p) => ({
      pid: p.pid,
      command: p.name,
      ownerUid: 0,
    }));
  }

  async kill(pid: number): Promise<void> {
    this.processManager.killProcess(pid, true, true);
  }

  async spawn(command: string, argv: readonly string[]): Promise<CkProcessInfo> {
    const proc = this.processManager.spawnProcess([command, ...argv].join(' '), 0, 'SYSTEM');
    return { pid: proc.pid, command: proc.name, ownerUid: 0 };
  }
}

class WindowsNetworkApi implements NetworkApi {
  readonly native: unknown;

  constructor(
    private readonly ports: () => readonly Port[],
    private readonly isDHCPConfigured: (ifName: string) => boolean,
    socketTable: unknown,
  ) {
    this.native = socketTable;
  }

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
}

class WindowsUserManagementApi implements UserManagementApi {
  constructor(private readonly userManager: WindowsUserManager) {}

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

export class WindowsMachineApi implements MachineApi {
  readonly fs: FileSystemApi;
  readonly proc: ProcessApi;
  readonly net: NetworkApi;
  readonly users: UserManagementApi;
  readonly groups: GroupManagementApi;
  readonly power: PowerApi;
  readonly hostname: string;
  readonly os: OsIdentity;
  readonly hardware: CkHardwareProfile;
  readonly servicesNative: unknown;
  private readonly bootedAtFn: () => Date | null;

  constructor(deps: WindowsMachineApiDeps) {
    this.fs = new WindowsFileSystemApi(deps.fs);
    this.proc = new WindowsProcessApi(deps.processManager);
    this.net = new WindowsNetworkApi(() => deps.ports, deps.isDHCPConfigured, deps.socketTable);
    this.users = new WindowsUserManagementApi(deps.userManager);
    this.groups = new WindowsGroupManagementApi(deps.userManager);
    this.power = new WindowsPowerApi(deps);
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
    this.servicesNative = deps.serviceManager;
  }

  bootedAt(): Date | null {
    return this.bootedAtFn();
  }

  now(): Date {
    return new Date();
  }
}
