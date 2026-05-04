/**
 * WindowsSftpAdapter — adapts WindowsFileSystem + WindowsUserManager to the
 * ISftpFileSystem / ISftpUserAuth interfaces used by SftpSession.
 *
 * Path convention (mirrors OpenSSH Server for Windows):
 *   SFTP path  /C:/Users/User/file.txt
 *   Windows    C:\Users\User\file.txt
 *
 * The adapter translates in both directions so SftpSession always works
 * with POSIX-style paths while WindowsFileSystem sees backslash paths.
 */

import type { ISftpFileSystem, ISftpUserAuth } from './ISftpFileSystem';
import { WindowsFileSystem } from '@/network/devices/windows/WindowsFileSystem';
import { WindowsUserManager } from '@/network/devices/windows/WindowsUserManager';

// ─── Path translation ──────────────────────────────────────────────────────

/** /C:/Users/User/foo  →  C:\Users\User\foo */
function sftpToWin(sftpPath: string): string {
  // /X:/... → X:\...
  const drivePfx = sftpPath.match(/^\/([A-Za-z]):(\/.*)$/);
  if (drivePfx) {
    return drivePfx[1].toUpperCase() + ':' + drivePfx[2].replace(/\//g, '\\');
  }
  // /X: (drive root only)
  const driveOnly = sftpPath.match(/^\/([A-Za-z]):$/);
  if (driveOnly) return driveOnly[1].toUpperCase() + ':\\';
  // /foo/bar → C:\foo\bar (assume C: drive)
  if (sftpPath.startsWith('/')) return 'C:' + sftpPath.replace(/\//g, '\\');
  // Already a Windows path — pass through
  return sftpPath;
}

/** C:\Users\User\foo  →  /C:/Users/User/foo */
function winToSftp(winPath: string): string {
  const m = winPath.match(/^([A-Za-z]):\\(.+)$/);
  if (m) return '/' + m[1].toUpperCase() + ':/' + m[2].replace(/\\/g, '/');
  const root = winPath.match(/^([A-Za-z]):\\?$/);
  if (root) return '/' + root[1].toUpperCase() + ':';
  return winPath;
}

// ─── Filesystem adapter ────────────────────────────────────────────────────

export class WindowsSftpFSAdapter implements ISftpFileSystem {
  constructor(private readonly wfs: WindowsFileSystem) {}

  normalizePath(path: string, cwd: string): string {
    const winPath = sftpToWin(path);
    const winCwd  = sftpToWin(cwd);
    return winToSftp(this.wfs.normalizePath(winPath, winCwd));
  }

  getEntryType(sftpPath: string): 'file' | 'directory' | null {
    const entry = this.wfs.resolve(sftpToWin(sftpPath));
    if (!entry) return null;
    return entry.type; // 'file' | 'directory'
  }

  listDirectory(sftpPath: string): Array<{ name: string }> | null {
    const winPath = sftpToWin(sftpPath);
    if (!this.wfs.isDirectory(winPath)) return null;
    const entries = this.wfs.listDirectory(winPath);
    return entries.map(e => ({ name: e.name }));
  }

  readFile(sftpPath: string): string | null {
    const result = this.wfs.readFile(sftpToWin(sftpPath));
    return result.ok ? (result.content ?? '') : null;
  }

  writeFile(sftpPath: string, content: string): void {
    this.wfs.createFile(sftpToWin(sftpPath), content);
  }

  exists(sftpPath: string): boolean {
    return this.wfs.exists(sftpToWin(sftpPath));
  }

  mkdirp(sftpPath: string): void {
    this.wfs.mkdirp(sftpToWin(sftpPath));
  }

  deleteFile(sftpPath: string): boolean {
    return this.wfs.deleteFile(sftpToWin(sftpPath)).ok;
  }

  rmdir(sftpPath: string): boolean {
    const winPath = sftpToWin(sftpPath);
    const entries = this.wfs.listDirectory(winPath);
    if (entries.length > 0) return false; // non-empty
    return this.wfs.deleteDirectory(winPath).ok;
  }

  rename(srcSftp: string, dstSftp: string): boolean {
    const srcWin = sftpToWin(srcSftp);
    const dstWin = sftpToWin(dstSftp);
    // Move to a different directory: copy then delete
    const content = this.wfs.readFile(srcWin);
    if (!content.ok) return false;
    const created = this.wfs.createFile(dstWin, content.content ?? '');
    if (!created.ok) return false;
    this.wfs.deleteFile(srcWin);
    return true;
  }

  /** Expose the underlying WindowsFileSystem for test assertions. */
  getWindowsFS(): WindowsFileSystem { return this.wfs; }
}

// ─── User auth adapter ─────────────────────────────────────────────────────

export class WindowsSftpUserAuthAdapter implements ISftpUserAuth {
  constructor(private readonly mgr: WindowsUserManager) {}

  checkPassword(username: string, password: string): boolean {
    return this.mgr.checkPassword(username, password);
  }

  getHomeDirectory(username: string): string {
    return `/C:/Users/${username}`;
  }
}
