import {
  AuditApi,
  FileNodeType,
  FileStat,
  FileSystemActor,
  FileSystemApi,
  GroupInfo,
  GroupManagementApi,
  KernelMessage,
  LoggingApi,
  MachineApi,
  NetworkApi,
  PermissionsApi,
  PowerApi,
  ProcessApi,
  ProcessInfo as CkProcessInfo,
  ProcessControlApi,
  ProcessEntry,
  SyslogWriteResult,
  UserManagementApi,
} from '@/command-kernel/machine/types';
import { FileSystemError, FileSystemErrorCode } from '@/command-kernel/errors';
import { User } from '@/command-kernel/session/types';
import type { Port } from '@/network/hardware/Port';
import { PathError, type PathActor, type VfsPath } from '../VfsPath';
import type { INode } from '../VirtualFileSystem';
import { VirtualFileSystem } from '../VirtualFileSystem';
import type { LinuxUserManager } from '../LinuxUserManager';
import type { LinuxProcessManager, Signal } from '../LinuxProcessManager';
import type { LinuxLogManager } from '../LinuxLogManager';
import { LinuxUser, resolveLinuxUser } from './LinuxUser';

const NODE_TYPES: Record<INode['type'], FileNodeType> = {
  file: 'file',
  directory: 'directory',
  symlink: 'symlink',
  fifo: 'fifo',
  chardev: 'chardev',
};

export interface LinuxMachineApiDeps {
  readonly vfs: VirtualFileSystem;
  readonly userManager: LinuxUserManager;
  readonly processManager: LinuxProcessManager;
  readonly logManager: LinuxLogManager;
  readonly hostname: string;
  readonly ports: readonly Port[];
  getUmask(): number;
  setUmask(mask: number): void;
  powerOn(): void;
  powerOff(): void;
  publishFsAccess(path: string, perm: 'r' | 'w' | 'x' | 'a', syscall?: string): void;
  publishSyscall(syscall: string, path?: string): void;
}

function toPathActor(actor: FileSystemActor): PathActor {
  return {
    uid: actor.uid,
    gid: actor.gid,
    gids: [...(actor.gids ?? [])],
    user: actor.name,
    groupNames: [...(actor.groupNames ?? [])],
  };
}

