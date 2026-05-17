/**
 * IRmanCatalogRepository — Interface Segregation.
 *
 * Reader and Writer are separable; the LIST/REPORT commands only need
 * the Reader. The full repository also exposes a `changes$` stream
 * (CATALOG_UPDATED events) for reactive subscribers.
 */

import type { Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { BackupSet, BackupPiece, CatalogSnapshot } from './types';
import type { BackupKey } from '../values/BackupKey';
import type { RmanTag } from '../values/RmanTag';
import type { RmanObservable } from '../reactive/RmanSubject';
import type { RmanEvent } from '../core/types';

export interface IRmanCatalogReader {
  findByKey(key: BackupKey):           Result<BackupSet,     RmanError>;
  findByTag(tag: RmanTag):             Result<BackupSet[],   RmanError>;
  listAll():                           Result<CatalogSnapshot, RmanError>;
  listExpired():                       Result<BackupPiece[], RmanError>;
  listObsolete(redundancy: number):    Result<BackupSet[],   RmanError>;
}

export interface IRmanCatalogWriter {
  recordBackupSet(set: BackupSet):     Result<void, RmanError>;
  expirePiece(key: BackupKey):         Result<void, RmanError>;
  deleteBackupSet(bsKey: number):      Result<void, RmanError>;
  /** Switch every piece of a backup set to a new status (AVAILABLE / UNAVAILABLE). */
  setSetStatus(bsKey: number, status: 'AVAILABLE' | 'UNAVAILABLE'): Result<void, RmanError>;
}

export interface IRmanCatalogRepository extends IRmanCatalogReader, IRmanCatalogWriter {
  readonly changes$: RmanObservable<Extract<RmanEvent, { type: 'CATALOG_UPDATED' }>>;
}
