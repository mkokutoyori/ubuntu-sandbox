/**
 * VfsSftpFileSystem — adapts the simulator's VirtualFileSystem to
 * ISftpFileSystem.
 *
 * The adapter is the only seam between the SFTP/SCP layer and a Linux
 * VFS: everything else (SftpInteractiveSession, ScpTransfer) speaks
 * ISftpFileSystem and can therefore run unchanged against any future
 * file system (Windows NTFS, Cisco flash:, …) by writing a new adapter.
 */

import type {
  ISftpFileSystem, SftpDirEntry, SftpFileAttrs, EntryType,
} from './ISftpFileSystem';
import { ok, err, type Result, type SshError } from '../Result';

interface VfsLike {
  normalizePath(path: string, cwd?: string): string;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  isFile(path: string): boolean;
  resolveInode(path: string, followSymlinks?: boolean): {
    type: string; permissions: number; uid: number; gid: number; size: number; mtime: number;
    children?: Map<string, number>;
  } | null;
  readFile(path: string): string | null;
  writeFile(path: string, content: string, uid: number, gid: number, umask: number): boolean | void;
  mkdirp?(path: string, perm: number, uid: number, gid: number): boolean;
  mkdir?(path: string, perm: number, uid: number, gid: number): boolean;
  rmdir?(path: string): boolean;
  unlink?(path: string): boolean;
  deleteFile?(path: string): boolean;
  rename?(src: string, dst: string): boolean;
  chmod?(path: string, mode: number): boolean;
  chown?(path: string, uid: number, gid?: number): boolean;
  listDirectory?(path: string): Array<{ name: string }>;
  checkAclAccess?(path: string, user: string, groups: readonly string[], need: number): boolean | null;
  hasAcl?(path: string): boolean;
}

export class VfsSftpFileSystem implements ISftpFileSystem {
  constructor(
    private readonly vfs: VfsLike,
    private readonly defaults: { uid: number; gid: number; umask: number },
  ) {}

  normalizePath(path: string, cwd: string): string {
    return this.vfs.normalizePath(path, cwd);
  }

  exists(path: string): boolean {
    return this.vfs.exists(path);
  }

  getEntryType(path: string): EntryType | null {
    const inode = this.vfs.resolveInode(path, true);
    if (!inode) return null;
    if (inode.type === 'directory') return 'directory';
    if (inode.type === 'symlink')   return 'symlink';
    return 'file';
  }

  readFile(path: string): Result<string> {
    const data = this.vfs.readFile(path);
    return data === null
      ? err({ kind: 'IO_ERROR', message: `${path}: No such file or directory` } as SshError)
      : ok(data);
  }

  listDirectory(path: string): Result<readonly SftpDirEntry[]> {
    const inode = this.vfs.resolveInode(path, true);
    if (!inode) return err({ kind: 'IO_ERROR', message: `${path}: No such directory` } as SshError);
    if (inode.type !== 'directory') return err({ kind: 'IO_ERROR', message: `${path}: Not a directory` } as SshError);
    const entries: SftpDirEntry[] = [];
    const children = inode.children ?? new Map<string, number>();
    for (const [name] of children) {
      if (name === '.' || name === '..') continue;
      const child = this.vfs.resolveInode(`${path.replace(/\/$/, '')}/${name}`, true);
      if (!child) continue;
      entries.push({
        name,
        type: child.type === 'directory' ? 'directory' : child.type === 'symlink' ? 'symlink' : 'file',
        mode: child.permissions,
        uid: child.uid,
        gid: child.gid,
        size: child.size,
        mtime: child.mtime,
      });
    }
    return ok(Object.freeze(entries));
  }

  stat(path: string): Result<SftpFileAttrs> {
    const inode = this.vfs.resolveInode(path, true);
    if (!inode) return err({ kind: 'IO_ERROR', message: `${path}: No such file or directory` } as SshError);
    return ok({
      type: inode.type === 'directory' ? 'directory' : inode.type === 'symlink' ? 'symlink' : 'file',
      mode: inode.permissions, uid: inode.uid, gid: inode.gid, size: inode.size, mtime: inode.mtime,
    });
  }

  writeFile(path: string, content: string): Result<void> {
    try {
      this.vfs.writeFile(path, content, this.defaults.uid, this.defaults.gid, this.defaults.umask);
      return ok(undefined);
    } catch (e) {
      return err({ kind: 'IO_ERROR', message: e instanceof Error ? e.message : 'write failed' } as SshError);
    }
  }

