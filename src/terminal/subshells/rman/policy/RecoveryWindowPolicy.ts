/**
 * RecoveryWindowPolicy — keep every backup set inside the recovery
 * window. When no set is inside the window, retain the most-recent
 * pre-window set as a recovery anchor.
 */

import type { IRetentionPolicy, RetentionKind } from './IRetentionPolicy';
import type { BackupSet } from '../catalog/types';

export class RecoveryWindowPolicy implements IRetentionPolicy {
  readonly kind: RetentionKind = 'recovery_window';
  readonly value: number;

  constructor(days: number) {
    if (!Number.isInteger(days) || days < 1) {
      throw new Error(`RecoveryWindowPolicy: days must be >= 1 (got ${days})`);
    }
    this.value = days;
  }

  describe(): string { return `RECOVERY WINDOW OF ${this.value} DAYS`; }

  findObsolete(sets: ReadonlyArray<BackupSet>): BackupSet[] {
    const cutoff = Date.now() - this.value * 86_400_000;
    const sorted = [...sets].sort((a, b) => b.completionTime - a.completionTime);
    const inWindow  = sorted.filter(s => s.completionTime >= cutoff);
    const preWindow = sorted.filter(s => s.completionTime < cutoff);

    if (inWindow.length > 0) return preWindow;
    // No in-window backup → keep the most-recent pre-window as anchor.
    return preWindow.slice(1);
  }
}
