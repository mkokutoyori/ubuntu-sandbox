/**
 * LinuxSftpFSAdapter — Adapter from VirtualFileSystem (Linux) to ISftpFileSystem.
 *
 * Translates the existing inode-based VFS API into the Result-based contract
 * expected by the SSH/SFTP layer. No permission checks here: those live in
 * PermissionCheckingFSDecorator.
 *
 * Reference: DESIGN-SSH-SFTP.md section 9.
 */

import type {
  DirEntry,
  INode,
  VirtualFileSystem,
} from '@/network/devices/linux/VirtualFileSystem';
import { type Result, err, ok } from '../Result';
import type {
  EntryType,
  ISftpFileSystem,
  SftpDirEntry,
  SftpFileAttrs,
} from './ISftpFileSystem';

const DEFAULT_FILE_PERMS = 0o644;
const DEFAULT_DIR_PERMS = 0o755;
const DEFAULT_UMASK = 0o022;

export class LinuxSftpFSAdapter implements ISftpFileSystem {
  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly defaultUid: number,
    private readonly defaultGid: number,
  ) {}

  // ── ISftpNavigable ─────────────────────────────────────────────────

  normalizePath(path: string, cwd: string): string {
    return this.vfs.normalizePath(path, cwd);
  }

  exists(path: string): boolean {
    return this.vfs.exists(path);
  }

  getEntryType(path: string): EntryType | null {
    const ft = this.vfs.getType(path, /* followSymlinks */ false);
    if (ft === null) return null;
    return mapFileType(ft);
  }

  // ── ISftpReadable ──────────────────────────────────────────────────

  readFile(path: string): Result<string> {
    const inode = this.vfs.lstat(path);
    if (!inode) return err({ kind: 'IO_ERROR', message: `${path}: no such file` });
    if (inode.type === 'directory') {
      return err({ kind: 'IO_ERROR', message: `${path}: is a directory` });
    }
    const content = this.vfs.readFile(path);
    if (content === null) {
      return err({ kind: 'IO_ERROR', message: `${path}: cannot read` });
    }
    return ok(content);
  }

  listDirectory(path: string): Result<readonly SftpDirEntry[]> {
    const entries = this.vfs.listDirectory(path);
    if (entries === null) {
      return err({
        kind: 'IO_ERROR',
        message: `${path}: not a directory or missing`,
      });
    }
    return ok(entries.map(toDirEntry));
  }

  stat(path: string): Result<SftpFileAttrs> {
    const inode = this.vfs.lstat(path);
    if (!inode) return err({ kind: 'IO_ERROR', message: `${path}: no such file` });
    return ok(toFileAttrs(inode));
  }

  // ── ISftpWritable ──────────────────────────────────────────────────

  writeFile(path: string, content: string): Result<void> {
    const success = this.vfs.writeFile(
      path,
      content,
      this.defaultUid,
      this.defaultGid,
      DEFAULT_UMASK,
    );
    return success
      ? ok(undefined)
      : err({ kind: 'IO_ERROR', message: `${path}: write failed` });
  }

  mkdir(path: string): Result<void> {
    const success = this.vfs.mkdir(
      path,
      DEFAULT_DIR_PERMS,
      this.defaultUid,
      this.defaultGid,
    );
    return success
      ? ok(undefined)
      : err({ kind: 'IO_ERROR', message: `${path}: mkdir failed` });
  }

  deleteFile(path: string): Result<void> {
    return this.vfs.deleteFile(path)
      ? ok(undefined)
      : err({ kind: 'IO_ERROR', message: `${path}: rm failed` });
  }

  rmdir(path: string): Result<void> {
    return this.vfs.rmdir(path)
      ? ok(undefined)
      : err({ kind: 'IO_ERROR', message: `${path}: rmdir failed` });
  }

  rename(src: string, dst: string): Result<void> {
    return this.vfs.rename(src, dst)
      ? ok(undefined)
      : err({ kind: 'IO_ERROR', message: `rename ${src} -> ${dst} failed` });
  }

  setPermissions(path: string, mode: number): Result<void> {
    return this.vfs.chmod(path, mode)
      ? ok(undefined)
      : err({ kind: 'IO_ERROR', message: `${path}: chmod failed` });
  }

  setOwner(path: string, uid: number, gid: number): Result<void> {
    return this.vfs.chown(path, uid, gid)
      ? ok(undefined)
      : err({ kind: 'IO_ERROR', message: `${path}: chown failed` });
  }
}

function mapFileType(ft: INode['type']): EntryType {
  switch (ft) {
    case 'directory':
      return 'directory';
    case 'symlink':
      return 'symlink';
    default:
      return 'file';
  }
}

function toFileAttrs(inode: INode): SftpFileAttrs {
  return {
    type: mapFileType(inode.type),
    mode: inode.permissions || defaultModeForType(inode.type),
    uid: inode.uid,
    gid: inode.gid,
    size: inode.size,
    mtime: inode.mtime,
  };
}

function toDirEntry(entry: DirEntry): SftpDirEntry {
  return {
    name: entry.name,
    ...toFileAttrs(entry.inode),
  };
}

function defaultModeForType(type: INode['type']): number {
  return type === 'directory' ? DEFAULT_DIR_PERMS : DEFAULT_FILE_PERMS;
}
