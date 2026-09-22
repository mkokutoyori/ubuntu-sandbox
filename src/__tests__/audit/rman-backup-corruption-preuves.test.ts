/**
 * Sonde — une sauvegarde ne dit plus « Finished » d'une base qu'elle
 * n'a pas pu lire.
 *
 * Trois lots ont rendu VALIDATE, le registre de blocs et BLOCKRECOVER
 * reels. Restait la question qu'ils posent en creux, et que le banc
 * `debug/rman/backup-datafile-corrompu` a mesuree : sur une base dont
 * le fichier 4 est illisible, `BACKUP DATABASE` repondait « Finished
 * backup » sans un mot. C'est la pire chose qu'un outil de sauvegarde
 * puisse faire en silence. Et `V$BACKUP_CORRUPTION` comme
 * `V$COPY_CORRUPTION` rendaient un jeu VIDE ecrit en dur — la meme
 * forme de la regle 6 que `V$DATABASE_BLOCK_CORRUPTION` avait avant
 * son lot. `SET MAXCORRUPT`, enfin, etait refuse, donc l'echappatoire
 * documentee n'existait pas.
 *
 * AUTORITE (extraits de recherche ; docs.oracle.com est injoignable
 * depuis cet environnement, sources dans le message de commit) : par
 * defaut RMAN tolere ZERO bloc corrompu et s'arrete —
 * `ORA-19566: exceeded limit of <n> corrupt blocks for file <name>` —
 * a moins que `SET MAXCORRUPT FOR DATAFILE <n> TO <m>` ne l'autorise ;
 * les blocs sauvegardes malgre tout sont enregistres, dans
 * V$BACKUP_CORRUPTION pour un jeu de sauvegarde et V$COPY_CORRUPTION
 * pour une copie image.
 *
 * QUELLE VUE PORTE QUOI — ma premiere ecriture l'avait a l'envers, et
 * la separation compte. Un REFUS n'a produit AUCUNE sauvegarde : il n'y
 * a donc rien a decrire dans V$BACKUP_CORRUPTION, et c'est
 * V$DATABASE_BLOCK_CORRUPTION qui porte le constat — c'est d'ailleurs
 * la vue que la procedure Oracle fait interroger apres un ORA-19566.
 * V$BACKUP_CORRUPTION (ou V$COPY_CORRUPTION) ne se remplit que lorsque
 * MAXCORRUPT a laisse passer, puisque les blocs sont alors REELLEMENT
 * partis dans la piece, marques corrompus.
 *
 * UN PIEGE DU SIMULATEUR, PAYE ICI ET ECRIT. `checkpointDatafiles()`
 * reecrit l'image ENTIERE du datafile depuis la memoire — ce stockage
 * n'a pas de granularite de bloc, donc un point de controle ne peut pas
 * n'ecrire que les blocs sales. Une corruption posee sur le disque est
 * donc EFFACEE par le point de controle que la sauvegarde declenche.
 * Le controle lit le disque AVANT lui ; c'est ce qui rend le constat
 * possible, et c'est une decision, pas un hasard.
 *
 * Discrimination par `git stash push -- src/terminal src/database` :
 * 6 cas sur 8 tombent avant le correctif.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN — une base saine se sauvegarde » : TEMOIN. Il passe avant
 *    ET apres ; c'est lui qui interdit de fermer le defaut en refusant
 *    toute sauvegarde.
 *  - « les archivelogs ne passent pas par ce controle » : TEMOIN de la
 *    PORTEE. `BACKUP ARCHIVELOG` ne lit pas de datafile ; le controle
 *    ne doit pas s'y appliquer, sinon une base sans datafile lisible ne
 *    pourrait plus sauvegarder ses journaux, qui sont precisement ce
 *    dont la reprise a besoin.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
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

const USERS = '/u01/app/oracle/oradata/ORCL/users01.dbf';

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);
const rman = (srv: LinuxServer, lignes: string[]): string =>
  sh(srv, `echo "${lignes.join('\n')}" | rman target /`);

function corrompu(): LinuxServer {
  const srv = lab.prod;
  sh(srv, `echo "plus un datafile" > ${USERS}`);
  return srv;
}

describe('BACKUP refuse ce qu il ne peut pas lire', () => {
  it('ORA-19566 nomme la limite et le fichier', () => {
    const srv = corrompu();
    const out = rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    expect(out).toContain(`ORA-19566: exceeded limit of 0 corrupt blocks for file ${USERS}`);
    expect(out).not.toMatch(/Finished backup at /);
  });

  it('aucune piece n est ecrite ni cataloguee', () => {
    const srv = corrompu();
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    expect(rman(srv, ['LIST BACKUP;', 'EXIT;']))
      .toContain('no backup found in the repository');
  });

  it('un REFUS remplit V$DATABASE_BLOCK_CORRUPTION, pas V$BACKUP_CORRUPTION', () => {
    const srv = corrompu();
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    expect(lab.sql(srv, 'SELECT file#, corruption_type FROM v$database_block_corruption;'))
      .toMatch(/^\s*4\s+CORRUPT/m);
    expect(lab.sql(srv, 'SELECT file# FROM v$backup_corruption;'))
      .toMatch(/no rows selected/);
  });

  it('une COPIE IMAGE toleree alimente V$COPY_CORRUPTION, pas V$BACKUP_CORRUPTION', () => {
    const srv = corrompu();
    rman(srv, [
      'RUN {', 'SET MAXCORRUPT FOR DATAFILE 4 TO 100000;',
      'BACKUP AS COPY DATAFILE 4;', '}', 'EXIT;',
    ]);
    expect(lab.sql(srv, 'SELECT file#, corruption_type FROM v$copy_corruption;'))
      .toMatch(/^\s*4\s+CORRUPT/m);
    expect(lab.sql(srv, 'SELECT file# FROM v$backup_corruption;'))
      .toMatch(/no rows selected/);
  });

  it('SET MAXCORRUPT laisse passer, et le bloc est MARKED_CORRUPT', () => {
    const srv = corrompu();
    const out = rman(srv, [
      'RUN {', 'SET MAXCORRUPT FOR DATAFILE 4 TO 100000;', 'BACKUP DATABASE;', '}', 'EXIT;',
    ]);
    expect(out).not.toContain('ORA-19566');
    expect(out).toMatch(/Finished backup at /);
    expect(lab.sql(srv, 'SELECT file#, marked_corrupt FROM v$backup_corruption;'))
      .toMatch(/^\s*4\s+YES/m);
  });

  it('une limite TROP BASSE refuse toujours, en la nommant', () => {
    const srv = corrompu();
    const out = rman(srv, [
      'RUN {', 'SET MAXCORRUPT FOR DATAFILE 4 TO 3;', 'BACKUP DATABASE;', '}', 'EXIT;',
    ]);
    expect(out).toContain('ORA-19566: exceeded limit of 3 corrupt blocks for file');
  });

  it('TEMOIN — une base saine se sauvegarde', () => {
    const srv = lab.prod;
    const out = rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    expect(out).toMatch(/Finished backup at /);
    expect(out).not.toContain('ORA-19566');
    expect(lab.sql(srv, 'SELECT file# FROM v$backup_corruption;'))
      .toMatch(/no rows selected/);
  });

  it('TEMOIN — les archivelogs ne passent pas par ce controle', () => {
    const srv = corrompu();
    const db = getOracleDatabase(srv.getId());
    (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
    lab.sql(srv, 'ALTER SYSTEM SWITCH LOGFILE;');
    const out = rman(srv, ['BACKUP ARCHIVELOG ALL;', 'EXIT;']);
    expect(out).not.toContain('ORA-19566');
    expect(out).toMatch(/Finished backup at /);
  });
});
