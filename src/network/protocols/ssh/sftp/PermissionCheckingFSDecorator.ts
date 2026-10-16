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
    const searched = this.checkTraverse(path);
    if (!searched.ok) return propagateErr(searched);
    const guard = this.checkRead(path);
    if (!guard.ok) return propagateErr(guard);
    return this.base.readFile(path);
  }

  listDirectory(path: string): Result<readonly SftpDirEntry[]> {
    const searched = this.checkTraverse(path);
    if (!searched.ok) return propagateErr(searched);
    const guard = this.checkRead(path);
    if (!guard.ok) return propagateErr(guard);
    return this.base.listDirectory(path);
  }

  stat(path: string): Result<SftpFileAttrs> {
    const searched = this.checkTraverse(path);
    if (!searched.ok) return propagateErr(searched);
    return this.base.stat(path);
  }

  // ── ISftpWritable ──────────────────────────────────────────────────

  writeFile(path: string, content: string): Result<void> {
    if (this.userCtx.isRoot()) return this.base.writeFile(path, content);
    const searched = this.checkTraverse(path);
    if (!searched.ok) return searched;
    if (this.base.exists(path)) {
      const s = this.base.stat(path);
      if (s.ok && !this.userCtx.canWrite(s.value.mode, s.value.uid, s.value.gid)) {
        return err({ kind: 'PERMISSION_DENIED', path, operation: 'write' });
      }
    } else {
      const g = this.checkParentWrite(path);
      if (!g.ok) return g;
    }
    return this.base.writeFile(path, content);
  }

  mkdir(path: string): Result<void> {
    if (this.userCtx.isRoot()) return this.base.mkdir(path);
    const searched = this.checkTraverse(path);
    if (!searched.ok) return searched;
    const g = this.checkParentWrite(path);
    if (!g.ok) return g;
    return this.base.mkdir(path);
  }

  deleteFile(path: string): Result<void> {
    if (this.userCtx.isRoot()) return this.base.deleteFile(path);
    const g = this.checkUnlink(path);
    if (!g.ok) return g;
    return this.base.deleteFile(path);
  }

  rmdir(path: string): Result<void> {
    if (this.userCtx.isRoot()) return this.base.rmdir(path);
    const g = this.checkUnlink(path);
    if (!g.ok) return g;
    return this.base.rmdir(path);
  }

  rename(src: string, dst: string): Result<void> {
    if (this.userCtx.isRoot()) return this.base.rename(src, dst);
    const a = this.checkUnlink(src);
    if (!a.ok) return a;
    const b = this.checkParentWrite(dst);
    if (!b.ok) return b;
    return this.base.rename(src, dst);
  }

  setPermissions(path: string, mode: number): Result<void> {
    const guard = this.checkOwner(path);
    if (!guard.ok) return guard;
    return this.base.setPermissions(path, mode);
  }

  setTimes(path: string, times: { readonly atime: number; readonly mtime: number }): Result<void> {
    const guard = this.checkOwner(path);
    if (!guard.ok) return guard;
    return this.base.setTimes?.(path, times) ?? err({ kind: 'IO_ERROR', message: 'utimes not supported' });
  }

  createSymlink(linkPath: string, targetPath: string): Result<void> {
    if (this.base.createSymlink === undefined) return err({ kind: 'UNKNOWN_OP', op: 'symlink' });
    if (!this.userCtx.isRoot()) {
      const searched = this.checkTraverse(linkPath);
      if (!searched.ok) return searched;
      const guard = this.checkParentWrite(linkPath);
      if (!guard.ok) return guard;
    }
    return this.base.createSymlink(linkPath, targetPath);
  }

  readSymlink(path: string): Result<string> {
    if (this.base.readSymlink === undefined) return err({ kind: 'UNKNOWN_OP', op: 'readlink' });
    const searched = this.checkTraverse(path);
    if (!searched.ok) return propagateErr(searched);
    return this.base.readSymlink(path);
  }

  createHardLink(newPath: string, existingPath: string): Result<void> {
    if (this.base.createHardLink === undefined) return err({ kind: 'UNKNOWN_OP', op: 'hardlink' });
    if (!this.userCtx.isRoot()) {
      const searched = this.checkTraverse(newPath);
      if (!searched.ok) return searched;
      const guard = this.checkParentWrite(newPath);
      if (!guard.ok) return guard;
    }
    return this.base.createHardLink(newPath, existingPath);
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

  private checkTraverse(path: string): Result<void> {
    if (this.userCtx.isRoot()) return ok(undefined);
    const segments = path.replace(/\/+$/, '').split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const ancestor = segments.slice(0, depth).join('/') || '/';
      const stat = this.base.stat(ancestor);
      if (!stat.ok) return ok(undefined);
      const attrs = stat.value;
      if (attrs.type === 'directory' && !this.userCtx.canExecute(attrs.mode, attrs.uid, attrs.gid)) {
        return err({ kind: 'PERMISSION_DENIED', path: ancestor, operation: 'search' });
      }
    }
    return ok(undefined);
  }

  private checkRead(path: string): Result<void> {
    if (this.userCtx.isRoot()) return ok(undefined);
    const stat = this.base.stat(path);
    if (!stat.ok) return propagateErr(stat);
    const a = stat.value;
    if (this.userCtx.canRead(a.mode, a.uid, a.gid)) return ok(undefined);
    return err({ kind: 'PERMISSION_DENIED', path, operation: 'read' });
  }

  private checkParentWrite(path: string): Result<void> {
    if (this.userCtx.isRoot()) return ok(undefined);
    const parent = path.replace(/\/[^/]+\/?$/, '') || '/';
    const stat = this.base.stat(parent);
    if (!stat.ok) return ok(undefined);
    const a = stat.value;
    const aclVerdict = this.base.checkAclAccess?.(parent, this.userCtx.username, [], 0o2);
    if (aclVerdict === false) {
      return err({ kind: 'PERMISSION_DENIED', path: parent, operation: 'write' });
    }
    if (aclVerdict === true) return ok(undefined);
    if (!this.userCtx.canWrite(a.mode, a.uid, a.gid)) {
      return err({ kind: 'PERMISSION_DENIED', path: parent, operation: 'write' });
    }
    return ok(undefined);
  }

  private checkUnlink(path: string): Result<void> {
    if (this.userCtx.isRoot()) return ok(undefined);
    const parent = path.replace(/\/[^/]+\/?$/, '') || '/';
    const ps = this.base.stat(parent);
    if (!ps.ok) return ok(undefined);
    const pa = ps.value;
    if (!this.userCtx.canWrite(pa.mode, pa.uid, pa.gid)) {
      return err({ kind: 'PERMISSION_DENIED', path: parent, operation: 'write' });
    }
    const stickyBit = (pa.mode & 0o1000) !== 0;
    if (stickyBit) {
      const ts = this.base.stat(path);
      if (ts.ok && ts.value.uid !== this.userCtx.uid && pa.uid !== this.userCtx.uid) {
        return err({ kind: 'PERMISSION_DENIED', path, operation: 'unlink' });
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
