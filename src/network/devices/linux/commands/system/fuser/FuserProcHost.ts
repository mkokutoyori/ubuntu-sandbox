import type { Errno } from '../../../../../core/Errno';
import type { INode } from '../../../VirtualFileSystem';
import type { LinuxCommandContext } from '../../LinuxCommandContext';
import type { Signal } from '../../../LinuxProcessManager';
import {
  cwdLinkOf, descriptorsOf, exeLinkOf, rootLinkOf, type ProcessLinkSources,
} from '../../../process/ProcessLinks';
import type {
  FuserFileKind, FuserHost, FuserLinkResult, FuserStat, FuserStatResult, ResolvedAddress,
} from './FuserHost';

const SOCKET_DEVICE = 8;
const PROC_INODE_BASE = 0x10000000;
const PROC_PATH = /^\/proc\/(\d+)(?:\/(cwd|root|exe|fd)(?:\/(\d+))?)?$/;
const SOCKET_TARGET = /^socket:\[(\d+)\]$/;
const SIGNAL_BY_NUMBER: ReadonlyMap<number, Signal> = new Map([
  [1, 'SIGHUP'], [2, 'SIGINT'], [3, 'SIGQUIT'], [9, 'SIGKILL'], [10, 'SIGUSR1'], [12, 'SIGUSR2'], [13, 'SIGPIPE'],
  [14, 'SIGALRM'], [15, 'SIGTERM'], [17, 'SIGCHLD'], [18, 'SIGCONT'], [19, 'SIGSTOP'],
]);
const IGNORED_BY_DEFAULT: ReadonlySet<number> = new Set([17, 23, 28]);
const STOPPING_BY_DEFAULT: ReadonlySet<number> = new Set([20, 21, 22]);
const SIGNAL_LIMIT = 64;

function kindOf(inode: INode, path: string, blockSources: ReadonlySet<string>): FuserFileKind {
  switch (inode.type) {
    case 'file': return 'regular';
    case 'directory': return 'directory';
    case 'symlink': return 'symlink';
    case 'fifo': return 'fifo';
    case 'socket': return 'socket';
    default: return blockSources.has(path) ? 'block' : 'character';
  }
}

export class FuserProcHost implements FuserHost {
  readonly selfPid = -1;
  private readonly sources: ProcessLinkSources;
  private readonly answers: string[];

  constructor(private readonly ctx: LinuxCommandContext, stdin: string | undefined) {
    this.sources = ctx.executor.processLinkSources();
    this.answers = stdin === undefined || stdin === '' ? [] : stdin.replace(/\n$/, '').split('\n');
  }

  private get vfs() { return this.ctx.executor.vfs; }
  private get mounts() { return this.ctx.executor.mountTable; }

  currentDirectory(): string {
    return this.ctx.executor.getCwd();
  }

  private absolute(path: string): string {
    return this.vfs.normalizePath(path, this.currentDirectory());
  }

  private describe(path: string, inode: INode, followed: boolean): FuserStat {
    const blockSources = new Set(this.mounts.list().filter((entry) => entry.source.startsWith('/dev/')).map((entry) => entry.source));
    const real = followed ? this.vfs.realpath(path, '/', true) ?? path : path;
    const kind = kindOf(inode, real, blockSources);
    return {
      device: this.mounts.deviceOf(real),
      inode: inode.id,
      kind,
      rdev: kind === 'block' ? this.mounts.deviceOfSource(real) ?? 0 : 0,
      uid: inode.uid,
      ownerWritable: (inode.permissions & 0o200) !== 0,
    };
  }

  private statVfs(path: string, follow: boolean): FuserStatResult {
    if (path === '') return { errno: 'ENOENT' };
    const absolute = this.absolute(path);
    const inode = this.vfs.resolveInode(absolute, follow);
    return inode === null ? { errno: 'ENOENT' } : this.describe(absolute, inode, follow);
  }

  private procDescriptor(pid: number, fd: number) {
    return descriptorsOf(this.sources, pid).find((candidate) => candidate.fd === fd);
  }

  private procEntry(path: string): { pid: number; part: string | undefined; fd: number | undefined } | null {
    const match = PROC_PATH.exec(path);
    if (match === null) return null;
    return { pid: Number(match[1]), part: match[2], fd: match[3] === undefined ? undefined : Number(match[3]) };
  }

  private procStat(pid: number, inode: number, kind: FuserFileKind, uid: number, writable: boolean): FuserStat {
    return { device: this.mounts.deviceOf('/proc'), inode: PROC_INODE_BASE + pid * 1000 + inode, kind, rdev: 0, uid, ownerWritable: writable };
  }