class LinuxFileSystemApi implements FileSystemApi {
  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly getUmask: () => number,
    private readonly publishFsAccess: LinuxMachineApiDeps['publishFsAccess'],
  ) {}

  private translate(err: unknown, path: string): never {
    if (err instanceof PathError) {
      throw new FileSystemError(path, err.reason as FileSystemErrorCode, err.message);
    }
    throw err;
  }

  private toStat(path: string, node: INode): FileStat {
    return {
      path,
      type: NODE_TYPES[node.type],
      size: node.size,
      ownerUid: node.uid,
      ownerGid: node.gid,
      mode: node.permissions,
      linkCount: node.linkCount,
      inode: node.id,
      modifiedAt: new Date(node.mtime),
      symlinkTarget: node.type === 'symlink' ? node.target : undefined,
    };
  }

  async readFile(path: string, actor: FileSystemActor): Promise<string> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    try {
      p.assertReadable();
    } catch (err) {
      this.translate(err, path);
    }
    if (p.isDirectory()) {
      throw new FileSystemError(path, 'EISDIR', `${path}: Is a directory`);
    }
    return this.vfs.readFile(p.value) ?? '';
  }

  async writeFile(path: string, content: string, actor: FileSystemActor, append = false): Promise<void> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    if (this.vfs.isReadOnly(p.value)) {
      throw new FileSystemError(path, 'EACCES', `${path}: Read-only file system`);
    }
    if (p.exists() && p.isDirectory()) {
      throw new FileSystemError(path, 'EISDIR', `${path}: Is a directory`);
    }
    if (p.exists()) {
      try {
        p.assertWritable();
      } catch (err) {
        this.translate(err, path);
      }
    } else if (!p.parent().canWrite()) {
      throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
    }
    this.publishFsAccess(path, 'w', 'open');
    const ok = this.vfs.writeFile(p.value, content, actor.uid, actor.gid, this.getUmask(), append);
    if (!ok) throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
  }

  async touch(path: string, actor: FileSystemActor): Promise<void> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    if (!p.exists() && this.vfs.isReadOnly(p.value)) {
      throw new FileSystemError(path, 'EACCES', `${path}: Read-only file system`);
    }
    if (p.exists()) {
      try {
        p.assertWritable();
      } catch (err) {
        this.translate(err, path);
      }
    } else if (!p.parent().canWrite()) {
      throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
    }
    if (!this.vfs.touch(p.value, actor.uid, actor.gid, this.getUmask())) {
      throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
    }
  }

  async list(path: string, actor: FileSystemActor): Promise<FileStat[]> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    try {
      p.assertReadable();
    } catch (err) {
      this.translate(err, path);
    }
    if (!p.isDirectory()) {
      throw new FileSystemError(path, 'ENOTDIR', `${path}: Not a directory`);
    }
    const entries = this.vfs.listDirectory(p.value) ?? [];
    return entries
      .filter((e) => e.name !== '.' && e.name !== '..')
      .map((e) => this.toStat(`${p.value === '/' ? '' : p.value}/${e.name}`, e.inode));
  }

  async stat(path: string, actor: FileSystemActor): Promise<FileStat> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    try {
      p.assertExists();
    } catch (err) {
      this.translate(err, path);
    }
    return this.toStat(p.value, p.inode()!);
  }

  async lstat(path: string, actor: FileSystemActor): Promise<FileStat> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    const node = p.lstatNode();
    if (!node) throw new FileSystemError(path, 'ENOENT', `${path}: No such file or directory`);
    return this.toStat(p.value, node);
  }

  async exists(path: string, actor: FileSystemActor): Promise<boolean> {
    return this.vfs.path(path, '/', toPathActor(actor)).exists();
  }

  private assertStickyRemovable(path: string, p: VfsPath, actor: FileSystemActor): void {
    if (actor.uid === 0) return;
    const parent = p.parent();
    const parentNode = parent.inode();
    if (parentNode && (!parent.canWrite() || !parent.canExecute())) {
      throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
    }
    const node = p.lstatNode();
    const sticky = parentNode !== null && (parentNode.permissions & 0o1000) !== 0;
    if (parentNode && sticky && node && node.uid !== actor.uid && parentNode.uid !== actor.uid) {
      throw new FileSystemError(path, 'EACCES', `${path}: Operation not permitted`);
    }
  }

  async remove(path: string, actor: FileSystemActor, recursive = false): Promise<void> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    try {
      p.assertExists();
    } catch (err) {
      this.translate(err, path);
    }
    if (p.isDirectory() && !recursive) {
      throw new FileSystemError(path, 'EISDIR', `${path}: Is a directory`);
    }
    this.assertStickyRemovable(path, p, actor);
    if (p.isDirectory()) {
      if (!this.vfs.rmrf(p.value)) {
        throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
      }
      return;
    }
    if (!this.vfs.deleteFile(p.value)) {
      throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
    }
  }

  async mkdir(path: string, actor: FileSystemActor, parents = false): Promise<void> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    if (p.exists()) {
      if (parents) return;
      throw new FileSystemError(path, 'EEXIST', `${path}: File exists`);
    }
    const mode = 0o777 & ~this.getUmask();
    if (parents) {
      const segments = p.value.split('/').filter(Boolean);
      let current = '';
      for (const segment of segments) {
        current += `/${segment}`;
        const seg = this.vfs.path(current, '/', toPathActor(actor));
        if (seg.exists()) continue;
        if (!seg.parent().canWrite() && actor.uid !== 0) {
          throw new FileSystemError(current, 'EACCES', `${current}: Permission denied`);
        }
        this.vfs.mkdir(current, mode, actor.uid, actor.gid);
      }
      return;
    }
    if (!p.parent().canWrite()) {
      throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
    }
    if (!this.vfs.mkdir(p.value, mode, actor.uid, actor.gid)) {
      throw new FileSystemError(path, 'ENOENT', `${path}: No such file or directory`);
    }
  }

  async rmdir(path: string, actor: FileSystemActor): Promise<void> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    try {
      p.assertExists();
    } catch (err) {
      this.translate(err, path);
    }
    if (!p.isDirectory()) {
      throw new FileSystemError(path, 'ENOTDIR', `${path}: Not a directory`);
    }
    this.assertStickyRemovable(path, p, actor);
    if (!this.vfs.rmdir(p.value)) {
      throw new FileSystemError(path, 'ENOTEMPTY', `${path}: Directory not empty`);
    }
  }

  async chmod(path: string, mode: number, actor: FileSystemActor): Promise<void> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    try {
      p.assertExists();
    } catch (err) {
      this.translate(err, path);
    }
    if (actor.uid !== 0 && !p.ownedByActor()) {
      throw new FileSystemError(path, 'EACCES', `${path}: Operation not permitted`);
    }
    this.vfs.chmod(p.value, mode);
  }

  async chown(path: string, uid: number, gid: number, actor: FileSystemActor): Promise<void> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    try {
      p.assertExists();
    } catch (err) {
      this.translate(err, path);
    }
    const node = p.inode()!;
    if (actor.uid !== 0) {
      const changingOwner = uid !== node.uid;
      const changingGroup = gid !== node.gid;
      if (changingOwner) {
        throw new FileSystemError(path, 'EACCES', `${path}: Operation not permitted`);
      }
      if (changingGroup && (node.uid !== actor.uid || !(actor.gids ?? []).includes(gid))) {
        throw new FileSystemError(path, 'EACCES', `${path}: Operation not permitted`);
      }
    }
    this.vfs.chown(p.value, uid, gid);
  }

  async copy(source: string, destination: string, actor: FileSystemActor): Promise<void> {
    const src = this.vfs.path(source, '/', toPathActor(actor));
    try {
      src.assertReadable();
    } catch (err) {
      this.translate(err, source);
    }
    const dst = this.vfs.path(destination, '/', toPathActor(actor));
    const targetParent = dst.exists() && dst.isDirectory() ? dst : dst.parent();
    if (!targetParent.canWrite()) {
      throw new FileSystemError(destination, 'EACCES', `${destination}: Permission denied`);
    }
    if (!this.vfs.copy(src.value, dst.value, actor.uid, actor.gid, this.getUmask())) {
      throw new FileSystemError(destination, 'EACCES', `${destination}: Permission denied`);
    }
  }

  async rename(source: string, destination: string, actor: FileSystemActor): Promise<void> {
    const src = this.vfs.path(source, '/', toPathActor(actor));
    try {
      src.assertExists();
    } catch (err) {
      this.translate(err, source);
    }
    if (!src.parent().canWrite()) {
      throw new FileSystemError(source, 'EACCES', `${source}: Permission denied`);
    }
    const dst = this.vfs.path(destination, '/', toPathActor(actor));
    const targetParent = dst.exists() && dst.isDirectory() ? dst : dst.parent();
    if (!targetParent.canWrite()) {
      throw new FileSystemError(destination, 'EACCES', `${destination}: Permission denied`);
    }
    if (!this.vfs.rename(src.value, dst.value)) {
      throw new FileSystemError(destination, 'EACCES', `${destination}: Permission denied`);
    }
  }

  async symlink(target: string, path: string, actor: FileSystemActor): Promise<void> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    if (p.exists()) throw new FileSystemError(path, 'EEXIST', `${path}: File exists`);
    if (!p.parent().canWrite()) {
      throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
    }
    if (!this.vfs.createSymlink(p.value, target, actor.uid, actor.gid)) {
      throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
    }
  }

  async link(targetPath: string, path: string, actor: FileSystemActor): Promise<void> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    if (p.exists()) throw new FileSystemError(path, 'EEXIST', `${path}: File exists`);
    if (!p.parent().canWrite()) {
      throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
    }
    if (!this.vfs.createHardLink(p.value, targetPath)) {
      throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
    }
  }

  async readlink(path: string, actor: FileSystemActor): Promise<string> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    const node = p.lstatNode();
    if (!node) throw new FileSystemError(path, 'ENOENT', `${path}: No such file or directory`);
    if (node.type !== 'symlink') {
      throw new FileSystemError(path, 'EACCES', `${path}: Invalid argument`);
    }
    return node.target;
  }

  resolve(cwd: string, path: string): string {
    return this.vfs.normalizePath(path, cwd);
  }

  async realpath(path: string, actor: FileSystemActor, requireFinal: boolean): Promise<string | null> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    return p.realpath(requireFinal)?.value ?? null;
  }
}

