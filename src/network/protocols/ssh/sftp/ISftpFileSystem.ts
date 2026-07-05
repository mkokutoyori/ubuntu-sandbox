/**
 * ISftpFileSystem — composed interface decomposed into role-specific
 * sub-interfaces (Interface Segregation Principle).
 *
 * Reference: DESIGN-SSH-SFTP.md section 9.1.
 */

import type { Result } from '../Result';

export type EntryType = 'file' | 'directory' | 'symlink';

/**
 * v4-v6 ACL entry (draft-ietf-secsh-filexfer §5.2, PRD-FTP-SFTP.md
 * §2.1.17/P16). Modeled and transported faithfully on the wire; not
 * enforced against any actual access check (§2.2) — `checkAclAccess`
 * above is this codebase's own, older, separate ACL mechanism.
 */
export interface SftpAclEntry {
  readonly type: 'allow' | 'deny' | 'audit' | 'alarm';
  readonly subject: string;
  readonly permissions: number;
}

export interface SftpFileAttrs {
  readonly type: EntryType;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly mtime: number;
  /** Optional v4-v6 named extended attributes (arbitrary key/value pairs), carried faithfully on the wire. */
  readonly extended?: Readonly<Record<string, string>>;
  /** Optional v4-v6 ACL entries, carried faithfully on the wire (see `SftpAclEntry`). */
  readonly acl?: readonly SftpAclEntry[];
}

export interface SftpDirEntry extends SftpFileAttrs {
  readonly name: string;
}

export interface ISftpNavigable {
  normalizePath(path: string, cwd: string): string;
  exists(path: string): boolean;
  getEntryType(path: string): EntryType | null;
}

export interface ISftpReadable {
  readFile(path: string): Result<string>;
  listDirectory(path: string): Result<readonly SftpDirEntry[]>;
  stat(path: string): Result<SftpFileAttrs>;
}

export interface ISftpWritable {
  writeFile(path: string, content: string): Result<void>;
  mkdir(path: string): Result<void>;
  deleteFile(path: string): Result<void>;
  rmdir(path: string): Result<void>;
  rename(src: string, dst: string): Result<void>;
  setPermissions(path: string, mode: number): Result<void>;
  setOwner(path: string, uid: number, gid: number): Result<void>;
}

export interface ISftpFileSystem
  extends ISftpNavigable,
    ISftpReadable,
    ISftpWritable {
  /** Optional ACL-aware access check: returns null when no ACL applies. */
  checkAclAccess?(path: string, user: string, groups: readonly string[], need: number): boolean | null;
  /** Optional: true if `path` carries any explicit ACL entry. */
  hasAcl?(path: string): boolean;
  /** Optional: creates a symlink at `linkPath` pointing to `targetPath` (not all backing filesystems model symlinks). */
  createSymlink?(linkPath: string, targetPath: string): Result<void>;
  /** Optional: reads the raw target of the symlink at `path`. */
  readSymlink?(path: string): Result<string>;
  /** Optional (v6, §3.3): creates a hard link at `newPath` pointing at the same inode as `existingPath`. */
  createHardLink?(newPath: string, existingPath: string): Result<void>;
}
