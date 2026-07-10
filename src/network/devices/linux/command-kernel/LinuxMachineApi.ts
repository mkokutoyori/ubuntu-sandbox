import {
  FileNodeType,
  FileStat,
  FileSystemActor,
  FileSystemApi,
  GroupInfo,
  GroupManagementApi,
  MachineApi,
  NetworkApi,
  PowerApi,
  ProcessApi,
  ProcessInfo as CkProcessInfo,
  UserManagementApi,
} from '@/command-kernel/machine/types';
import { FileSystemError, FileSystemErrorCode } from '@/command-kernel/errors';
import { User } from '@/command-kernel/session/types';
import type { Port } from '@/network/hardware/Port';
import { PathError, type PathActor } from '../VfsPath';
import type { INode } from '../VirtualFileSystem';
import { VirtualFileSystem } from '../VirtualFileSystem';
import type { LinuxUserManager } from '../LinuxUserManager';
import type { LinuxProcessManager, Signal } from '../LinuxProcessManager';
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
  readonly hostname: string;
  readonly ports: readonly Port[];
  getUmask(): number;
  powerOn(): void;
  powerOff(): void;
}

function toPathActor(actor: FileSystemActor): PathActor {
  return { uid: actor.uid, gid: actor.gid, gids: [...(actor.gids ?? [])] };
}

class LinuxFileSystemApi implements FileSystemApi {
  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly getUmask: () => number,
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
    const ok = this.vfs.writeFile(p.value, content, actor.uid, actor.gid, this.getUmask(), append);
    if (!ok) throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
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

  async remove(path: string, actor: FileSystemActor, recursive = false): Promise<void> {
    const p = this.vfs.path(path, '/', toPathActor(actor));
    try {
      p.assertExists();
    } catch (err) {
      this.translate(err, path);
    }
    if (!p.parent().canWrite()) {
      throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
    }
    if (p.isDirectory()) {
      if (!recursive) throw new FileSystemError(path, 'EISDIR', `${path}: Is a directory`);
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
    if (actor.uid !== 0) {
      throw new FileSystemError(path, 'EACCES', `${path}: Operation not permitted`);
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
  readonly net: NetworkApi;
  readonly users: UserManagementApi;
  readonly groups: GroupManagementApi;
  readonly power: PowerApi;
  readonly hostname: string;

  constructor(deps: LinuxMachineApiDeps) {
    this.fs = new LinuxFileSystemApi(deps.vfs, () => deps.getUmask());
    this.proc = new LinuxProcessApi(deps.processManager);
    this.net = new LinuxNetworkApi(() => deps.ports);
    this.users = new LinuxUserManagementApi(deps.userManager);
    this.groups = new LinuxGroupManagementApi(deps.userManager);
    this.power = new LinuxPowerApi(deps);
    this.hostname = deps.hostname;
  }

  now(): Date {
    return new Date();
  }
}
