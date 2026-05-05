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

export class WindowsSftpFSAdapter implements ISftpFileSystem {
  constructor(
    private readonly wfs: WindowsFileSystem,
    private readonly defaultUid: number,
    private readonly defaultGid: number,
  ) {}

  // ── ISftpNavigable ─────────────────────────────────────────────────

  normalizePath(path: string, cwd: string): string {
    return this.wfs.normalizePath(path, cwd);
  }

  exists(path: string): boolean {
    return this.wfs.exists(path);
  }

  getEntryType(path: string): EntryType | null {
    if (!this.wfs.exists(path)) return null;
    return this.wfs.isDirectory(path) ? 'directory' : 'file';
  }

  // ── ISftpReadable ──────────────────────────────────────────────────

  readFile(path: string): Result<string> {
    const result = this.wfs.readFile(path);
    if (!result.ok) {
      return err({ kind: 'IO_ERROR', message: result.error ?? `${path}: read failed` });
    }
    return ok(result.content ?? '');
  }

  listDirectory(path: string): Result<readonly SftpDirEntry[]> {
    if (!this.wfs.exists(path)) {
      return err({ kind: 'IO_ERROR', message: `${path}: not found` });
    }
    if (!this.wfs.isDirectory(path)) {
      return err({ kind: 'IO_ERROR', message: `${path}: not a directory` });
    }
    return ok(this.wfs.listDirectory(path).map((e) => this.toDirEntry(e)));
  }

  stat(path: string): Result<SftpFileAttrs> {
    const entry = this.resolveEntry(path);
    if (!entry) {
      return err({ kind: 'IO_ERROR', message: `${path}: not found` });
    }
    return ok(this.toFileAttrs(entry));
  }

  // ── ISftpWritable ──────────────────────────────────────────────────

  writeFile(path: string, content: string): Result<void> {
    const created = this.wfs.createFile(path, content);
    if (!created.ok) {
      return err({ kind: 'IO_ERROR', message: created.error ?? 'write failed' });
    }
    return ok(undefined);
  }

  mkdir(path: string): Result<void> {
    const result = this.wfs.mkdir(path);
    if (!result.ok) {
      return err({ kind: 'IO_ERROR', message: result.error ?? 'mkdir failed' });
    }
    return ok(undefined);
  }

  deleteFile(path: string): Result<void> {
    const result = this.wfs.deleteFile(path);
    if (!result.ok) {
      return err({ kind: 'IO_ERROR', message: result.error ?? 'delete failed' });
    }
    return ok(undefined);
  }

  rmdir(path: string): Result<void> {
    const result = this.wfs.rmdir(path);
    if (!result.ok) {
      return err({ kind: 'IO_ERROR', message: result.error ?? 'rmdir failed' });
    }
    return ok(undefined);
  }

  rename(src: string, dst: string): Result<void> {
    const result = this.wfs.moveFile(src, dst);
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

  private resolveEntry(path: string): WinFSEntry | null {
    return this.wfs.resolve(path);
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
