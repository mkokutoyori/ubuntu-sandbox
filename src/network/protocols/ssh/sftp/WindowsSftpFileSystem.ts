/**
 * WindowsSftpFileSystem — adapts WindowsFileSystem to ISftpFileSystem.
 *
 * The Windows VFS uses an {ok,content,error} envelope for reads and
 * writes; this adapter flattens it into Result<T,SshError> so the
 * SFTP/SCP orchestrators stay vendor-agnostic.
 *
 * Path translation: an SFTP client may use POSIX-style forward slashes
 * (`/C:/Users/User/payload.txt`) — we normalise them onto the
 * Windows convention (`C:\Users\User\payload.txt`) before delegating.
 */

import type {
  ISftpFileSystem, SftpDirEntry, SftpFileAttrs, EntryType,
} from './ISftpFileSystem';
import { ok, err, type Result, type SshError } from '../Result';

interface WindowsFsLike {
  normalizePath(path: string, cwd: string): string;
  exists(absPath: string): boolean;
  isDirectory(absPath: string): boolean;
  readFile(absPath: string): { ok: boolean; content?: string; error?: string };
  createFile(absPath: string, content: string): { ok: boolean; error?: string };
}

export class WindowsSftpFileSystem implements ISftpFileSystem {
  constructor(private readonly fs: WindowsFsLike) {}

  private translatePath(p: string): string {
    if (/^\/[A-Za-z]:/.test(p)) return p.slice(1).replace(/\//g, '\\');
    return p.replace(/\//g, '\\');
  }

  normalizePath(path: string, cwd: string): string {
    return this.fs.normalizePath(this.translatePath(path), cwd);
  }

  exists(path: string): boolean {
    return this.fs.exists(this.translatePath(path));
  }

  getEntryType(path: string): EntryType | null {
    const abs = this.translatePath(path);
    if (!this.fs.exists(abs)) return null;
    return this.fs.isDirectory(abs) ? 'directory' : 'file';
  }

  readFile(path: string): Result<string> {
    const r = this.fs.readFile(this.translatePath(path));
    return r.ok && r.content !== undefined
      ? ok(r.content)
      : err({ kind: 'IO_ERROR', message: r.error ?? `${path}: read failed` } as SshError);
  }

  listDirectory(_path: string): Result<readonly SftpDirEntry[]> {
    return err({ kind: 'IO_ERROR', message: 'listDirectory not supported on Windows adapter yet' } as SshError);
  }

  stat(path: string): Result<SftpFileAttrs> {
    const abs = this.translatePath(path);
    if (!this.fs.exists(abs)) {
      return err({ kind: 'IO_ERROR', message: `${path}: not found` } as SshError);
    }
    return ok({
      type: this.fs.isDirectory(abs) ? 'directory' : 'file',
      mode: 0o644, uid: 0, gid: 0, size: 0, mtime: Date.now(),
    });
  }

  writeFile(path: string, content: string): Result<void> {
    const r = this.fs.createFile(this.translatePath(path), content);
    return r.ok ? ok(undefined) : err({ kind: 'IO_ERROR', message: r.error ?? 'write failed' } as SshError);
  }

  mkdir(_path: string): Result<void> {
    return ok(undefined);
  }
  deleteFile(_path: string): Result<void> {
    return ok(undefined);
  }
  rmdir(_path: string): Result<void> {
    return ok(undefined);
  }
  rename(_src: string, _dst: string): Result<void> {
    return ok(undefined);
  }
  setPermissions(_path: string, _mode: number): Result<void> {
    return ok(undefined);
  }
  setOwner(_path: string, _uid: number, _gid: number): Result<void> {
    return ok(undefined);
  }
}
