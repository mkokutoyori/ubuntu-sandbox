import {
  AuditApi,
  FileNodeType,
  IcmpEchoReply,
  FileStat,
  FileSystemActor,
  FileSystemApi,
  GroupInfo,
  GroupManagementApi,
  JournalRecord,
  KernelMessage,
  LoggingApi,
  MachineApi,
  MemorySnapshot,
  CpuInfo,
  OsIdentity,
  SystemMetricsApi,
  NetworkApi,
  NetProbeApi,
  PermissionsApi,
  PosixUseraddSpec,
  PosixGecosFields,
  TracerouteHopInfo,
  PowerApi,
  ProcessApi,
  ProcessInfo as CkProcessInfo,
  ProcessControlApi,
  ProcessEntry,
  SftpBatchLineResult,
  SftpConnectApi,
  SftpConnectResult,
  SyslogWriteResult,
  UserManagementApi,
} from '@/command-kernel/machine/types';
import { CommandNotFoundError, FileSystemError, FileSystemErrorCode } from '@/command-kernel/errors';
import { ExitRequest } from '@/command-kernel/shell/exit';
import { User } from '@/command-kernel/session/types';
import type { Port } from '@/network/hardware/Port';
import { PathError, type PathActor, type VfsPath } from '../VfsPath';
import type { INode } from '../VirtualFileSystem';
import { VirtualFileSystem } from '../VirtualFileSystem';
import type { LinuxUserManager } from '../LinuxUserManager';
import type { LinuxProcessManager, Signal } from '../LinuxProcessManager';
import type { LinuxLogManager } from '../LinuxLogManager';
import type { LinuxNetKernel } from '../LinuxNetKernel';
import { IPAddress, IPv6Address } from '@/network/core/types';
import { LinuxUser, resolveLinuxUser } from './LinuxUser';
import { SftpSession } from '@/network/protocols/ssh/sftp/SftpSession';
import { SilentSshInteractionHandler } from '@/network/protocols/ssh/session/ISshInteractionHandler';
import { createSftpShell } from '@/network/protocols/ssh/sftp/command-kernel/createSftpShell';
import { normalizeSftpVerbCase, runSftpLine } from '@/network/protocols/ssh/sftp/command-kernel/runSftpLine';
import type { TcpConnector } from '@/network/tcp/types';

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
  /** Instantané mémoire live (`free`/`vmstat`/`top`) — absent sur les vendeurs sans profil mémoire. */
  memoryProfile?(): MemorySnapshot;
  /** Informations processeur (`mpstat`/`iostat`/`pidstat`) — absent sans profil matériel. */
  cpuInfo?(): CpuInfo;
  /** Identité du système d'exploitation (`uname`, bannières sysstat) — absent sans identité. */
  osIdentity?(): OsIdentity;
  getUmask(): number;
  setUmask(mask: number): void;
  powerOn(): void;
  powerOff(): void;
  publishFsAccess(path: string, perm: 'r' | 'w' | 'x' | 'a', syscall?: string): void;
  publishSyscall(syscall: string, path?: string): void;
  readonly netKernel?: LinuxNetKernel;
  neighborMac?(ip: string): string | null;
  topologyMtus?(): readonly number[];
  reverseLookup?(ip: string): string | null;
  udpRangeDenied?(startPort: number, endPort: number): boolean;
  createSkeleton?(username: string): void;
  /** Ouvre une vraie connexion TCP sortante depuis cet équipement (`sftp` lanceur) — absent sur les vendeurs sans pile TCP cliente. */
  tcpConnect?(host: string, port: number): Promise<unknown>;
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

  watchWrites(path: string, cb: (current: string) => void): () => void {
    return this.vfs.onWrite(path, (event) => cb(event.current));
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

class LinuxNetProbeApi implements NetProbeApi {
  constructor(
    private readonly kernel: LinuxNetKernel,
    private readonly ports: () => readonly Port[],
    private readonly deps: Pick<LinuxMachineApiDeps, 'neighborMac' | 'topologyMtus' | 'reverseLookup' | 'udpRangeDenied'>,
  ) {}

  async resolveHostname(name: string): Promise<string | null> {
    const ip = await this.kernel.resolveHostname(name);
    return ip ? ip.toString() : null;
  }

  hasRoute(ip: string): boolean {
    try {
      return this.kernel.hasRoute(new IPAddress(ip));
    } catch {
      return false;
    }
  }

  async echoSequence(targetIp: string, count: number, timeoutMs?: number, ttl?: number): Promise<readonly IcmpEchoReply[]> {
    return this.kernel.pingSequence(new IPAddress(targetIp), count, timeoutMs, ttl);
  }

  async echo6Sequence(target6: string, count: number, timeoutMs?: number): Promise<{ readonly target: string; readonly replies: readonly IcmpEchoReply[] } | null> {
    let target: IPv6Address;
    try {
      target = new IPv6Address(target6);
    } catch {
      return null;
    }
    const replies = await this.kernel.ping6Sequence(target, count, timeoutMs);
    return { target: target.toString(), replies };
  }

  interfaceDetails(): readonly { name: string; up: boolean; mtu: number }[] {
    return this.ports().map((port) => ({
      name: port.getName(),
      up: port.getIsUp(),
      mtu: port.getMTU(),
    }));
  }

  topologyMtus(): readonly number[] {
    return this.deps.topologyMtus?.() ?? [];
  }

  neighborMac(ip: string): string | null {
    return this.deps.neighborMac?.(ip) ?? null;
  }

  async traceroute(targetIp: string, maxHops?: number, probesPerHop?: number, firstTtl?: number, timeoutMs?: number): Promise<readonly TracerouteHopInfo[]> {
    return this.kernel.traceroute(new IPAddress(targetIp), maxHops, probesPerHop, firstTtl, timeoutMs);
  }

  sendUdpProbe(targetIp: string, destinationPort: number, sourcePort: number): boolean {
    try {
      return this.kernel.sendUdpProbe(new IPAddress(targetIp), destinationPort, sourcePort);
    } catch {
      return false;
    }
  }

  defaultGateway(): string | null {
    return this.kernel.getDefaultGateway()?.toString() ?? null;
  }

  reverseLookup(ip: string): string | null {
    return this.deps.reverseLookup?.(ip) ?? null;
  }

  udpRangeDeniedByTopology(startPort: number, endPort: number): boolean {
    return this.deps.udpRangeDenied?.(startPort, endPort) ?? false;
  }

}

class LinuxUserManagementApi implements UserManagementApi {
  constructor(
    private readonly userManager: LinuxUserManager,
    private readonly createSkeleton?: (username: string) => void,
  ) {}

  posixUseradd(name: string, spec: PosixUseraddSpec): string {
    return this.userManager.useradd(name, {
      m: spec.createHome,
      M: spec.noCreateHome,
      s: spec.shell,
      G: spec.supplementaryGroups && spec.supplementaryGroups.length > 0 ? spec.supplementaryGroups.join(',') : undefined,
      d: spec.home,
      g: spec.primaryGroup,
      c: spec.comment,
      u: spec.uid,
      o: spec.nonUnique,
      r: spec.system,
      N: spec.noUserGroup,
      p: spec.passwordHash,
      e: spec.expireDays,
      f: spec.inactiveDays,
    });
  }

  createHomeSkeleton(username: string): void {
    this.createSkeleton?.(username);
  }

  posixAccountInfo(name: string): { uid: number; gid: number; home: string } | undefined {
    const account = this.userManager.getUser(name);
    return account ? { uid: account.uid, gid: account.gid, home: account.home } : undefined;
  }

  primaryGroupName(name: string): string | undefined {
    const account = this.userManager.getUser(name);
    return account ? this.userManager.gidToName(account.gid) : undefined;
  }

  appendToGroup(name: string, group: string): void {
    this.userManager.usermod(name, { aG: group });
  }

  posixSetPassword(name: string, password: string): void {
    this.userManager.setPassword(name, password);
  }

  posixSetGecos(name: string, fields: PosixGecosFields): void {
    this.userManager.setUserGecos(name, fields.fullName, fields.room, fields.workPhone, fields.homePhone, fields.other);
  }

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

  posixGroupadd(name: string, gid?: number): string {
    return this.userManager.groupadd(name, { g: gid });
  }

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

  journalActive(): boolean {
    return this.logManager.journalActive();
  }

  journalEntries(): readonly JournalRecord[] {
    return this.logManager.journalEntries();
  }

  bootId(): string {
    return this.logManager.journalBootId();
  }

  followKernel(
    opts: { raw?: boolean; humanTime?: boolean; levelFilter?: readonly string[] },
    listener: (line: string) => void,
  ): () => void {
    return this.logManager.followDmesg(opts, listener);
  }

  followJournal(
    opts: { unit?: string; priority?: number; pid?: number },
    listener: (line: string) => void,
  ): () => void {
    return this.logManager.followJournal(opts, listener);
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

/**
 * Ouverture d'une connexion sftp cliente réelle (`sftp` lanceur, framework
 * §14.6 Push C) — construit et connecte une VRAIE `SftpSession` (SSH + canal
 * SFTP, trames à travers Equipment/Port/Cable), exactement comme le faisait
 * l'ancien `connectAndEnterSftp` legacy. `runLine`/`prompt`/`disconnect` du
 * résultat retour délèguent au même shell command-kernel sftp que le
 * sous-shell interactif (`createSftpShell` + `runSftpLine`, jamais une
 * seconde implémentation) — seule la politique du fichier de batch reste
 * portée par `SftpLauncherCommand`.
 */
class LinuxSftpConnectApi implements SftpConnectApi {
  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly userManager: LinuxUserManager,
    private readonly tcpConnect: (host: string, port: number) => Promise<unknown>,
  ) {}

  async connect(
    userAtHost: string,
    password: string,
    opts: { readonly port?: number; readonly localCwd: string },
  ): Promise<SftpConnectResult> {
    const currentUser = this.userManager.currentUser;
    const account = this.userManager.getUser(currentUser);
    const home = account?.home ?? `/home/${currentUser}`;
    const session = new SftpSession({
      tcpConnector: (host, port) => this.tcpConnect(host, port) as ReturnType<TcpConnector>,
      localVfs: this.vfs as never,
      localUser: currentUser,
      localUid: account?.uid ?? 1000,
      localGid: account?.gid ?? 1000,
      localCwd: opts.localCwd,
      knownHostsPath: `${home}/.ssh/known_hosts`,
      interactionHandler: new SilentSshInteractionHandler(password),
      homeDirectory: home,
    });

    const banner = await session.connect(userAtHost, { password, port: opts.port });
    if (!session.isConnected()) return { ok: false, banner };

    const shell = createSftpShell(session);
    return {
      ok: true,
      banner,
      handle: session,
      prompt: session.getPrompt(),
      runLine: async (line: string): Promise<SftpBatchLineResult> => {
        const verb = normalizeSftpVerbCase(line.trim());
        if (!verb) return { output: [''], exit: false };
        try {
          const text = await runSftpLine(shell, session, verb);
          return { output: text.split('\n'), exit: false };
        } catch (err) {
          if (err instanceof ExitRequest) {
            session.disconnect();
            return { output: [''], exit: true };
          }
          if (err instanceof CommandNotFoundError) {
            return { output: ['Invalid command.'], exit: false };
          }
          throw err;
        }
      },
      disconnect: () => session.disconnect(),
    };
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

class LinuxSystemMetricsApi implements SystemMetricsApi {
  constructor(
    private readonly memoryProfile: () => MemorySnapshot,
    private readonly cpuProfile: () => CpuInfo,
  ) {}

  memory(): MemorySnapshot {
    return this.memoryProfile();
  }

  cpu(): CpuInfo {
    return this.cpuProfile();
  }
}

export class LinuxMachineApi implements MachineApi {
  readonly fs: FileSystemApi;
  readonly proc: ProcessApi;
  readonly processControl: ProcessControlApi;
  readonly net: NetworkApi;
  readonly netProbe?: NetProbeApi;
  readonly sftpConnect?: SftpConnectApi;
  readonly users: UserManagementApi;
  readonly groups: GroupManagementApi;
  readonly power: PowerApi;
  readonly hostname: string;
  readonly audit: AuditApi;
  readonly logging: LoggingApi;
  readonly metrics?: SystemMetricsApi;
  readonly os?: OsIdentity;
  readonly permissions: PermissionsApi;

  constructor(deps: LinuxMachineApiDeps) {
    this.fs = new LinuxFileSystemApi(deps.vfs, () => deps.getUmask(), deps.publishFsAccess);
    this.proc = new LinuxProcessApi(deps.processManager);
    this.processControl = new LinuxProcessControlApi(deps.processManager);
    this.net = new LinuxNetworkApi(() => deps.ports);
    if (deps.netKernel) {
      this.netProbe = new LinuxNetProbeApi(deps.netKernel, () => deps.ports, deps);
    }
    if (deps.tcpConnect) {
      this.sftpConnect = new LinuxSftpConnectApi(deps.vfs, deps.userManager, deps.tcpConnect);
    }
    this.users = new LinuxUserManagementApi(deps.userManager, deps.createSkeleton);
    this.groups = new LinuxGroupManagementApi(deps.userManager);
    this.power = new LinuxPowerApi(deps);
    this.hostname = deps.hostname;
    this.audit = new LinuxAuditApi(deps);
    this.logging = new LinuxLoggingApi(deps.logManager);
    if (deps.memoryProfile && deps.cpuInfo) {
      const mem = deps.memoryProfile;
      const cpu = deps.cpuInfo;
      this.metrics = new LinuxSystemMetricsApi(() => mem(), () => cpu());
    }
    if (deps.osIdentity) this.os = deps.osIdentity();
    this.permissions = new LinuxPermissionsApi(deps);
  }

  now(): Date {
    return new Date();
  }
}
