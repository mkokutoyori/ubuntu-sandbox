import { isInsideRecoveryArea } from '@/database/oracle/storage/RecoveryArea';
import type { BackupSet } from '../catalog/types';
import type { IRetentionPolicy } from './IRetentionPolicy';

export function obsoleteSetsInRecoveryArea(
  sets: ReadonlyArray<BackupSet>, policy: IRetentionPolicy, destination: string, nowMs: number,
): BackupSet[] {
  return policy.findObsolete(sets, nowMs)
    .filter(set => set.pieces.some(piece => isInsideRecoveryArea(piece.path, destination)))
    .sort((a, b) => a.completionTime - b.completionTime);
}

export function reclaimableBytesInRecoveryArea(
  sets: ReadonlyArray<BackupSet>, policy: IRetentionPolicy, destination: string, nowMs: number,
): number {
  let bytes = 0;
  for (const set of obsoleteSetsInRecoveryArea(sets, policy, destination, nowMs)) {
    for (const piece of set.pieces) {
      if (isInsideRecoveryArea(piece.path, destination)) bytes += piece.sizeBytes;
    }
  }
  return bytes;
}
