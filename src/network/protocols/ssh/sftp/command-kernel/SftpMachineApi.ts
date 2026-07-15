import {
  FileStat,
  FileSystemActor,
  FileSystemApi,
  GroupManagementApi,
  MachineApi,
  NetworkApi,
  PowerApi,
  ProcessApi,
  SftpChannelApi,
  SftpOpResult,
  SftpRemoteDiskUsage,
  SftpRemoteEntry,
  SftpRemoteStat,
  UserManagementApi,
} from '@/command-kernel/machine/types';
import { FileSystemError } from '@/command-kernel/errors';
import { expandTilde } from '../../SshPureUtils';
import type { SftpDirEntry } from '../ISftpFileSystem';
import type { SftpSession } from '../SftpSession';

class SftpChannelFacade implements SftpChannelApi {
  constructor(private readonly session: SftpSession) {}

  remoteCwd(): string {
    return this.session.getRemoteCwdPath();
  }

  remoteHome(): string {
    return `/home/${this.session.getRemoteUserName()}`;
  }

  cd(path: string): SftpOpResult {
    const resp = this.session.channelRequest({ op: 'cd', path });
    if (!resp.ok) return { ok: false, error: String(resp.error ?? '') };
    if (typeof resp.cwd === 'string') this.session.setRemoteCwdPath(resp.cwd);
    return { ok: true };
  }

  ls(path: string): SftpOpResult<readonly SftpRemoteEntry[]> {
    const resp = this.session.channelRequest({ op: 'ls', path });
    if (!resp.ok) return { ok: false, error: String(resp.error ?? '') };
    return { ok: true, value: (resp.entries as readonly SftpDirEntry[]) ?? [] };
  }

  version(): SftpOpResult<number> {
    const resp = this.session.channelRequest({ op: 'version' });
    if (!resp.ok) return { ok: false, error: String(resp.error ?? '') };
    return { ok: true, value: (resp as { protocolVersion?: number }).protocolVersion ?? 3 };
  }

  private simple(payload: Record<string, unknown>): SftpOpResult {
    const resp = this.session.channelRequest(payload as never);
    return resp.ok ? { ok: true } : { ok: false, error: String(resp.error ?? '') };
  }

  mkdir(path: string): SftpOpResult { return this.simple({ op: 'mkdir', path }); }
  rm(path: string): SftpOpResult { return this.simple({ op: 'rm', path }); }
  rmdir(path: string): SftpOpResult { return this.simple({ op: 'rmdir', path }); }
  rename(source: string, destination: string): SftpOpResult { return this.simple({ op: 'rename', src: source, dst: destination }); }
  chmod(path: string, mode: number): SftpOpResult { return this.simple({ op: 'chmod', path, mode }); }
  chown(path: string, uid: number, gid: number): SftpOpResult { return this.simple({ op: 'chown', path, uid, gid }); }

  stat(path: string): SftpOpResult<SftpRemoteStat> {
    const resp = this.session.channelRequest({ op: 'stat', path });
    if (!resp.ok) return { ok: false, error: String(resp.error ?? '') };
    const a = resp as unknown as SftpRemoteStat;
    return { ok: true, value: { mode: a.mode, uid: a.uid, gid: a.gid, size: a.size, mtime: a.mtime } };
  }

  df(path: string): SftpOpResult<SftpRemoteDiskUsage> {
    const resp = this.session.channelRequest({ op: 'df', path });
    if (!resp.ok) return { ok: false, error: String(resp.error ?? '') };
    const a = resp as unknown as SftpRemoteDiskUsage;
    return { ok: true, value: { totalBytes: a.totalBytes, usedBytes: a.usedBytes, availableBytes: a.availableBytes } };
  }

  download(remotePath: string, localPath?: string): string {
    return this.session.get(remotePath, localPath);
  }

  upload(localPath: string, remotePath?: string): string {
    return this.session.put(localPath, remotePath);
  }
}

const UNSUPPORTED = (path: string): never => {
  throw new FileSystemError(path, 'EACCES', `${path}: opération non prise en charge par le shell sftp local`);
};

/**
 * Vue locale du shell sftp : les commandes l* travaillent sur le VFS de la
 * machine cliente via le contrat `ISshLocalFs` (le même objet réel que les
 * transferts) — seules les opérations que sftp expose localement sont
 * implémentées, le reste échoue en erreur métier explicite.
 */
class SftpLocalFileSystemApi implements FileSystemApi {
  constructor(private readonly session: SftpSession) {}

  private fs() { return this.session.localFs(); }

  resolve(cwd: string, path: string): string {
    return this.fs().normalizePath(expandTilde(path, this.session.localOwner().home), cwd);
  }

