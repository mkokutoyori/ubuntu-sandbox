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
}