  mkdir(path: string): Result<void> {
    if (!this.vfs.mkdir) return err({ kind: 'IO_ERROR', message: 'mkdir not supported' } as SshError);
    if (this.entryType(path) !== null) {
      return err({ kind: 'IO_ERROR', message: `${path}: File exists` } as SshError);
    }
    const parent = path.replace(/\/[^/]+\/?$/, '') || '/';
    if (parent !== path && this.entryType(parent) === null) {
      return err({ kind: 'IO_ERROR', message: `${path}: No such file or directory` } as SshError);
    }
    if (this.vfs.mkdir(path, 0o755, this.defaults.uid, this.defaults.gid)) return ok(undefined);
    return err({ kind: 'IO_ERROR', message: `${path}: Permission denied` } as SshError);
  }

  deleteFile(path: string): Result<void> {
    const type = this.entryType(path);
    if (type === null) return err({ kind: 'IO_ERROR', message: `${path}: No such file or directory` } as SshError);
    if (type === 'directory') return err({ kind: 'IO_ERROR', message: `${path}: Is a directory` } as SshError);
    if (this.vfs.unlink     && this.vfs.unlink(path))      return ok(undefined);
    if (this.vfs.deleteFile && this.vfs.deleteFile(path))  return ok(undefined);
    return err({ kind: 'IO_ERROR', message: `${path}: Permission denied` } as SshError);
  }

  rmdir(path: string): Result<void> {
    if (!this.vfs.rmdir) return err({ kind: 'IO_ERROR', message: 'rmdir not supported' } as SshError);
    const type = this.entryType(path);
    if (type === null)       return err({ kind: 'IO_ERROR', message: `${path}: No such file or directory` } as SshError);
    if (type !== 'directory') return err({ kind: 'IO_ERROR', message: `${path}: Not a directory` } as SshError);
    if (!this.isEmptyDir(path)) return err({ kind: 'IO_ERROR', message: `${path}: Directory not empty` } as SshError);
    if (this.vfs.rmdir(path)) return ok(undefined);
    return err({ kind: 'IO_ERROR', message: `${path}: Permission denied` } as SshError);
  }

  rename(src: string, dst: string): Result<void> {
    if (!this.vfs.rename) return err({ kind: 'IO_ERROR', message: 'rename not supported' } as SshError);
    if (this.entryType(src) === null) return err({ kind: 'IO_ERROR', message: `${src}: No such file or directory` } as SshError);
    if (this.entryType(dst) !== null) return err({ kind: 'IO_ERROR', message: `${dst}: File exists` } as SshError);
    if (this.vfs.rename(src, dst)) return ok(undefined);
    return err({ kind: 'IO_ERROR', message: `${src}: rename failed` } as SshError);
  }

  setPermissions(path: string, mode: number): Result<void> {
    if (!this.vfs.chmod) return err({ kind: 'IO_ERROR', message: 'chmod not supported' } as SshError);
    if (this.entryType(path) === null) return err({ kind: 'IO_ERROR', message: `${path}: No such file or directory` } as SshError);
    if (this.vfs.chmod(path, mode)) return ok(undefined);
    return err({ kind: 'IO_ERROR', message: `${path}: chmod failed` } as SshError);
  }

  private entryType(path: string): 'file' | 'directory' | 'symlink' | null {
    return this.getEntryType(path);
  }

  /** Returns the ACL verdict for `user` on `path` or null when no ACL applies. */
  checkAclAccess(path: string, user: string, groups: readonly string[], need: number): boolean | null {
    return this.vfs.checkAclAccess?.(path, user, groups, need) ?? null;
  }

  /** True iff `path` carries any explicit ACL entry. */
  hasAcl(path: string): boolean {
    return this.vfs.hasAcl?.(path) ?? false;
  }

  private isEmptyDir(path: string): boolean {
    const r = this.listDirectory(path);
    return r.ok && r.value.filter(e => e.name !== '.' && e.name !== '..').length === 0;
  }

  setOwner(path: string, uid: number, gid: number): Result<void> {
    if (!this.vfs.chown) return err({ kind: 'IO_ERROR', message: 'chown not supported' } as SshError);
    return this.vfs.chown(path, uid, gid)
      ? ok(undefined)
      : err({ kind: 'IO_ERROR', message: `${path}: chown failed` } as SshError);
  }
}
