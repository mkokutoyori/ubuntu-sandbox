/**
 * BackupKey — composite (bsKey, bpKey, copy) value object used by every
 * BackupSet/BackupPiece persisted in the catalog.
 *
 * Mirrors V$BACKUP_SET.BS_KEY + V$BACKUP_PIECE.BP_KEY semantics.
 */

export interface BackupKey {
  readonly _tag:  'BackupKey';
  readonly bsKey: number;
  readonly bpKey: number;
  readonly copy:  number;
}

let _bsCounter = 1;
let _bpCounter = 1;

export const BackupKey = {
  next(): BackupKey {
    return Object.freeze({
      _tag: 'BackupKey' as const,
      bsKey: _bsCounter++,
      bpKey: _bpCounter++,
      copy: 1,
    });
  },
  toString: (k: BackupKey): string => `BS:${k.bsKey}/BP:${k.bpKey}`,
  /** Test-only reset. */
  _reset(): void { _bsCounter = 1; _bpCounter = 1; },
};
