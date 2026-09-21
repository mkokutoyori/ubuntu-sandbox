/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * `docs/ASSESSMENT-RMAN.md` §6 listait parmi ce qui n'avait pas pu etre
 * source « les seuils exacts de `REPORT NEED BACKUP` / `REPORT
 * OBSOLETE` ». La recherche les donne (sources dans le message de
 * commit) ; ce banc mesure l'ecart avec ce que les deux politiques
 * appliquent.
 *
 * LA REGLE QUI DECIDE, pour une fenetre de recuperation :
 *
 *   « RMAN will not obsolete any backup needed for recovery to any
 *     point in the last specified days [...] implementing a recovery
 *     window of 7 days ensures that for each datafile, ONE BACKUP THAT
 *     IS OLDER THAN THE POINT OF RECOVERABILITY is retained. »
 *
 * Autrement dit : pour revenir au DEBUT de la fenetre, il faut une
 * sauvegarde d'AVANT ce debut. Les jeter tous rend la fenetre
 * irrecuperable a son bord le plus ancien — ce qui est exactement la
 * fausse assurance qu'une politique de retention ne doit pas produire.
 */
import { describe, it, expect } from 'vitest';
import { RecoveryWindowPolicy } from '@/terminal/subshells/rman/policy/RecoveryWindowPolicy';
import { RedundancyPolicy } from '@/terminal/subshells/rman/policy/RedundancyPolicy';
import type { BackupSet } from '@/terminal/subshells/rman/catalog/types';

const note = (l: string) => { console.log(l); };
const JOUR = 86_400_000;

function jeu(bsKey: number, ilYaJours: number, tablespaces: string[] = ['SYSTEM', 'USERS']): BackupSet {
  const t = Date.now() - ilYaJours * JOUR;
  return {
    bsKey, type: 'FULL', level: 0,
    dbId: { value: 1, name: 'ORCL' } as unknown as BackupSet['dbId'],
    tag: { label: `T${bsKey}` } as unknown as BackupSet['tag'],
    pieces: [{ key: bsKey, path: `/p${bsKey}.bkp` } as unknown as BackupSet['pieces'][number]],
    startTime: t, completionTime: t, sizeBytes: 1,
    datafiles: tablespaces.map((ts, i) => (
      { fileNo: i + 1, tablespace: ts } as unknown as BackupSet['datafiles'][number])),
  };
}

const cles = (sets: BackupSet[]): string =>
  sets.length === 0 ? '(aucun)' : sets.map((s) => s.bsKey).join(',');

describe('semantique des politiques de retention', () => {
  it('fenetre de recuperation : que devient la sauvegarde d AVANT la fenetre ?', () => {
    const p = new RecoveryWindowPolicy(7);
    const sets = [jeu(1, 30), jeu(2, 20), jeu(3, 3), jeu(4, 1)];
    note('[rw] fenetre 7 jours ; jeux a J-30, J-20, J-3, J-1');
    note(`[rw-1] declares obsoletes : ${cles(p.findObsolete(sets))}`);
    note('[rw-2] attendu par la regle : 1 seul — le jeu 1 (J-30). Le jeu 2');
    note('       (J-20) est le plus recent d AVANT le bord de fenetre, donc');
    note('       il est NECESSAIRE pour revenir au debut de la fenetre.');

    const aucunDansLaFenetre = [jeu(1, 30), jeu(2, 20)];
    note(`[rw-3] aucun jeu dans la fenetre : ${cles(p.findObsolete(aucunDansLaFenetre))}`);
    note('       (ici le moteur garde deja une ancre — c est le bon reflexe)');

    const unSeul = [jeu(1, 1)];
    note(`[rw-4] un seul jeu, dans la fenetre : ${cles(p.findObsolete(unSeul))}`);
    expect(true).toBe(true);
  });

  it('redondance : compte-t-elle par DATAFILE ou par jeu ?', () => {
    const p = new RedundancyPolicy(2);
    const complets = [jeu(1, 5), jeu(2, 4), jeu(3, 3)];
    note('[red] redondance 2 ; trois sauvegardes COMPLETES');
    note(`[red-1] declares obsoletes : ${cles(p.findObsolete(complets))}`);
    note('        attendu : le plus ancien (1) — deux copies restent');

    const melange = [
      jeu(1, 5, ['SYSTEM', 'USERS']),
      jeu(2, 4, ['USERS']),
      jeu(3, 3, ['USERS']),
    ];
    note('[red-2] une COMPLETE (J-5) puis deux sauvegardes du seul USERS');
    note(`        declares obsoletes : ${cles(p.findObsolete(melange))}`);
    note('        attendu par la regle : AUCUN. SYSTEM n a qu UNE copie,');
    note('        la redondance se compte PAR FICHIER, pas par jeu.');
    expect(true).toBe(true);
  });
});
