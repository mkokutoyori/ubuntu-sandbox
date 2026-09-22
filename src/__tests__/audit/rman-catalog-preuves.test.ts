/**
 * Sonde — le remede que RMAN prescrit est typable.
 *
 * Le lot de la chaine d'archivelogs a fait dire a RMAN, dans les mots
 * d'Oracle, qu'un journal introuvable se repare en le CATALOGUANT.
 * Le banc `debug/rman/catalog-des-fichiers-trouves` a mesure que ce
 * remede etait INTYPABLE : `CATALOG ARCHIVELOG '<chemin>'`,
 * `CATALOG START WITH '<prefixe>'` et `CATALOG RECOVERY AREA` etaient
 * tous trois refuses comme commandes inconnues. Le simulateur
 * prescrivait un traitement qu'il n'acceptait pas — deux vues d'un
 * meme fait qui se contredisent, regle 3.
 *
 * TROUVE EN CHEMIN, ferme ici : `CATALOG BACKUPPIECE '<un .arc>'` etait
 * ACCEPTE et enregistrait un journal archive comme jeu de sauvegarde
 * COMPLET ; `CATALOG DATAFILECOPY` en faisait une copie de datafile
 * numerotee 0. Aucune des deux ne regardait ce que le fichier EST. Un
 * enregistrement qui ment au catalogue est pire qu'un enregistrement
 * absent : il se retrouvera choisi par un RESTORE.
 *
 * AUTORITE (extraits de recherche ; docs.oracle.com est injoignable
 * depuis cet environnement, sources dans le message de commit) : le
 * gabarit de `CATALOG START WITH` — « searching for all files that
 * match the pattern <p> », « List of Files Unknown to the Database »,
 * « cataloging files... / cataloging done », « List of Cataloged
 * Files » — et la clause `NOPROMPT`, qui supprime la question que la
 * forme interactive pose avant d'enregistrer.
 *
 * CE QUI EST DECIDE ICI, et c'est une decision : ce shell n'est pas
 * interactif, donc la question n'est jamais posee et `NOPROMPT` est
 * accepte sans rien changer. Un vrai RMAN, lui, se bloquerait sur un
 * script redirige sans cette clause.
 *
 * Discrimination par `git stash push -- src/terminal src/database` :
 * 6 cas sur 8 tombent avant le correctif.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN — un fichier absent est refuse » : TEMOIN. Il passe avant
 *    (RMAN-06004 existait deja pour CATALOG BACKUPPIECE) et apres ;
 *    c'est lui qui prouve que les refus mesures plus haut viennent de
 *    la NATURE du fichier et non d'un CATALOG qui refuserait tout.
 *  - « TEMOIN — une piece deja connue n'est pas recataloguee » :
 *    TEMOIN. Un balayage doit rester sans effet sur ce que le
 *    catalogue porte deja, sinon chaque passage doublerait ses entrees.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { buildRmanLab, type RmanLab } from '../support/rmanLab';

const ARC_DIR = '/u01/app/oracle/archivelog';
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

function enArchivelog(): LinuxServer {
  const srv = lab.prod;
  const db = getOracleDatabase(srv.getId());
  (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
  for (let i = 0; i < 3; i++) lab.sql(srv, 'ALTER SYSTEM SWITCH LOGFILE;');
  return srv;
}

const pieceDe = (srv: LinuxServer): string =>
  /(\/\S+\.bkp)/.exec(rman(srv, ['LIST BACKUP;', 'EXIT;']))?.[1] ?? '';

describe('CATALOG enregistre ce que le fichier EST', () => {
  it('un journal archive ne se catalogue pas comme piece de sauvegarde', () => {
    const srv = enArchivelog();
    const out = rman(srv, [`CATALOG BACKUPPIECE '${ARC_DIR}/1_1_arc.arc';`, 'EXIT;']);
    expect(out).toContain(`RMAN-07517: Reason: The file ${ARC_DIR}/1_1_arc.arc is not a backup piece`);
    expect(out).not.toContain('cataloged backup piece');
  });

  it('ni comme copie de datafile', () => {
    const srv = enArchivelog();
    expect(rman(srv, [`CATALOG DATAFILECOPY '${ARC_DIR}/1_1_arc.arc';`, 'EXIT;']))
      .toContain('is not a datafile copy');
  });

  it('CATALOG ARCHIVELOG nomme le journal enregistre', () => {
    const srv = enArchivelog();
    const out = rman(srv, [`CATALOG ARCHIVELOG '${ARC_DIR}/1_1_arc.arc';`, 'EXIT;']);
    expect(out).not.toContain('RMAN-01009');
    expect(out).toContain('cataloged archived log');
  });

  it('TEMOIN — un fichier absent est refuse', () => {
    const srv = enArchivelog();
    expect(rman(srv, [`CATALOG BACKUPPIECE '${ARC_DIR}/pas_la.bkp';`, 'EXIT;']))
      .toContain('RMAN-06004');
  });
});

describe('CATALOG START WITH balaye un repertoire', () => {
  it('une piece inconnue du catalogue est trouvee et enregistree', () => {
    const srv = lab.prod;
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    const piece = pieceDe(srv);
    expect(piece).not.toBe('');
    sh(srv, 'mkdir -p /u01/ailleurs');
    sh(srv, `cp ${piece} /u01/ailleurs/copie.bkp`);

    const out = rman(srv, ["CATALOG START WITH '/u01/ailleurs' NOPROMPT;", 'EXIT;']);
    expect(out).toContain('searching for all files that match the pattern /u01/ailleurs');
    expect(out).toContain('List of Files Unknown to the Database');
    expect(out).toContain('File Name: /u01/ailleurs/copie.bkp');
    expect(out).toContain('cataloging done');
    expect(out).toContain('List of Cataloged Files');
    expect(rman(srv, ['LIST BACKUP;', 'EXIT;'])).toContain('/u01/ailleurs/copie.bkp');
  });

  it('un fichier qui n est rien de catalogable est ignore', () => {
    const srv = lab.prod;
    sh(srv, 'mkdir -p /u01/melange');
    sh(srv, 'echo "juste du texte" > /u01/melange/note.txt');
    expect(rman(srv, ["CATALOG START WITH '/u01/melange' NOPROMPT;", 'EXIT;']))
      .toContain('no files found to be unknown to the database');
  });

  it('TEMOIN — une piece deja connue n est pas recataloguee', () => {
    const srv = lab.prod;
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    const avant = rman(srv, ['LIST BACKUP;', 'EXIT;']).split('Piece Name:').length;
    rman(srv, ['CATALOG RECOVERY AREA NOPROMPT;', 'EXIT;']);
    expect(rman(srv, ['LIST BACKUP;', 'EXIT;']).split('Piece Name:').length).toBe(avant);
  });

  it('CATALOG RECOVERY AREA balaye la FRA sans qu on la nomme', () => {
    const srv = lab.prod;
    const out = rman(srv, ['CATALOG RECOVERY AREA NOPROMPT;', 'EXIT;']);
    expect(out).not.toContain('RMAN-01009');
    expect(out).toContain('searching for all files that match the pattern /u01/app/oracle/fast_recovery_area');
  });
});
