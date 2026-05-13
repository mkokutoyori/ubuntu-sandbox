/**
 * ISftpFileSystem — composed interface decomposed into role-specific
 * sub-interfaces (Interface Segregation Principle).
 *
 * Reference: DESIGN-SSH-SFTP.md section 9.1.
 */

import type { Result } from '../Result';

export type EntryType = 'file' | 'directory' | 'symlink';

export interface SftpFileAttrs {
  readonly type: EntryType;
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly mtime: number;
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
    ISftpWritable {}
