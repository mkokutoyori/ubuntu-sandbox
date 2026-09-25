/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * Troisieme passage : la commande est desormais declaree, et ce banc
 * mesure ce qu'elle produit reellement de bout en bout, plus les
 * pre-conditions qu'un vrai RMAN exige (auxiliaire NOMOUNT, session
 * AUXILIARY par Oracle Net, `alter database mount standby database`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
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

describe('DUPLICATE pour standby, de bout en bout', () => {
  it('releve', () => {
    const { prod, dr } = lab;
    for (const s of [prod, dr]) {
      const db = getOracleDatabase(s.getId());
      (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
    }
    lab.sql(prod, 'CREATE TABLE clients (id NUMBER);');
    lab.sql(prod, 'INSERT INTO clients VALUES (1);');
    lab.sql(prod, 'COMMIT;');
    lab.sql(dr, 'SHUTDOWN IMMEDIATE;');
    lab.sql(dr, 'STARTUP NOMOUNT;');

    note('[a] sans NOFILENAMECHECK, que dit-il ?');
    note(rman(prod, [
      `CONNECT AUXILIARY sys/oracle@${lab.drIp}:1521/ORCL;`,
      'DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE;',
      'EXIT;',
    ]).slice(-500));

    note('');
    note('[b] la forme complete');
    note(rman(prod, [
      `CONNECT AUXILIARY sys/oracle@${lab.drIp}:1521/ORCL;`,
      'DUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE DORECOVER NOFILENAMECHECK;',
      'EXIT;',
    ]).slice(-1200));

    note('');
    note('[c] la standby existe-t-elle vraiment ?');
    note(`[c-1] role/open_mode DR : ${lab.sql(dr, 'SELECT database_role, open_mode FROM v$database;').replace(/\n/g, ' ')}`);
    note(`[c-2] datafiles DR     : ${sh(dr, 'ls /u01/app/oracle/oradata/ORCL').replace(/\n/g, ' ')}`);
    note(`[c-3] V$DATAFILE DR    : ${lab.sql(dr, 'SELECT file#, name FROM v$datafile;').replace(/\n/g, ' ').slice(0, 160)}`);
    note(`[c-4] lecture DR       : ${lab.sql(dr, 'SELECT COUNT(*) FROM clients;').replace(/\n/g, ' ').slice(0, 90)}`);
    note(`[c-5] alert DR         : ${sh(dr, 'grep -E "standby|Datafile" /u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log').replace(/\n/g, ' | ').slice(-300)}`);

    note('');
    note('[d] apres FAILOVER puis ouverture, les lignes du primaire sont-elles la ?');
    note(`[d-1] ${lab.sql(dr, 'ALTER DATABASE FAILOVER TO DR;').replace(/\n/g, ' ')}`);
    note(`[d-2] ${lab.sql(dr, 'ALTER DATABASE OPEN;').replace(/\n/g, ' ')}`);
    note(`[d-3] COUNT sur DR : ${lab.sql(dr, 'SELECT COUNT(*) FROM clients;').replace(/\n/g, ' ').slice(0, 90)}`);

    note('');
    note('[e] RESTORE DATABASE PREVIEW');
    rman(prod, ['BACKUP DATABASE;', 'EXIT;']);
    note(rman(prod, ['RESTORE DATABASE PREVIEW;', 'EXIT;']).slice(-1400));

    note('');
    note('[f] la FORME des tableaux : en-tete, filet et donnees sortent-ils du meme calcul ?');
    rman(prod, ['BACKUP INCREMENTAL LEVEL 0 DATABASE;', 'BACKUP ARCHIVELOG ALL;', 'EXIT;']);
    for (const cmd of ['LIST BACKUP', 'LIST BACKUP SUMMARY', 'LIST INCARNATION']) {
      note(`--- ${cmd}`);
      note(rman(prod, [`${cmd};`, 'EXIT;']).split('\n')
        .filter(l => !/^(Recovery Manager|Copyright|connected|$)/.test(l)).join('\n'));
    }

    expect(true).toBe(true);
  });
});
