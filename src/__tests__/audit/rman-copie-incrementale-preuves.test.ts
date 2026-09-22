/**
 * Sonde — la copie mise a jour incrementalement roule vraiment en
 * avant.
 *
 * `BlockRecoverCommand` gardait deux modes qui retombaient sur une
 * reprise de base ordinaire. Ce sont les deux moities de la strategie
 * que la documentation Oracle ecrit ainsi :
 *
 *   RUN {
 *     RECOVER COPY OF DATABASE WITH TAG 'mydb_incr_backup';
 *     BACKUP INCREMENTAL LEVEL 1 FOR RECOVER OF COPY
 *       WITH TAG 'mydb_incr_backup' DATABASE;
 *   }
 *
 * Le banc `debug/rman/copie-mise-a-jour-incrementale` a mesure que la
 * strategie entiere etait INTYPABLE : `RECOVER COPY OF DATABASE WITH
 * TAG '...'` et `BACKUP INCREMENTAL LEVEL 1 FOR RECOVER OF COPY ...
 * DATABASE` etaient tous deux refuses comme commandes inconnues, et la
 * seule forme acceptee — `RECOVER COPY OF DATABASE` nu — faisait une
 * reprise media ordinaire sans jamais toucher une copie. Un critere lu
 * par le parseur et jamais evalue, plus deux formes absentes.
 *
 * TROUVE EN CHEMIN, ferme ici : une copie image ecrite par `BACKUP AS
 * COPY` portait un corps VIDE. Elle n'etait donc restaurable ni
 * applicable a rien — ce qui aurait rendu toute la strategie creuse
 * meme une fois ses commandes reconnues. Une copie image EST le
 * datafile : elle porte son image.
 *
 * AUTORITE (extraits de recherche ; docs.oracle.com est injoignable
 * depuis cet environnement, sources dans le message de commit) : « At
 * the beginning of a backup strategy, RMAN creates an image copy
 * backup of the datafile. Then, at regular intervals, level 1
 * incremental backups are taken, and applied to the image copy backup,
 * rolling it forward to the point in time when the level 1 incremental
 * was created. » Le premier tour n'a donc rien a mettre a jour : RMAN
 * pose une copie de niveau 0 et l'annonce — « no parent backup or copy
 * of datafile <n> found ».
 *
 * Discrimination par `git stash push -- src/terminal src/database` :
 * 7 cas sur 9 tombent avant le correctif.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN — une etiquette inconnue ne reecrit aucune copie » :
 *    TEMOIN. Il passe avant ET apres, et il a fallu le REECRIRE pour
 *    cela : ma premiere redaction lui faisait exiger la ligne « no copy
 *    of datafile 1 found to recover », que le lot ajoute — un temoin
 *    qui tombe avant le correctif ne temoigne de rien. Reduit a ce
 *    qu'il doit garder, il interdit de fermer le defaut en reecrivant
 *    les copies de toutes les etiquettes ; la ligne, elle, est mesuree
 *    par le cas discriminant qui le precede.
 *  - « BACKUP INCREMENTAL LEVEL 1 DATABASE reste un jeu, pas une
 *    copie » : TEMOIN de la SEPARATION. Sans `FOR RECOVER OF COPY`, la
 *    commande doit continuer de produire un jeu de sauvegarde, sinon la
 *    clause ne voudrait plus rien dire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { buildRmanLab, type RmanLab } from '../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  BackupKey._reset();
  DeviceCatalogRegistry._reset();
  lab = await buildRmanLab();
});

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);
const rman = (srv: LinuxServer, lignes: string[]): string =>
  sh(srv, `echo "${lignes.join('\n')}" | rman target /`);

const TOUR = [
  'RUN {',
  "RECOVER COPY OF DATABASE WITH TAG 'INCR';",
  "BACKUP INCREMENTAL LEVEL 1 FOR RECOVER OF COPY WITH TAG 'INCR' DATABASE;",
  '}', 'EXIT;',
];

function avecTable(): LinuxServer {
  const srv = lab.prod;
  lab.sql(srv, 'CREATE TABLE clients (id NUMBER);');
  lab.sql(srv, 'INSERT INTO clients VALUES (1);');
  lab.sql(srv, 'COMMIT;');
  return srv;
}

const copiesDe = (srv: LinuxServer): string[] =>
  rman(srv, ['LIST COPY;', 'EXIT;']).split('\n')
    .map(l => /Name:\s+(\S+)/.exec(l)?.[1] ?? '')
    .filter(Boolean);

describe('la strategie de la copie mise a jour', () => {
  it('les deux lignes de la strategie sont acceptees', () => {
    const srv = avecTable();
    const out = rman(srv, TOUR);
    expect(out).not.toContain('RMAN-01009');
    expect(out).not.toContain('unknown command');
  });

  it('le premier tour POSE une copie image et l annonce', () => {
    const srv = avecTable();
    const out = rman(srv, TOUR);
    expect(out).toMatch(/no parent backup or copy of datafile 1 found/);
    expect(copiesDe(srv).length).toBe(4);
  });

  it('le deuxieme tour produit un niveau 1, pas une seconde copie', () => {
    const srv = avecTable();
    rman(srv, TOUR);
    const apresUn = copiesDe(srv);
    rman(srv, TOUR);
    expect(copiesDe(srv)).toEqual(apresUn);
    expect(rman(srv, ['LIST BACKUP;', 'EXIT;'])).toMatch(/Tag: INCR/);
  });

  it('la copie porte l image du datafile, pas un corps vide', () => {
    const srv = avecTable();
    rman(srv, TOUR);
    const corps = sh(srv, `cat ${copiesDe(srv)[0]}`);
    expect(corps).toContain('ORACLE RMAN DATAFILE COPY');
    expect(corps).toContain('ORACLE-BACKUP-PIECE-IMAGE');
  });

  it('la copie ROULE EN AVANT : une ligne ecrite entre deux tours y arrive', () => {
    const srv = avecTable();
    rman(srv, TOUR);
    const copieUsers = copiesDe(srv).find(c => c.endsWith('.df4'))!;
    expect(sh(srv, `cat ${copieUsers}`)).not.toContain('MARQUEUR_DEUXIEME_TOUR');

    lab.sql(srv, 'CREATE TABLE marqueur_deuxieme_tour (id NUMBER);');
    lab.sql(srv, 'INSERT INTO marqueur_deuxieme_tour VALUES (7);');
    lab.sql(srv, 'COMMIT;');
    rman(srv, TOUR);
    rman(srv, TOUR);

    const apres = copiesDe(srv).map(c => sh(srv, `cat ${c}`)).join('\n');
    expect(apres.toUpperCase()).toContain('MARQUEUR_DEUXIEME_TOUR');
  });

  it('RECOVER COPY OF DATAFILE 4 WITH TAG cible un seul fichier', () => {
    const srv = avecTable();
    rman(srv, TOUR);
    rman(srv, TOUR);
    const out = rman(srv, ["RECOVER COPY OF DATAFILE 4 WITH TAG 'INCR';", 'EXIT;']);
    expect(out).not.toContain('RMAN-01009');
    expect(out).toMatch(/destination for restore of datafile 00004/);
    expect(out).not.toMatch(/destination for restore of datafile 00001/);
  });

  it('une etiquette inconnue le DIT au lieu de se taire', () => {
    const srv = avecTable();
    rman(srv, TOUR);
    expect(rman(srv, ["RECOVER COPY OF DATABASE WITH TAG 'AUTRE';", 'EXIT;']))
      .toMatch(/no copy of datafile 1 found to recover/);
  });

  it('TEMOIN — une etiquette inconnue ne reecrit aucune copie', () => {
    const srv = avecTable();
    rman(srv, TOUR);
    const avant = copiesDe(srv).map(c => sh(srv, `cat ${c}`));
    rman(srv, ["RECOVER COPY OF DATABASE WITH TAG 'AUTRE';", 'EXIT;']);
    expect(copiesDe(srv).map(c => sh(srv, `cat ${c}`))).toEqual(avant);
  });

  it('TEMOIN — BACKUP INCREMENTAL LEVEL 1 DATABASE reste un jeu, pas une copie', () => {
    const srv = avecTable();
    rman(srv, ['BACKUP INCREMENTAL LEVEL 1 DATABASE;', 'EXIT;']);
    expect(rman(srv, ['LIST COPY;', 'EXIT;']))
      .toContain('specification does not match any datafile copy');
    expect(rman(srv, ['LIST BACKUP;', 'EXIT;'])).not.toContain('no backup found');
  });
});
