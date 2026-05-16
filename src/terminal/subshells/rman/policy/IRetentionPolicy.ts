/**
 * IRetentionPolicy — Strategy interface for backup retention.
 *
 * The engine queries findObsolete() to drive `DELETE OBSOLETE`.
 * Each concrete policy renders a human-readable describe() string used
 * by `SHOW ALL`.
 */

import type { BackupSet } from '../catalog/types';

export type RetentionKind = 'redundancy' | 'recovery_window' | 'none';

export interface IRetentionPolicy {
  readonly kind:  RetentionKind;
  readonly value: number | null;
  describe(): string;
  findObsolete(sets: ReadonlyArray<BackupSet>): BackupSet[];
}
