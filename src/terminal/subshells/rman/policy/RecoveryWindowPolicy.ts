/**
 * RecoveryWindowPolicy — garde tout ce qui est DANS la fenetre, plus la
 * sauvegarde la plus recente d'AVANT son bord.
 *
 * Cette derniere n'est pas une precaution : pour revenir au DEBUT de la
 * fenetre il faut une sauvegarde anterieure a ce debut, et la jeter
 * rendrait le bord le plus ancien de la fenetre irrecuperable — une
 * politique de retention qui promet sept jours et n'en tient que six.
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
    const preWindow = [...sets]
      .sort((a, b) => b.completionTime - a.completionTime)
      .filter(s => s.completionTime < cutoff);
    return preWindow.slice(1);
  }
}
