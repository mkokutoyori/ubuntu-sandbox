/**
 * RedundancyPolicy — keep the N most recent backup sets; older ones
 * become obsolete.
 */

import type { IRetentionPolicy, RetentionKind } from './IRetentionPolicy';
import type { BackupSet } from '../catalog/types';

export class RedundancyPolicy implements IRetentionPolicy {
  readonly kind: RetentionKind = 'redundancy';
  readonly value: number;

  constructor(redundancy: number) {
    if (!Number.isInteger(redundancy) || redundancy < 1) {
      throw new Error(`RedundancyPolicy: n must be >= 1 (got ${redundancy})`);
    }
    this.value = redundancy;
  }

  describe(): string { return `REDUNDANCY ${this.value}`; }

  findObsolete(sets: ReadonlyArray<BackupSet>): BackupSet[] {
    const sorted = [...sets].sort((a, b) => b.completionTime - a.completionTime);
    return sorted.slice(this.value);
  }
}
