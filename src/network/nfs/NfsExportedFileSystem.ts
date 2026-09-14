import type { Ftype3, NfsStatus } from './wire/NfsConstants';

export interface NfsFileStat {
  readonly type: Ftype3;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  readonly gid: number;
  readonly size: number;
  readonly fileid: number;
  readonly atime: Date;
  readonly mtime: Date;
  readonly ctime: Date;
}

export interface NfsSpaceTotals {
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly totalFiles: number;
  readonly freeFiles: number;
}

export interface NfsCredentials {
  readonly uid: number;
  readonly gid: number;
  readonly gids: readonly number[];
}

export interface NfsExportedFileSystem {
  statPath(path: string): NfsFileStat | null;
  readFile(path: string, offset: number, count: number): Uint8Array | null;
  writeFile(path: string, offset: number, data: Uint8Array, who: NfsCredentials): NfsStatus;
  truncateFile(path: string, size: number, who: NfsCredentials): NfsStatus;
  createFile(path: string, mode: number, who: NfsCredentials): NfsStatus;
  makeDirectory(path: string, mode: number, who: NfsCredentials): NfsStatus;
  removeFile(path: string, who: NfsCredentials): NfsStatus;
  removeDirectory(path: string, who: NfsCredentials): NfsStatus;
  renamePath(from: string, to: string, who: NfsCredentials): NfsStatus;
  listDirectory(path: string): readonly string[] | null;
  readSymlink(path: string): string | null;
  createSymlink(path: string, target: string, who: NfsCredentials): NfsStatus;
  setAttributes(
    path: string,
    changes: { mode?: number; uid?: number; gid?: number; atime?: Date; mtime?: Date },
    who: NfsCredentials,
  ): NfsStatus;
  accessMask(path: string, who: NfsCredentials): number;
  spaceTotals(): NfsSpaceTotals;
  isReadOnly(path: string): boolean;
}
