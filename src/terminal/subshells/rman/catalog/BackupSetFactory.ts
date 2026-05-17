/**
 * BackupSetFactory — produces frozen BackupSet objects.
 *
 * Allocates a fresh BackupKey, picks a checkpoint SCN, wraps the
 * caller-supplied datafiles, and seals everything with Object.freeze.
 */

import { BackupKey } from '../values/BackupKey';
import { RmanTag } from '../values/RmanTag';
import { Scn } from '../values/Scn';
import { DbId } from '../values/DbId';
import type { BackupSet, BackupPiece, DatafileEntry, BackupType, DeviceType } from './types';

export interface BackupSetSpec {
  readonly type:        BackupType;
  readonly level:       0 | 1;
  readonly dbId?:       DbId;
  readonly tag?:        RmanTag;
  readonly path:        string;
  readonly sizeBytes:   number;
  readonly datafiles:   ReadonlyArray<DatafileEntry>;
  readonly compressed?: boolean;
  readonly deviceType?: DeviceType;
  readonly keepNote?:   string;
}

export const BackupSetFactory = {
  createBackupSet(spec: BackupSetSpec): BackupSet {
    const now  = Date.now();
    const key  = BackupKey.next();
    const tag  = spec.tag ?? RmanTag.generate();
    const scnR = Scn.of(Math.floor(1_800_000 + Math.random() * 100_000));
    const scn  = scnR.ok ? scnR.value : Scn.ZERO;
    const dbId = spec.dbId ?? DbId.DEFAULT;

    const piece: BackupPiece = Object.freeze({
      key,
      bsKey:          key.bsKey,
      status:         'AVAILABLE' as const,
      path:           spec.path,
      tag,
      deviceType:     spec.deviceType ?? 'DISK',
      sizeBytes:      spec.sizeBytes,
      checkpointScn:  scn,
      completionTime: now,
      compressed:     spec.compressed ?? false,
    });

    return Object.freeze({
      bsKey:          key.bsKey,
      type:           spec.type,
      level:          spec.level,
      dbId,
      tag,
      pieces:         Object.freeze([piece]),
      startTime:      now - 15_000,
      completionTime: now,
      sizeBytes:      spec.sizeBytes,
      datafiles:      Object.freeze([...spec.datafiles]),
      keepNote:       spec.keepNote,
    });
  },
};
