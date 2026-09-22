/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * Deuxieme des trois morceaux du chantier Data Guard. Le transport est
 * ferme (lot R13) : le journal archive traverse le fil et la standby
 * l'ecrit. Restait ce que CLAUDE.md nomme encore : « ALTER DATABASE
 * RECOVER MANAGED STANDBY DATABASE still answers `Database altered.`
 * without applying anything, so the standby's SCN never advances. »
 *
 * Ce banc mesure la question qui decide : une ligne inseree sur le
 * PRIMAIRE se retrouve-t-elle dans la base de la STANDBY apres
 * application ?
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

const note = (l: string) => { console.log(l); };
let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  lab = await buildRmanLab();
});

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

describe('Data Guard : l application du redo', () => {
  it('releve', () => {
    const { prod, dr } = lab;
    for (const s of [prod, dr]) {
      const db = getOracleDatabase(s.getId());
      (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
    }
    lab.sql(prod,
      `ALTER SYSTEM SET LOG_ARCHIVE_DEST_2 = 'SERVICE=${lab.drIp}:1521/ORCL ASYNC DB_UNIQUE_NAME=DR';`);
    lab.sql(prod, 'ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_2 = ENABLE;');

    note('[a] on demarre la recuperation geree sur la standby :');
    note(lab.sql(dr, 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;'));

    note('');
    note('[b] une table et une ligne sur le PRIMAIRE, puis un switch :');
    lab.sql(prod, 'CREATE TABLE clients (id NUMBER);');
    lab.sql(prod, 'INSERT INTO clients VALUES (1);');
    lab.sql(prod, 'COMMIT;');
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    note(`[b-1] PROD  : ${lab.sql(prod, 'SELECT COUNT(*) FROM clients;').replace(/\n/g, ' ')}`);

    note('');
    note('[c] la standby a-t-elle APPLIQUE ?');
    note(`[c-1] journaux recus : ${sh(dr, 'ls /u01/app/oracle/archivelog').replace(/\n/g, ' ')}`);
    note(`[c-2] alert log MRP : ${
      sh(dr, 'grep -E "MRP|Media Recovery" /u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log')
        .split('\n').slice(0, 3).join(' | ')}`);
    note('[c-3] la ligne est-elle visible sur DR ?');
    note(lab.sql(dr, 'SELECT COUNT(*) FROM clients;').replace(/\n/g, ' '));

    note('');
    note('[d] les vues de la standby :');
    note(lab.sql(dr, 'SELECT sequence#, name FROM v$archived_log;'));
    note(lab.sql(prod, 'SELECT name, value FROM v$dataguard_stats;'));

    note('');
    note('[e] CANCEL, une deuxieme ligne, et ce que la standby voit alors :');
    note(lab.sql(dr, 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE CANCEL;'));
    lab.sql(prod, 'INSERT INTO clients VALUES (2);');
    lab.sql(prod, 'COMMIT;');
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    note(`[e-1] PROD : ${lab.sql(prod, 'SELECT COUNT(*) FROM clients;').replace(/\n/g, ' ')}`);
    note(`[e-2] DR   : ${lab.sql(dr, 'SELECT COUNT(*) FROM clients;').replace(/\n/g, ' ')}`);

    expect(true).toBe(true);
  });
});
