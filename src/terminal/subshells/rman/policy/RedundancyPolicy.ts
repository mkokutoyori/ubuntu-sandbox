/**
 * RedundancyPolicy — garde N copies de CHAQUE fichier de donnees.
 *
 * Le compte se fait par FICHIER, pas par jeu : une sauvegarde complete
 * suivie de deux sauvegardes du seul tablespace USERS ne donne pas
 * trois copies de SYSTEM. Compter les jeux declarait la complete
 * obsolete et laissait SYSTEM sans aucune copie.
 *
 * Un jeu qui ne porte AUCUN fichier de donnees — un fichier de
 * controle, un journal archive, la suite d'un jeu decoupe — ne peut pas
 * se juger ainsi : il suit alors le compte des jeux de son propre type.
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
    const copiesParFichier = new Map<number, number>();
    const copiesParType = new Map<string, number>();
    const obsoletes: BackupSet[] = [];

    for (const jeu of sorted) {
      const fichiers = jeu.datafiles.map(df => df.fileNo);
      const deja = fichiers.length > 0
        ? fichiers.every(f => (copiesParFichier.get(f) ?? 0) >= this.value)
        : (copiesParType.get(jeu.type) ?? 0) >= this.value;
      if (deja) obsoletes.push(jeu);

      for (const f of fichiers) copiesParFichier.set(f, (copiesParFichier.get(f) ?? 0) + 1);
      if (fichiers.length === 0) {
        copiesParType.set(jeu.type, (copiesParType.get(jeu.type) ?? 0) + 1);
      }
    }
    return obsoletes;
  }
}
