/**
 * ChrootedSftpFileSystem — wraps an ISftpFileSystem so the user sees the
 * given `chrootDir` as `/`. Every path the user gives is resolved
 * relative to chrootDir before being passed to the underlying fs;
 * results never leak the parent prefix. Matches sshd ChrootDirectory.
 */

import { type Result, err, ok, propagateErr } from '../Result';
import type {
  EntryType,
  ISftpFileSystem,
  SftpDirEntry,
  SftpFileAttrs,
} from './ISftpFileSystem';

export class ChrootedSftpFileSystem implements ISftpFileSystem {
  constructor(
    private readonly base: ISftpFileSystem,
    private readonly chrootDir: string,
  ) {}

  normalizePath(path: string, cwd: string): string {
    if (path.startsWith('/')) {
      const real = this.base.normalizePath(this.toReal(path), this.chrootDir);
      return this.toVisible(real);
    }
    const realCwd = this.toReal(cwd);
    const real = this.base.normalizePath(path, realCwd);
    return this.toVisible(real);
  }

  exists(path: string): boolean         { return this.base.exists(this.toReal(path)); }
  getEntryType(path: string): EntryType | null { return this.base.getEntryType(this.toReal(path)); }
  readFile(path: string): Result<string>           { return this.base.readFile(this.toReal(path)); }
  writeFile(path: string, content: string): Result<void> { return this.base.writeFile(this.toReal(path), content); }
  mkdir(path: string): Result<void>      { return this.base.mkdir(this.toReal(path)); }
  rmdir(path: string): Result<void>      { return this.base.rmdir(this.toReal(path)); }
  deleteFile(path: string): Result<void> { return this.base.deleteFile(this.toReal(path)); }
  rename(src: string, dst: string): Result<void> { return this.base.rename(this.toReal(src), this.toReal(dst)); }
  setPermissions(path: string, mode: number): Result<void> { return this.base.setPermissions(this.toReal(path), mode); }
  setOwner(path: string, uid: number, gid: number): Result<void> { return this.base.setOwner(this.toReal(path), uid, gid); }
  stat(path: string): Result<SftpFileAttrs> { return this.base.stat(this.toReal(path)); }

  listDirectory(path: string): Result<readonly SftpDirEntry[]> {
    const r = this.base.listDirectory(this.toReal(path));
    if (!r.ok) return propagateErr(r);
    return ok(r.value);
  }

  private toReal(path: string): string {
    if (!path.startsWith('/')) return path;
    if (this.chrootDir === '/' || this.chrootDir === '') return path;
    const norm = path.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    if (norm === '/') return this.chrootDir;
    return `${this.chrootDir}${norm}`;
  }

  private toVisible(realPath: string): string {
    if (this.chrootDir === '/' || this.chrootDir === '') return realPath;
    if (realPath === this.chrootDir) return '/';
    if (realPath.startsWith(this.chrootDir + '/')) {
      return realPath.slice(this.chrootDir.length);
    }
    return '/';
  }
}

// Silence “unused import” when err isn't reached on this trim.
export const _unused = err;
