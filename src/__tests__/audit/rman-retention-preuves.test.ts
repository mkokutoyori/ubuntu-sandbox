/**
 * Les deux politiques de retention de RMAN, et ce qu'elles gardent.
 *
 * `docs/ASSESSMENT-RMAN.md` §6 listait « les seuils exacts de
 * `REPORT NEED BACKUP` / `REPORT OBSOLETE` » parmi ce qui n'avait pas pu
 * etre source. La recherche les donne (sources dans le message de
 * commit ; `docs.oracle.com` reste injoignable depuis cet
 * environnement, ce que le message dit aussi).
 *
 * DEUX REGLES, DEUX DEFAUTS, tous deux de la meme famille : une
 * politique de retention qui declare obsolete ce dont la recuperation a
 * BESOIN. C'est la pire forme de fausse assurance pour un outil de
 * sauvegarde — l'operateur croit tenir sept jours et n'en tient que six.
 *
 * FENETRE DE RECUPERATION. « implementing a recovery window of 7 days
 * ensures that for each datafile, ONE BACKUP THAT IS OLDER THAN THE
 * POINT OF RECOVERABILITY is retained. » Pour revenir au DEBUT de la
 * fenetre il faut une sauvegarde d'AVANT ce debut.
 *
 *   Mesure AVANT, fenetre 7 jours, jeux a J-30, J-20, J-3, J-1 :
 *     declares obsoletes  2,1   <- les DEUX jeux d'avant la fenetre
 *   APRES :
 *     declares obsoletes  1     <- l'ancre J-20 est gardee
 *
 * REDONDANCE. « Redundancy-based policies tell RMAN exactly how many
 * complete sets of EACH DATAFILE's backup should be kept. » Le compte
 * est par FICHIER, pas par jeu.
 *
 *   Mesure AVANT, redondance 2, une COMPLETE puis deux sauvegardes du
 *   seul USERS :
 *     declares obsoletes  1     <- la complete ! SYSTEM se retrouvait
 *                                  sans AUCUNE copie
 *   APRES :
 *     declares obsoletes  (aucun)
 *
 * Discrimination : 4 cas sur 9 tombent sous
 * `git stash push -- src/terminal`. Les cinq autres sont les cas que
 * les deux politiques traitaient DEJA correctement : l'ancre quand
 * RIEN n'est dans la fenetre, un jeu unique, trois copies completes en
 * redondance 2, une seule en redondance 1, et le plus ancien qui part
 * une fois chaque fichier couvert n fois.
 *
 * Ces cinq comptent autant que les quatre : ils gardent que la
 * correction n'a pas deborde dans l'autre sens. Une politique qui ne
 * declarerait plus RIEN obsolete serait le defaut symetrique — le
 * disque se remplirait, et `DELETE OBSOLETE` ne rendrait jamais rien.
 * Le cas << tout l'avant-fenetre SAUF l'ancre >> le mesure dans les
 * deux sens a la fois.
 */
import { describe, it, expect } from 'vitest';
import { RecoveryWindowPolicy } from '@/terminal/subshells/rman/policy/RecoveryWindowPolicy';
import { RedundancyPolicy } from '@/terminal/subshells/rman/policy/RedundancyPolicy';
import type { BackupSet } from '@/terminal/subshells/rman/catalog/types';

const JOUR = 86_400_000;

function jeu(
  bsKey: number, ilYaJours: number, tablespaces: string[] = ['SYSTEM', 'USERS'],
): BackupSet {
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

const cles = (sets: BackupSet[]): number[] => sets.map((s) => s.bsKey).sort((a, b) => a - b);

describe('fenetre de recuperation', () => {
  it('garde la sauvegarde la plus recente d AVANT le bord de la fenetre', () => {
    const obsoletes = new RecoveryWindowPolicy(7)
      .findObsolete([jeu(1, 30), jeu(2, 20), jeu(3, 3), jeu(4, 1)]);
    expect(cles(obsoletes)).toEqual([1]);
  });

  it('avec une seule sauvegarde d avant la fenetre, elle est l ancre et reste', () => {
    const obsoletes = new RecoveryWindowPolicy(7).findObsolete([jeu(1, 20), jeu(2, 1)]);
    expect(cles(obsoletes)).toEqual([]);
  });

  it('TEMOIN — sans aucun jeu dans la fenetre, l ancre est gardee aussi', () => {
    const obsoletes = new RecoveryWindowPolicy(7).findObsolete([jeu(1, 30), jeu(2, 20)]);
    expect(cles(obsoletes)).toEqual([1]);
  });

  it('TEMOIN — un jeu unique, dans la fenetre, n est jamais obsolete', () => {
    expect(new RecoveryWindowPolicy(7).findObsolete([jeu(1, 1)])).toEqual([]);
  });

  it('elle declare obsolete tout l avant-fenetre SAUF l ancre', () => {
    const obsoletes = new RecoveryWindowPolicy(7)
      .findObsolete([jeu(1, 40), jeu(2, 30), jeu(3, 20), jeu(4, 1)]);
    expect(cles(obsoletes)).toEqual([1, 2]);
  });
});

describe('redondance', () => {
  it('compte les copies PAR FICHIER, pas par jeu', () => {
    const obsoletes = new RedundancyPolicy(2).findObsolete([
      jeu(1, 5, ['SYSTEM', 'USERS']),
      jeu(2, 4, ['USERS']),
      jeu(3, 3, ['USERS']),
    ]);
    expect(cles(obsoletes)).toEqual([]);
  });

  it('une fois chaque fichier couvert n fois, le plus ancien devient obsolete', () => {
    const obsoletes = new RedundancyPolicy(2).findObsolete([
      jeu(1, 6), jeu(2, 5), jeu(3, 4), jeu(4, 3),
    ]);
    expect(cles(obsoletes)).toEqual([1, 2]);
  });

  it('TEMOIN — trois sauvegardes completes, redondance 2 : la plus ancienne part', () => {
    const obsoletes = new RedundancyPolicy(2).findObsolete([jeu(1, 5), jeu(2, 4), jeu(3, 3)]);
    expect(cles(obsoletes)).toEqual([1]);
  });

  it('TEMOIN — redondance 1 garde une seule copie de chaque fichier', () => {
    const obsoletes = new RedundancyPolicy(1).findObsolete([jeu(1, 5), jeu(2, 4)]);
    expect(cles(obsoletes)).toEqual([1]);
  });
});