class LinuxProcessApi implements ProcessApi {
  constructor(private readonly processManager: LinuxProcessManager) {}

  async list(): Promise<CkProcessInfo[]> {
    return this.processManager.list().map((p) => ({
      pid: p.pid,
      command: p.command,
      ownerUid: p.uid,
    }));
  }

  async kill(pid: number, signal?: string): Promise<void> {
    this.processManager.kill(pid, (signal as Signal | undefined) ?? 'SIGTERM');
  }

  async spawn(command: string, argv: readonly string[]): Promise<CkProcessInfo> {
    const info = this.processManager.spawn({
      command: [command, ...argv].join(' '),
      user: 'root',
      uid: 0,
      gid: 0,
    });
    return { pid: info.pid, command: info.command, ownerUid: info.uid };
  }
}

class LinuxProcessControlApi implements ProcessControlApi {
  constructor(private readonly processManager: LinuxProcessManager) {}

  list(): readonly ProcessEntry[] {
    return this.processManager.list().map((p) => LinuxProcessControlApi.toEntry(p));
  }

  get(pid: number): ProcessEntry | null {
    const p = this.processManager.get(pid);
    return p ? LinuxProcessControlApi.toEntry(p) : null;
  }

  signal(pid: number, signal: string): boolean {
    return this.processManager.kill(pid, signal as Signal);
  }

