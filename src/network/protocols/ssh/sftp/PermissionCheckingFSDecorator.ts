/**
 * PermissionCheckingFSDecorator — Decorator that wraps an ISftpFileSystem
 * and enforces POSIX-style read/write/execute checks against a SshUserContext.
 *
 * Root (uid=0) bypasses all checks.
 *
 * Reference: DESIGN-SSH-SFTP.md section 9.2.
 */

import { type Result, err, ok, propagateErr } from '../Result';
import type { SshUserContext } from '../SshUserContext';
import type {
  EntryType,
  ISftpFileSystem,
  SftpDirEntry,
  SftpFileAttrs,
} from './ISftpFileSystem';

export class PermissionCheckingFSDecorator implements ISftpFileSystem {
  constructor(
    private readonly base: ISftpFileSystem,
    private readonly userCtx: SshUserContext,
  ) {}

  // ── ISftpNavigable (delegated, no permission gate needed for path math) ─

  normalizePath(path: string, cwd: string): string {
    return this.base.normalizePath(path, cwd);
  }

  exists(path: string): boolean {
    return this.base.exists(path);
  }

  getEntryType(path: string): EntryType | null {
    return this.base.getEntryType(path);
  }

  // ── ISftpReadable ──────────────────────────────────────────────────

  readFile(path: string): Result<string> {
    const guard = this.checkRead(path);
    if (!guard.ok) return propagateErr(guard);
    return this.base.readFile(path);
  }

  listDirectory(path: string): Result<readonly SftpDirEntry[]> {
    const guard = this.checkRead(path);
    if (!guard.ok) return propagateErr(guard);
    return this.base.listDirectory(path);
  }

  stat(path: string): Result<SftpFileAttrs> {
    return this.base.stat(path);
  }

  // ── ISftpWritable ──────────────────────────────────────────────────

  writeFile(path: string, content: string): Result<void> {
    const guard = this.checkWrite(path, true);
    if (!guard.ok) return guard;
    return this.base.writeFile(path, content);
  }

  mkdir(path: string): Result<void> {
    const guard = this.checkWrite(path, true);
    if (!guard.ok) return guard;
    return this.base.mkdir(path);
  }

  deleteFile(path: string): Result<void> {
    const guard = this.checkWrite(path, true);
    if (!guard.ok) return guard;
    return this.base.deleteFile(path);
  }

  rmdir(path: string): Result<void> {
    const guard = this.checkWrite(path, true);
    if (!guard.ok) return guard;
    return this.base.rmdir(path);
  }

  rename(src: string, dst: string): Result<void> {
    const a = this.checkWrite(src, true);
    if (!a.ok) return a;
    const b = this.checkWrite(dst, true);
    if (!b.ok) return b;
    return this.base.rename(src, dst);
  }

  setPermissions(path: string, mode: number): Result<void> {
    const guard = this.checkOwner(path);
    if (!guard.ok) return guard;
    return this.base.setPermissions(path, mode);
  }

  setOwner(path: string, uid: number, gid: number): Result<void> {
    if (!this.userCtx.isRoot()) {
      return err({
        kind: 'PERMISSION_DENIED',
        path,
        operation: 'chown',
      });
    }
    return this.base.setOwner(path, uid, gid);
  }

  // ── private guards ────────────────────────────────────────────────

  private checkRead(path: string): Result<void> {
    if (this.userCtx.isRoot()) return ok(undefined);
    const stat = this.base.stat(path);
    if (!stat.ok) return propagateErr(stat);
    const a = stat.value;
    if (this.userCtx.canRead(a.mode, a.uid, a.gid)) return ok(undefined);
    return err({ kind: 'PERMISSION_DENIED', path, operation: 'read' });
  }

  private checkWrite(path: string, requireParent: boolean): Result<void> {
    if (this.userCtx.isRoot()) return ok(undefined);
    if (this.base.exists(path)) {
      const stat = this.base.stat(path);
      if (!stat.ok) return propagateErr(stat);
      const a = stat.value;
      if (!this.userCtx.canWrite(a.mode, a.uid, a.gid)) {
        return err({ kind: 'PERMISSION_DENIED', path, operation: 'write' });
      }
    }
    if (requireParent) {
      const parent = path.replace(/\/[^/]+\/?$/, '') || '/';
      const stat = this.base.stat(parent);
      if (stat.ok) {
        const a = stat.value;
        if (!this.userCtx.canWrite(a.mode, a.uid, a.gid)) {
          return err({
            kind: 'PERMISSION_DENIED',
            path: parent,
            operation: 'write',
          });
        }
      }
    }
    return ok(undefined);
  }

  private checkOwner(path: string): Result<void> {
    if (this.userCtx.isRoot()) return ok(undefined);
    const stat = this.base.stat(path);
    if (!stat.ok) return propagateErr(stat);
    if (stat.value.uid !== this.userCtx.uid) {
      return err({ kind: 'PERMISSION_DENIED', path, operation: 'chmod' });
    }
    return ok(undefined);
  }
}
