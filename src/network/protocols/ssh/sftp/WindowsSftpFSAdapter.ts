/**
 * WindowsSftpFSAdapter — Adapter from WindowsFileSystem to ISftpFileSystem.
 *
 * Maps NTFS-ish concepts (entries with ACLs and attributes) onto the POSIX-
 * style attributes the SFTP layer expects. Since ACL evaluation differs from
 * Unix mode bits, we synthesize a permissive mode (0o644 / 0o755) and let
 * the upstream PermissionCheckingFSDecorator make ownership decisions; finer
 * Windows ACL enforcement is delegated to the underlying file system when
 * relevant.
 *
 * Reference: DESIGN-SSH-SFTP.md section 9.
 */

import type {
  WinDirEntry,
  WinFSEntry,
  WindowsFileSystem,
} from '@/network/devices/windows/WindowsFileSystem';
import { type Result, err, ok } from '../Result';
import type {
  EntryType,
  ISftpFileSystem,
  SftpDirEntry,
  SftpFileAttrs,
} from './ISftpFileSystem';

const DEFAULT_FILE_MODE = 0o644;
const DEFAULT_DIR_MODE = 0o755;

/**
 * Map an OpenSSH-for-Windows SFTP path (`/C:/Users/User/file.txt` or
 * `/Users/...` assumed on C:) to the native Windows form (`C:\\Users\\...`).
 * Reference: BRD-SSH-SFTP.md SFTP-13-R1/R2.
 */
export function sftpToWin(sftpPath: string): string {
  if (!sftpPath) return 'C:\\';
  const driveMatch = /^\/([A-Za-z]):\/?(.*)$/.exec(sftpPath);
  if (driveMatch) {
    const drive = driveMatch[1].toUpperCase();
    const rest = driveMatch[2].replace(/\//g, '\\');
    return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
  }
  // No drive letter — assume C: per OpenSSH-for-Windows convention.
  const rest = sftpPath.replace(/^\/+/, '').replace(/\//g, '\\');
  return rest ? `C:\\${rest}` : 'C:\\';
}

/**
 * Inverse of sftpToWin. Drive root yields `/C:/` (with trailing slash so
 * SFTP_REALPATH responses behave like OpenSSH).
 */
export function winToSftp(winPath: string): string {
  const driveMatch = /^([A-Za-z]):\\?(.*)$/.exec(winPath);
  if (!driveMatch) return '/' + winPath.replace(/\\/g, '/');
  const drive = driveMatch[1].toUpperCase();
  const rest = driveMatch[2].replace(/\\/g, '/');
  return rest ? `/${drive}:/${rest}` : `/${drive}:/`;
}

export class WindowsSftpFSAdapter implements ISftpFileSystem {
  constructor(
    private readonly wfs: WindowsFileSystem,
    private readonly defaultUid: number,
    private readonly defaultGid: number,
  ) {}

  // ── ISftpNavigable ─────────────────────────────────────────────────

  normalizePath(path: string, cwd: string): string {
    // SFTP-13: callers may pass either native Windows or SFTP-style paths.
    // Always convert to native form before delegating, then expose the
    // SFTP-style form back to the caller for round-trip stability.
    const nativeCwd = cwd.startsWith('/') ? sftpToWin(cwd) : cwd;
    const nativeInput = path.startsWith('/') ? sftpToWin(path) : path;
    return winToSftp(this.wfs.normalizePath(nativeInput, nativeCwd));
  }

  exists(path: string): boolean {
    return this.wfs.exists(this.toNative(path));
  }

  getEntryType(path: string): EntryType | null {
    const native = this.toNative(path);
    if (!this.wfs.exists(native)) return null;
    return this.wfs.isDirectory(native) ? 'directory' : 'file';
  }

  // ── ISftpReadable ──────────────────────────────────────────────────

  readFile(path: string): Result<string> {
    const result = this.wfs.readFile(this.toNative(path));
    if (!result.ok) {
      return err({ kind: 'IO_ERROR', message: result.error ?? `${path}: read failed` });
    }
    return ok(result.content ?? '');
  }

  listDirectory(path: string): Result<readonly SftpDirEntry[]> {
    const native = this.toNative(path);
    if (!this.wfs.exists(native)) {
      return err({ kind: 'IO_ERROR', message: `${path}: not found` });
    }
    if (!this.wfs.isDirectory(native)) {
      return err({ kind: 'IO_ERROR', message: `${path}: not a directory` });
    }
    return ok(this.wfs.listDirectory(native).map((e) => this.toDirEntry(e)));
  }

  stat(path: string): Result<SftpFileAttrs> {
    const entry = this.resolveEntry(this.toNative(path));
    if (!entry) {
      return err({ kind: 'IO_ERROR', message: `${path}: not found` });
    }
    return ok(this.toFileAttrs(entry));
  }

  // ── ISftpWritable ──────────────────────────────────────────────────

  writeFile(path: string, content: string): Result<void> {
    const created = this.wfs.createFile(this.toNative(path), content);
    if (!created.ok) {
      return err({ kind: 'IO_ERROR', message: created.error ?? 'write failed' });
    }
    return ok(undefined);
  }

  mkdir(path: string): Result<void> {
    const result = this.wfs.mkdir(this.toNative(path));
    if (!result.ok) {
      return err({ kind: 'IO_ERROR', message: result.error ?? 'mkdir failed' });
    }
    return ok(undefined);
  }

  deleteFile(path: string): Result<void> {
    const result = this.wfs.deleteFile(this.toNative(path));
    if (!result.ok) {
      return err({ kind: 'IO_ERROR', message: result.error ?? 'delete failed' });
    }
    return ok(undefined);
  }

  rmdir(path: string): Result<void> {
    const result = this.wfs.rmdir(this.toNative(path));
    if (!result.ok) {
      return err({ kind: 'IO_ERROR', message: result.error ?? 'rmdir failed' });
    }
    return ok(undefined);
  }

  rename(src: string, dst: string): Result<void> {
    const result = this.wfs.moveFile(this.toNative(src), this.toNative(dst));
    if (!result.ok) {
      return err({ kind: 'IO_ERROR', message: result.error ?? 'rename failed' });
    }
    return ok(undefined);
  }

  setPermissions(_path: string, _mode: number): Result<void> {
    // POSIX mode bits do not map cleanly to NTFS ACLs; treat as a no-op
    // on Windows targets. Use icacls for real ACL changes.
    return ok(undefined);
  }

  setOwner(_path: string, _uid: number, _gid: number): Result<void> {
    // Owner change on Windows uses takeown/icacls, not numeric uid/gid.
    return ok(undefined);
  }

  // ── private helpers ────────────────────────────────────────────────

  /** Convert any incoming path (SFTP or native) to native Windows form. */
  private toNative(path: string): string {
    return path.startsWith('/') ? sftpToWin(path) : path;
  }

  private resolveEntry(nativePath: string): WinFSEntry | null {
    return this.wfs.resolve(nativePath);
  }

  private toFileAttrs(entry: WinFSEntry): SftpFileAttrs {
    const isDir = entry.type === 'directory';
    return {
      type: isDir ? 'directory' : 'file',
      mode: isDir ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE,
      uid: this.defaultUid,
      gid: this.defaultGid,
      size: entry.size,
      mtime: entry.mtime.getTime(),
    };
  }

  private toDirEntry(d: WinDirEntry): SftpDirEntry {
    return { name: d.name, ...this.toFileAttrs(d.entry) };
  }
}