  renice(pid: number, nice: number): boolean {
    return this.processManager.renice(pid, nice);
  }

  setSchedPolicy(pid: number, policy: string, rtPriority: number): boolean {
    const p = this.processManager.get(pid);
    if (!p) return false;
    p.schedPolicy = policy;
    p.rtPriority = rtPriority;
    return true;
  }

  setIoClass(pid: number, ioClass: string, ioClassData: number): boolean {
    const p = this.processManager.get(pid);
    if (!p) return false;
    p.ioClass = ioClass;
    p.ioClassData = ioClassData;
    return true;
  }

  setCpuAffinity(pid: number, cpus: readonly number[]): boolean {
    const p = this.processManager.get(pid);
    if (!p) return false;
    p.cpuAffinity = [...cpus];
    return true;
  }

  private static toEntry(p: ReturnType<LinuxProcessManager['get']> & object): ProcessEntry {
    return {
      pid: p.pid,
      ppid: p.ppid,
      pgid: p.pgid,
      uid: p.uid,
      user: p.user,
      comm: p.comm,
      command: p.command,
      state: p.state,
      tty: p.tty,
      nice: p.nice,
      schedPolicy: p.schedPolicy,
      rtPriority: p.rtPriority,
      ioClass: p.ioClass,
      ioClassData: p.ioClassData,
      cpuAffinity: p.cpuAffinity,
    };
  }
}

class LinuxNetworkApi implements NetworkApi {
  constructor(private readonly ports: () => readonly Port[]) {}

  async interfaces(): Promise<{ name: string; ip: string; up: boolean }[]> {
    return this.ports().map((port) => ({
      name: port.getName(),
      ip: port.getIPAddress()?.toString() ?? '',
      up: !port.isAdminDown(),
    }));
  }

  async setInterfaceState(name: string, up: boolean): Promise<void> {
    const port = this.ports().find((p) => p.getName() === name);
    if (!port) throw new Error(`interface introuvable : ${name}`);
    port.setAdminDown(!up);
  }
}

class LinuxUserManagementApi implements UserManagementApi {
  constructor(private readonly userManager: LinuxUserManager) {}

  async findByName(name: string): Promise<User | undefined> {
    const account = this.userManager.getAccount(name);
    return account ? new LinuxUser(account, this.userManager) : undefined;
  }

