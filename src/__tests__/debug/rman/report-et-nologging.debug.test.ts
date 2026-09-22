/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * Deux sites qui portent la meme forme, la regle 6 : un critere lu par
 * le parseur, RENDU dans la sortie, et jamais evalue.
 *
 *   1. `REPORT NEED BACKUP REDUNDANCY n` analyse le n, l'imprime dans
 *      son en-tete de politique, puis calcule « a besoin » comme
 *      « aucune sauvegarde ne couvre ce fichier ». Le n ne decide rien.
 *   2. `ALTER TABLESPACE x NOLOGGING` est stocke (`ts.logging`), rendu
 *      par DBA_TABLESPACES, et — d'apres le commentaire de
 *      `OracleStorage` — « affects whether DML against the tablespace
 *      generates redo ». Ce banc mesure si c'est vrai.
 *
 * Et `REPORT UNRECOVERABLE` porte en clair : « The simulator has no
 * NOLOGGING tracking, so the report is always empty. » Le suivi existe
 * pourtant — `ts.logging`, `DBA_TABLESPACES`, `V$NONLOGGED_BLOCK`.
 *
 * Le gabarit d'Oracle, pour memoire :
 *   Report of files with less than <n> redundant backups
 *   File #bkps Name
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

const note = (l: string) => { console.log(l); };
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

describe('REPORT et NOLOGGING', () => {
  it('releve', () => {
    const srv = lab.prod;

    note('[a] REPORT NEED BACKUP, base neuve (aucune sauvegarde) :');
    note(rman(srv, ['REPORT NEED BACKUP;', 'EXIT;']).slice(-700));

    note('');
    note('[b] UNE sauvegarde, puis REPORT NEED BACKUP REDUNDANCY 3 :');
    rman(srv, ['BACKUP DATABASE;', 'EXIT;']);
    note(rman(srv, ['REPORT NEED BACKUP REDUNDANCY 3;', 'EXIT;']).slice(-800));
    note('       attendu par la regle : les 4 fichiers, avec #bkps = 1');

    note('');
    note('[c] REPORT NEED BACKUP REDUNDANCY 1 sur la meme base :');
    note(rman(srv, ['REPORT NEED BACKUP REDUNDANCY 1;', 'EXIT;']).slice(-600));
    note('       attendu : aucun fichier');

    note('');
    note('[d] NOLOGGING : la vue le dit-elle, et le redo change-t-il ?');
    note(lab.sql(srv, 'ALTER TABLESPACE USERS NOLOGGING;'));
    note(lab.sql(srv,
      "SELECT tablespace_name, logging FROM dba_tablespaces WHERE tablespace_name = 'USERS';"));
    const db = (globalThis as Record<string, unknown>);
    void db;
    lab.sql(srv, 'CREATE TABLE t_nolog (id NUMBER) TABLESPACE USERS;');
    lab.sql(srv, 'INSERT INTO t_nolog VALUES (1);');
    lab.sql(srv, 'COMMIT;');
    note('[d-1] V$NONLOGGED_BLOCK apres une ecriture en NOLOGGING :');
    note(lab.sql(srv, 'SELECT file#, blocks, reason FROM v$nonlogged_block;'));

    note('');
    note('[e] REPORT UNRECOVERABLE apres cette ecriture :');
    note(rman(srv, ['REPORT UNRECOVERABLE;', 'EXIT;']).slice(-600));
    note('       attendu par la regle : le fichier de USERS, « full or');
    note('       incremental », puisqu aucun redo ne peut le rejouer.');

    note('');
    note('[f] le journal archive porte-t-il quand meme le changement ?');
    note(lab.sql(srv, 'ALTER SYSTEM SWITCH LOGFILE;'));
    note(`[f-1] archivelogs : ${sh(srv, 'ls /u01/app/oracle/archivelog').replace(/\n/g, ' ')}`);

    expect(true).toBe(true);
  });
});
