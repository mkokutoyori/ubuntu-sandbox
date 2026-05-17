/**
 * Catalog types — value-shaped records persisted by InMemoryRmanCatalog.
 *
 * All fields are readonly. Mutations happen by replacing entries.
 */

import type { BackupKey } from '../values/BackupKey';
import type { RmanTag }   from '../values/RmanTag';
import type { Scn }       from '../values/Scn';
import type { DbId }      from '../values/DbId';

export type BackupType  = 'FULL' | 'INCREMENTAL_0' | 'INCREMENTAL_1' | 'ARCHIVELOG' | 'CONTROLFILE' | 'DATAFILECOPY';
export type DeviceType  = 'DISK' | 'SBT';
export type PieceStatus = 'AVAILABLE' | 'EXPIRED' | 'DELETED' | 'UNAVAILABLE';

export interface BackupPiece {
  readonly key:            BackupKey;
  readonly bsKey:          number;
  readonly status:         PieceStatus;
  readonly path:           string;
  readonly tag:            RmanTag;
  readonly deviceType:     DeviceType;
  readonly sizeBytes:      number;
  readonly checkpointScn:  Scn;
  readonly completionTime: number;
  readonly compressed:     boolean;
  readonly encrypted?:     boolean;
}

export interface DatafileEntry {
  readonly fileNo:  number;
  readonly level:   0 | 1;
  readonly ckpScn:  Scn;
  readonly ckpTime: number;
  readonly path:    string;
}

export interface BackupSet {
  readonly bsKey:          number;
  readonly type:           BackupType;
  readonly level:          0 | 1;
  readonly dbId:           DbId;
  readonly tag:            RmanTag;
  readonly pieces:         readonly BackupPiece[];
  readonly startTime:      number;
  readonly completionTime: number;
  readonly sizeBytes:      number;
  readonly datafiles:      readonly DatafileEntry[];
  /** Optional human-readable note rendered by LIST BACKUP (KEEP FOREVER, KEEP UNTIL …). */
  readonly keepNote?:      string;
}

export interface CatalogSnapshot {
  readonly sets:   readonly BackupSet[];
  readonly pieces: readonly BackupPiece[];
  readonly dbId:   DbId;
}