  async findByUid(uid: number): Promise<User | undefined> {
    const entry = this.userManager.getUserByUid(uid);
    return entry ? this.findByName(entry.username) : undefined;
  }

  async create(name: string, groups: string[]): Promise<User> {
    this.userManager.useradd(name, { m: true, G: groups.join(',') });
    return resolveLinuxUser(this.userManager, name);
  }

  async delete(uid: number): Promise<void> {
    const account = this.userManager.getUserByUid(uid);
    if (account) this.userManager.userdel(account.username, false);
  }
}

class LinuxGroupManagementApi implements GroupManagementApi {
  constructor(private readonly userManager: LinuxUserManager) {}

  async findByGid(gid: number): Promise<GroupInfo | undefined> {
    const entry = this.userManager.getGroupByGid(gid);
    return entry ? { gid: entry.gid, name: entry.name } : undefined;
  }

  async findByName(name: string): Promise<GroupInfo | undefined> {
    const entry = this.userManager.getGroup(name);
    return entry ? { gid: entry.gid, name: entry.name } : undefined;
  }
}

class LinuxAuditApi implements AuditApi {
  constructor(private readonly deps: Pick<LinuxMachineApiDeps, 'publishFsAccess' | 'publishSyscall'>) {}

  fsAccess(path: string, perm: 'r' | 'w' | 'x' | 'a', syscall?: string): void {
    this.deps.publishFsAccess(path, perm, syscall);
  }

  syscall(name: string, path?: string): void {
    this.deps.publishSyscall(name, path);
  }
}

class LinuxLoggingApi implements LoggingApi {
  constructor(private readonly logManager: LinuxLogManager) {}

  writeSyslog(facilityPrioritySpec: string, tag: string, message: string, displayPid: boolean): SyslogWriteResult {
    return this.logManager.writeSyslog(facilityPrioritySpec, tag, message, displayPid);
  }

  kernelBuffer(): readonly KernelMessage[] {
    return this.logManager.kernelBuffer();
  }

  clearKernelBuffer(): void {
    this.logManager.clearKernelBuffer();
  }

  bootTime(): Date {
    return this.logManager.kernelBootTime();
  }
}

class LinuxPermissionsApi implements PermissionsApi {
  constructor(private readonly deps: Pick<LinuxMachineApiDeps, 'getUmask' | 'setUmask'>) {}

  async getUmask(): Promise<number> {
    return this.deps.getUmask();
  }

  async setUmask(mask: number): Promise<void> {
    this.deps.setUmask(mask);
  }
}

class LinuxPowerApi implements PowerApi {
  constructor(private readonly deps: Pick<LinuxMachineApiDeps, 'powerOn' | 'powerOff'>) {}

  async shutdown(_delaySeconds: number): Promise<void> {
    this.deps.powerOff();
  }

  async reboot(): Promise<void> {
    this.deps.powerOff();
    this.deps.powerOn();
  }
}

export class LinuxMachineApi implements MachineApi {
  readonly fs: FileSystemApi;
  readonly proc: ProcessApi;
  readonly processControl: ProcessControlApi;
  readonly net: NetworkApi;
  readonly users: UserManagementApi;
  readonly groups: GroupManagementApi;
  readonly power: PowerApi;
  readonly hostname: string;
  readonly audit: AuditApi;
  readonly logging: LoggingApi;
  readonly permissions: PermissionsApi;

  constructor(deps: LinuxMachineApiDeps) {
    this.fs = new LinuxFileSystemApi(deps.vfs, () => deps.getUmask(), deps.publishFsAccess);
    this.proc = new LinuxProcessApi(deps.processManager);
    this.processControl = new LinuxProcessControlApi(deps.processManager);
    this.net = new LinuxNetworkApi(() => deps.ports);
    this.users = new LinuxUserManagementApi(deps.userManager);
    this.groups = new LinuxGroupManagementApi(deps.userManager);
    this.power = new LinuxPowerApi(deps);
    this.hostname = deps.hostname;
    this.audit = new LinuxAuditApi(deps);
    this.logging = new LinuxLoggingApi(deps.logManager);
    this.permissions = new LinuxPermissionsApi(deps);
  }

  now(): Date {
    return new Date();
  }
}
