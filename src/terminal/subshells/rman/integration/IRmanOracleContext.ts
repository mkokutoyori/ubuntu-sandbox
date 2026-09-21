/**
 * IRmanOracleContext — Adapter interface between RmanSession and the
 * outside world (VFS, OracleInstance).
 */

import type { DbId } from '../values/DbId';
import type { Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';

export interface DatafileInfo {
  readonly fileNo:     number;
  readonly path:       string;
  readonly sizeBytes:  number;
  readonly tablespace: string;
}

export type BlockCorruptionType = 'CHECKSUM' | 'CORRUPT' | 'LOGICAL';

export interface ArchivedLogRecord {
  readonly thread:   number;
  readonly sequence: number;
  readonly path:     string;
  readonly firstScn: number;
  readonly nextScn:  number;
}

export interface VfsAdapter {
  /**
   * `declaredSizeBytes`, when given, is the logical size the backup
   * piece should report to `ls -l`/`du`/`stat` even though `data` may
   * be a much smaller (or empty) physical placeholder — real backup
   * pieces can be gigabytes, too large to actually buffer in memory.
   */
  writeFile(path: string, data: Uint8Array, declaredSizeBytes?: number): Result<void, RmanError>;
  readFile(path:  string):                   Result<Uint8Array, RmanError>;
  fileExists(path: string):                  boolean;
  deleteFile(path: string):                  Result<void, RmanError>;
  availableBytes():                          number;
  ensureDirectory?(path: string):            Result<void, RmanError>;
  listFilesRecursively?(dir: string):        ReadonlyArray<string>;
}

/** Ce que `CONNECT TARGET user/pass@id` porte avant le `@`. */
export interface RmanCredentials {
  readonly username: string;
  readonly password: string;
  /** TARGET et AUXILIARY ouvrent une session SYSDBA ; CATALOG non. */
  readonly asSysdba: boolean;
}

export type ConnectTargetOutcome =
  | { readonly ok: true; readonly dbName: string; readonly dbId: number; readonly remote: boolean }
  | { readonly ok: false; readonly error: string };

export type ConnectPeerOutcome =
  | {
      readonly ok: true;
      readonly dbName: string;
      readonly dbId: number;
      readonly remote: boolean;
      readonly runSql: (statement: string) => SqlStatementOutcome;
      readonly context: IRmanOracleContext;
    }
  | { readonly ok: false; readonly error: string };

export interface IRmanOracleContext {
  readonly dbId:    DbId;
  readonly dbName:  string;
  readonly vfs:     VfsAdapter;
  getDatafiles():   ReadonlyArray<DatafileInfo>;
  getSpfileParam(name: string): string | undefined;
  /** Optional: archivelog file paths the engine may delete after a
   *  `BACKUP ARCHIVELOG ALL DELETE INPUT`. Empty by default. */
  getArchivelogPaths?(): ReadonlyArray<string>;
  getArchivedLogs?(): ReadonlyArray<ArchivedLogRecord>;
  /** Optional: a virtual control-file path (used by BACKUP CURRENT CONTROLFILE). */
  getControlFilePath?(): string;
  getControlFilePaths?(): ReadonlyArray<string>;
  /** Optional: instance lifecycle state used to gate CONNECT/RESTORE/RECOVER. */
  getInstanceState?(): 'SHUTDOWN' | 'NOMOUNT' | 'MOUNT' | 'OPEN';
  /**
   * Resolve a `user/pass@identifier` target through Oracle Net, opening
   * the same TCP connection `sqlplus` opens. Absent on contexts with no
   * device to dial from, in which case CONNECT stays local.
   */
  connectTarget?(identifier: string, credentials?: RmanCredentials): ConnectTargetOutcome;
  connectPeer?(identifier: string, credentials?: RmanCredentials): ConnectPeerOutcome;
  checkpointDatafiles?(): void;
  getCurrentScn?(): number;
  runSqlStatement?(statement: string): SqlStatementOutcome;
  recordBackupPiece?(piece: RecordedBackupPiece): void;
  recordBlockCorruption?(fileNo: number, blocks: number, type: BlockCorruptionType): void;
  getBlockCorruptions?(): ReadonlyArray<{ fileNo: number; blocks: number }>;
  clearBlockCorruption?(fileNo: number): void;
  getRecoveryAreaUsedBytes?(): number;
}

export type SqlStatementOutcome =
  | { readonly ok: true;  readonly lines: readonly string[] }
  | { readonly ok: false; readonly error: string };

export interface RecordedBackupPiece {
  readonly setId:       number;
  readonly pieceId:     number;
  readonly type:        'FULL' | 'INCREMENTAL' | 'ARCHIVELOG' | 'CONTROLFILE' | 'SPFILE';
  readonly handle:      string;
  readonly bytes:       number;
  readonly startedAt:   number;
  readonly completedAt: number;
}
