/**
 * NonePolicy — manual retention; no backup ever becomes obsolete.
 */

import type { IRetentionPolicy, RetentionKind } from './IRetentionPolicy';
import type { BackupSet } from '../catalog/types';

export class NonePolicy implements IRetentionPolicy {
  readonly kind: RetentionKind = 'none';
  readonly value: number | null = null;
  describe(): string { return 'NONE'; }
  findObsolete(_sets: ReadonlyArray<BackupSet>): BackupSet[] { return []; }
}
