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

export interface VfsAdapter {
  writeFile(path: string, data: Uint8Array): Result<void, RmanError>;
  readFile(path:  string):                   Result<Uint8Array, RmanError>;
  fileExists(path: string):                  boolean;
  deleteFile(path: string):                  Result<void, RmanError>;
  availableBytes():                          number;
}

export interface IRmanOracleContext {
  readonly dbId:    DbId;
  readonly dbName:  string;
  readonly vfs:     VfsAdapter;
  getDatafiles():   ReadonlyArray<DatafileInfo>;
  getSpfileParam(name: string): string | undefined;
  /** Optional: archivelog file paths the engine may delete after a
   *  `BACKUP ARCHIVELOG ALL DELETE INPUT`. Empty by default. */
  getArchivelogPaths?(): ReadonlyArray<string>;
  /** Optional: a virtual control-file path (used by BACKUP CURRENT CONTROLFILE). */
  getControlFilePath?(): string;
  /** Optional: instance lifecycle state used to gate CONNECT/RESTORE/RECOVER. */
  getInstanceState?(): 'SHUTDOWN' | 'NOMOUNT' | 'MOUNT' | 'OPEN';
}