  private statOf(path: string): FileStat {
    const inode = this.fs().resolveInode(path);
    if (!inode) throw new FileSystemError(path, 'ENOENT', `${path}: No such file or directory`);
    return {
      path,
      type: inode.type,
      size: this.fs().readFile(path)?.length ?? 0,
      ownerUid: this.session.localOwner().uid,
      ownerGid: this.session.localOwner().gid,
      mode: inode.type === 'directory' ? 0o755 : 0o644,
      linkCount: 1,
      inode: 0,
      modifiedAt: new Date(),
    };
  }

  async stat(path: string): Promise<FileStat> { return this.statOf(path); }
  async lstat(path: string): Promise<FileStat> { return this.statOf(path); }
  async exists(path: string): Promise<boolean> { return this.fs().resolveInode(path) !== null; }

  async list(path: string): Promise<FileStat[]> {
    const entries = this.fs().listDirectory(path);
    if (!entries) throw new FileSystemError(path, 'ENOENT', `${path}: No such file or directory`);
    return entries
      .filter((e) => e.name !== '.' && e.name !== '..')
      .map((e) => ({
        path: `${path.replace(/\/$/, '')}/${e.name}`,
        type: e.inode.type,
        size: 0,
        ownerUid: this.session.localOwner().uid,
        ownerGid: this.session.localOwner().gid,
        mode: e.inode.type === 'directory' ? 0o755 : 0o644,
        linkCount: 1,
        inode: 0,
        modifiedAt: new Date(),
      }));
  }

  async readFile(path: string): Promise<string> {
    const content = this.fs().readFile(path);
    if (content === null) throw new FileSystemError(path, 'ENOENT', `${path}: No such file or directory`);
    return content;
  }

  async writeFile(path: string, content: string, _actor: FileSystemActor, append?: boolean): Promise<void> {
    const { uid, gid } = this.session.localOwner();
    if (!this.fs().writeFile(path, content, uid, gid, 0o022, append)) {
      throw new FileSystemError(path, 'EACCES', `${path}: Permission denied`);
    }
  }

  async mkdir(path: string): Promise<void> {
    const { uid, gid } = this.session.localOwner();
    if (!this.fs().mkdir(path, 0o755, uid, gid)) {
      throw new FileSystemError(path, 'EEXIST', `${path}: File exists or parent missing`);
    }
  }

  async touch(path: string, actor: FileSystemActor): Promise<void> { await this.writeFile(path, '', actor); }
  async remove(path: string): Promise<void> { UNSUPPORTED(path); }
  async rmdir(path: string): Promise<void> { UNSUPPORTED(path); }
  async chmod(path: string, mode: number): Promise<void> {
    if (!this.fs().chmod(path, mode)) throw new FileSystemError(path, 'ENOENT', `${path}: No such file or directory`);
  }
  async chown(path: string): Promise<void> { UNSUPPORTED(path); }
  async copy(source: string): Promise<void> { UNSUPPORTED(source); }
  async rename(source: string): Promise<void> { UNSUPPORTED(source); }
  async symlink(_target: string, path: string): Promise<void> { UNSUPPORTED(path); }
  async readlink(path: string): Promise<string> { return UNSUPPORTED(path); }
  async link(_target: string, path: string): Promise<void> { UNSUPPORTED(path); }
}

const EMPTY_PROC: ProcessApi = {
  async list() { return []; },
} as unknown as ProcessApi;

const EMPTY_NET: NetworkApi = {
  async interfaces() { return []; },
  async setInterfaceState() { /* pas d'interface dans un shell sftp */ },
};

const EMPTY_USERS: UserManagementApi = {
  async findByName() { return undefined; },
  async findByUid() { return undefined; },
} as unknown as UserManagementApi;

const EMPTY_GROUPS: GroupManagementApi = {
  async findByName() { return undefined; },
  async findByGid() { return undefined; },
} as unknown as GroupManagementApi;

const EMPTY_POWER: PowerApi = {
  async shutdown() { /* pas de cycle de vie machine dans un shell sftp */ },
  async reboot() { /* idem */ },
} as unknown as PowerApi;

export class SftpMachineApi implements MachineApi {
  readonly fs: FileSystemApi;
  readonly sftp: SftpChannelApi;
  readonly proc = EMPTY_PROC;
  readonly net = EMPTY_NET;
  readonly users = EMPTY_USERS;
  readonly groups = EMPTY_GROUPS;
  readonly power = EMPTY_POWER;
  readonly hostname: string;

  constructor(session: SftpSession) {
    this.fs = new SftpLocalFileSystemApi(session);
    this.sftp = new SftpChannelFacade(session);
    this.hostname = 'sftp';
  }

  now(): Date {
    return new Date();
  }
}
