/**
 * Retention policies — Strategy pattern.
 *
 * Three concrete strategies implement IRetentionPolicy:
 *   - RedundancyPolicy(n)        : keep the n most recent successful sets.
 *   - RecoveryWindowPolicy(days) : keep every set inside the window, plus
 *                                  one anchor if no in-window set exists.
 *   - NonePolicy                 : never marks anything obsolete.
 */

import { describe, it, expect } from 'vitest';
import { RedundancyPolicy } from '@/terminal/subshells/rman/policy/RedundancyPolicy';
import { RecoveryWindowPolicy } from '@/terminal/subshells/rman/policy/RecoveryWindowPolicy';
import { NonePolicy } from '@/terminal/subshells/rman/policy/NonePolicy';
import type { BackupSet } from '@/terminal/subshells/rman/catalog/types';
import { BackupKey } from '@/terminal/subshells/rman/values/BackupKey';
import { RmanTag } from '@/terminal/subshells/rman/values/RmanTag';
import { Scn } from '@/terminal/subshells/rman/values/Scn';
import { DbId } from '@/terminal/subshells/rman/values/DbId';

function set(bsKey: number, daysAgo: number): BackupSet {
  const now = Date.now();
  const completionTime = now - daysAgo * 86_400_000;
  const key = { _tag: 'BackupKey' as const, bsKey, bpKey: bsKey, copy: 1 };
  return Object.freeze({
    bsKey,
    type: 'FULL' as const,
    level: 0 as const,
    dbId: DbId.DEFAULT,
    tag: RmanTag.of(`TAG-${bsKey}`),
    pieces: Object.freeze([Object.freeze({
      key, bsKey, status: 'AVAILABLE' as const,
      path: `/u01/bk/${bsKey}.bkp`, tag: RmanTag.of('T'),
      deviceType: 'DISK' as const, sizeBytes: 1_000_000,
      checkpointScn: Scn.ZERO, completionTime, compressed: false,
    })]),
    startTime: completionTime - 1_000,
    completionTime,
    sizeBytes: 1_000_000,
    datafiles: Object.freeze([]),
  });
}

describe('RedundancyPolicy', () => {
  it('describes itself as REDUNDANCY n', () => {
    expect(new RedundancyPolicy(3).describe()).toBe('REDUNDANCY 3');
  });

  it('rejects n < 1 in the constructor', () => {
    expect(() => new RedundancyPolicy(0)).toThrow();
  });

  it('redundancy(1) marks every set but the most recent as obsolete', () => {
    const p = new RedundancyPolicy(1);
    const r = p.findObsolete([set(1, 5), set(2, 3), set(3, 1)]);
    expect(r.map(s => s.bsKey).sort()).toEqual([1, 2]);
  });

  it('returns nothing when the set count is ≤ n', () => {
    const p = new RedundancyPolicy(5);
    expect(p.findObsolete([set(1, 3), set(2, 1)])).toEqual([]);
  });
});

describe('RecoveryWindowPolicy', () => {
  it('describes itself as RECOVERY WINDOW OF n DAYS', () => {
    expect(new RecoveryWindowPolicy(14).describe()).toBe('RECOVERY WINDOW OF 14 DAYS');
  });

  it('keeps every backup inside the window and marks the older ones obsolete', () => {
    const p = new RecoveryWindowPolicy(7);
    const r = p.findObsolete([set(1, 10), set(2, 8), set(3, 6), set(4, 2)]);
    expect(r.map(s => s.bsKey).sort()).toEqual([1, 2]);
  });

  it('retains one pre-window anchor when no in-window backup exists', () => {
    const p = new RecoveryWindowPolicy(7);
    const r = p.findObsolete([set(1, 30), set(2, 20), set(3, 10)]);
    expect(r.map(s => s.bsKey).sort()).toEqual([1, 2]);
  });
});

describe('NonePolicy', () => {
  it('describes itself as NONE', () => {
    expect(new NonePolicy().describe()).toBe('NONE');
  });

  it('never reports any set as obsolete', () => {
    expect(new NonePolicy().findObsolete([set(1, 100), set(2, 1)])).toEqual([]);
  });
});