  stat(path: string): FuserStatResult {
    const entry = this.procEntry(path);
    if (entry === null) return this.statVfs(path, true);
    const subject = this.sources.subject(entry.pid);
    if (subject === undefined) return { errno: 'ENOENT' };
    if (entry.part === undefined) return this.procStat(entry.pid, 0, 'directory', subject.uid, false);
    if (entry.part === 'fd') {
      if (entry.fd === undefined) return this.procStat(entry.pid, 1, 'directory', subject.uid, false);
      const descriptor = this.procDescriptor(entry.pid, entry.fd);
      if (descriptor === undefined) return { errno: 'ENOENT' };
      const socket = SOCKET_TARGET.exec(descriptor.target);
      if (socket !== null) {
        return { device: SOCKET_DEVICE, inode: Number(socket[1]), kind: 'socket', rdev: 0, uid: subject.uid, ownerWritable: true };
      }
      return this.statVfs(descriptor.target, true);
    }
    const target = entry.part === 'cwd' ? cwdLinkOf(this.sources, entry.pid)
      : entry.part === 'root' ? rootLinkOf(this.sources, entry.pid) : exeLinkOf(this.sources, entry.pid);
    return target === null ? { errno: 'ENOENT' } : this.statVfs(target, true);
  }

  lstat(path: string): FuserStatResult {
    const entry = this.procEntry(path);
    if (entry === null) return this.statVfs(path, false);
    const subject = this.sources.subject(entry.pid);
    if (subject === undefined) return { errno: 'ENOENT' };
    if (entry.part === undefined || entry.fd === undefined && entry.part === 'fd') return this.stat(path);
    if (entry.part === 'fd' && entry.fd !== undefined) {
      const descriptor = this.procDescriptor(entry.pid, entry.fd);
      return descriptor === undefined ? { errno: 'ENOENT' } : this.procStat(entry.pid, 100 + entry.fd, 'symlink', subject.uid, descriptor.writable);
    }
    return this.procStat(entry.pid, 10, 'symlink', subject.uid, true);
  }

  readLink(path: string): FuserLinkResult {
    const entry = this.procEntry(path);
    if (entry !== null && entry.part !== undefined && !(entry.part === 'fd' && entry.fd === undefined)) {
      if (this.sources.subject(entry.pid) === undefined) return { errno: 'ENOENT' };
      if (entry.part === 'fd') {
        const descriptor = this.procDescriptor(entry.pid, entry.fd as number);
        return descriptor === undefined ? { errno: 'ENOENT' } : descriptor.target;
      }
      const target = entry.part === 'cwd' ? cwdLinkOf(this.sources, entry.pid)
        : entry.part === 'root' ? rootLinkOf(this.sources, entry.pid) : exeLinkOf(this.sources, entry.pid);
      return target === null ? { errno: 'ENOENT' } : target;
    }
    const absolute = this.absolute(path);
    const inode = this.vfs.resolveInode(absolute, false);
    if (inode === null) return { errno: 'ENOENT' };
    return inode.type === 'symlink' ? this.vfs.linkTarget(inode) : { errno: 'EINVAL' };
  }

  listDirectory(path: string): readonly string[] | null {
    if (path === '/proc') {
      return this.ctx.executor.processMgr.list().map((process) => process.pid).sort((a, b) => a - b).map(String);
    }
    const entry = this.procEntry(path);
    if (entry !== null && entry.part === 'fd' && entry.fd === undefined) {
      if (this.sources.subject(entry.pid) === undefined) return null;
      return descriptorsOf(this.sources, entry.pid).map((descriptor) => String(descriptor.fd));
    }
    return this.vfs.listDirectory(this.absolute(path))?.map((item) => item.name) ?? null;
  }

  readFile(path: string): string | null {
    return this.vfs.readFile(this.absolute(path));
  }

  userName(uid: number): string | null {
    return this.ctx.executor.userMgr.getUserByUid(uid)?.username ?? null;
  }

  socketDevice(): number {
    return SOCKET_DEVICE;
  }

  lookupService(service: string, protocol: 'tcp' | 'udp'): number | null {
    return this.ctx.executor.resolveServicePort(service, protocol);
  }

  lookupHost(host: string): readonly ResolvedAddress[] | null {
    const found: ResolvedAddress[] = [];
    const v6 = this.ctx.net.resolveHostname6Sync(host);
    if (v6 !== null) found.push({ family: 6, address: v6.toString() });
    const v4 = this.ctx.net.resolveHostnameSync(host);
    if (v4 !== null) found.push({ family: 4, address: v4.toString() });
    return found.length === 0 ? null : found;
  }

  kill(pid: number, signal: number): Errno | null {
    const manager = this.ctx.executor.processMgr;
    const target = manager.get(pid);
    if (signal < 0 || signal > SIGNAL_LIMIT) return 'EINVAL';
    if (target === undefined) return 'ESRCH';
    const caller = this.ctx.executor.userMgr.currentUid;
    if (caller !== 0 && caller !== target.uid) return 'EPERM';
    if (signal === 0 || IGNORED_BY_DEFAULT.has(signal)) return null;
    const named = SIGNAL_BY_NUMBER.get(signal) ?? (STOPPING_BY_DEFAULT.has(signal) ? 'SIGSTOP' : 'SIGKILL');
    return manager.kill(pid, named) ? null : 'EPERM';
  }

  readAnswer(): string | null {
    return this.answers.shift() ?? null;
  }
}
