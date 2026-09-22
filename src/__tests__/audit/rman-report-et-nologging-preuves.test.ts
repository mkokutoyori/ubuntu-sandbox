/**
 * Sonde — deux criteres lus, rendus, et jamais evalues.
 *
 * Le banc `debug/rman/report-et-nologging` a mesure deux sites qui
 * portent la meme forme, celle que la regle 6 nomme.
 *
 *   1. `REPORT NEED BACKUP REDUNDANCY n` analysait le n, l'imprimait
 *      dans son en-tete de politique — « retention policy is set to
 *      redundancy 3 » — puis calculait « a besoin » comme « AUCUNE
 *      sauvegarde ne couvre ce fichier ». Sur une base a UNE
 *      sauvegarde, REDUNDANCY 3 ne listait donc rien : l'operateur
 *      lisait que sa regle etait satisfaite alors qu'il lui manquait
 *      deux sauvegardes sur trois. La ligne d'en-tete elle-meme
 *      annoncait « files with 0 redundant backups », un zero ecrit en
 *      dur sous une politique qui disait 3.
 *   2. `ALTER TABLESPACE x NOLOGGING` etait stocke, rendu par
 *      DBA_TABLESPACES, et decrit par le commentaire d'OracleStorage
 *      comme « affects whether DML against the tablespace generates
 *      redo ». Il n'affectait rien : le redo partait quand meme,
 *      `V$NONLOGGED_BLOCK` restait vide, et `REPORT UNRECOVERABLE`
 *      portait en clair « The simulator has no NOLOGGING tracking, so
 *      the report is always empty » — alors que le suivi existait
 *      (`ts.logging`, DBA_TABLESPACES, la vue elle-meme).
 *
 * AUTORITE (extraits de recherche ; docs.oracle.com est injoignable
 * depuis cet environnement, sources dans le message de commit) : le
 * gabarit « Report of files with less than <n> redundant backups » et
 * ses colonnes `File #bkps Name` ; et la regle qui lie les deux
 * moities — une ecriture NOLOGGING ne laisse pas de redo, donc le
 * fichier touche n'est plus recuperable par la reprise et doit etre
 * resauvegarde, ce que REPORT UNRECOVERABLE existe precisement pour
 * dire.
 *
 * CE QUE « UN BLOC » VEUT DIRE ICI : ce stockage n'a pas de
 * granularite de bloc, donc une transaction non journalisee compte ses
 * CHANGEMENTS, un par ligne touchee. Le nombre est reel — c'est ce que
 * la transaction a modifie sans laisser de redo — mais il ne se lit
 * pas comme un compte de blocs Oracle, et c'est dit ici plutot que
 * laisse a deviner.
 *
 * Discrimination par `git stash push -- src/terminal src/database` :
 * 6 cas sur 8 tombent avant le correctif.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN — une base saine ne declare rien d'irrecuperable » :
 *    TEMOIN. Il passe avant (le rapport etait vide par construction) et
 *    apres ; c'est lui qui interdit de fermer le defaut en declarant
 *    tout irrecuperable.
 *  - « TEMOIN — un tablespace LOGGING laisse son redo » : TEMOIN de la
 *    SEPARATION. Le redo doit continuer de partir quand le tablespace
 *    journalise, sinon NOLOGGING ne voudrait plus rien dire.
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

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);
const rman = (srv: LinuxServer, lignes: string[]): string =>
  sh(srv, `echo "${lignes.join('\n')}" | rman target /`);

const fichiersListes = (out: string): number[] =>
  out.split('\n')
    .map(l => /^(\d+)\s+\d+\s+\/u01/.exec(l.trim())?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);

function ecritureNonJournalisee(srv: LinuxServer): void {
  lab.sql(srv, 'ALTER TABLESPACE USERS NOLOGGING;');
  lab.sql(srv, 'CREATE TABLE t_nolog (id NUMBER) TABLESPACE USERS;');
  lab.sql(srv, 'INSERT INTO t_nolog VALUES (1);');
  lab.sql(srv, 'COMMIT;');
}

describe('REPORT NEED BACKUP applique sa redondance', () => {
  it('une seule sauvegarde ne satisfait pas REDUNDANCY 3', () => {
    const srv = lab.prod;
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    const out = rman(srv, ['REPORT NEED BACKUP REDUNDANCY 3;', 'EXIT;']);
    expect(out).toContain('Report of files with less than 3 redundant backups');
    expect(fichiersListes(out)).toEqual([1, 2, 3, 4]);
    expect(out).toMatch(/^1\s+1\s+\/u01/m);
  });

  it('elle satisfait REDUNDANCY 1 — plus aucun fichier', () => {
    const srv = lab.prod;
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    const out = rman(srv, ['REPORT NEED BACKUP REDUNDANCY 1;', 'EXIT;']);
    expect(out).toContain('Report of files with less than 1 redundant backups');
    expect(fichiersListes(out)).toEqual([]);
  });

  it('deux sauvegardes font monter #bkps a 2', () => {
    const srv = lab.prod;
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    const out = rman(srv, ['REPORT NEED BACKUP REDUNDANCY 3;', 'EXIT;']);
    expect(out).toMatch(/^1\s+2\s+\/u01/m);
    expect(fichiersListes(out)).toEqual([1, 2, 3, 4]);
  });

  it('les colonnes sont celles d Oracle', () => {
    const srv = lab.prod;
    const out = rman(srv, ['REPORT NEED BACKUP;', 'EXIT;']);
    expect(out).toContain('File #bkps Name');
    expect(out).not.toContain('#backs');
  });
});

describe('NOLOGGING rend un fichier irrecuperable', () => {
  it('l ecriture non journalisee laisse une trace dans V$NONLOGGED_BLOCK', () => {
    const srv = lab.prod;
    ecritureNonJournalisee(srv);
    expect(lab.sql(srv, 'SELECT file#, blocks FROM v$nonlogged_block;'))
      .toMatch(/^\s*4\s+\d+/m);
  });

  it('REPORT UNRECOVERABLE nomme le fichier, et la sauvegarde le lave', () => {
    const srv = lab.prod;
    ecritureNonJournalisee(srv);
    const avant = rman(srv, ['REPORT UNRECOVERABLE;', 'EXIT;']);
    expect(avant).toMatch(/^4\s+full or incremental\s+\/u01\S+users01\.dbf/m);

    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    expect(rman(srv, ['REPORT UNRECOVERABLE;', 'EXIT;']))
      .toContain('no files require backup due to unrecoverable operations');
  });

  it('TEMOIN — un tablespace LOGGING laisse son redo', () => {
    const srv = lab.prod;
    const db = getOracleDatabase(srv.getId());
    (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
    lab.sql(srv, 'CREATE TABLE t_log (id NUMBER) TABLESPACE USERS;');
    lab.sql(srv, 'INSERT INTO t_log VALUES (1);');
    lab.sql(srv, 'COMMIT;');
    lab.sql(srv, 'ALTER SYSTEM SWITCH LOGFILE;');
    const arc = sh(srv, 'cat $(ls /u01/app/oracle/archivelog/*.arc | head -1)');
    expect(arc).toContain('ORACLE ARCHIVED REDO LOG');
    expect(arc.toUpperCase()).toContain('T_LOG');
  });

  it('TEMOIN — une base saine ne declare rien d irrecuperable', () => {
    const srv = lab.prod;
    lab.sql(srv, 'CREATE TABLE t_ordinaire (id NUMBER);');
    lab.sql(srv, 'INSERT INTO t_ordinaire VALUES (1);');
    lab.sql(srv, 'COMMIT;');
    expect(rman(srv, ['REPORT UNRECOVERABLE;', 'EXIT;']))
      .toContain('no files require backup due to unrecoverable operations');
    expect(lab.sql(srv, 'SELECT file# FROM v$nonlogged_block;'))
      .toMatch(/no rows selected/);
  });
});
