/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * Troisieme et dernier morceau du chantier Data Guard. Le transport
 * (R13) et l'application (R14) sont fermes. CLAUDE.md nomme ce qui
 * reste : « switchover() still swaps two role fields without moving
 * data, and nothing enforces which side may be written. »
 *
 * Ce banc mesure les deux moities de ce qui manque :
 *   - une standby accepte-t-elle des ECRITURES ? (elle ne devrait pas :
 *     c'est ce qui la distingue d'une copie)
 *   - la bascule existe-t-elle comme COMMANDE, et deplace-t-elle les
 *     roles des DEUX cotes ?
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

describe('Data Guard : la bascule', () => {
  it('releve', () => {
    const { prod, dr } = lab;
    for (const s of [prod, dr]) {
      const db = getOracleDatabase(s.getId());
      (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
    }
    lab.sql(prod,
      `ALTER SYSTEM SET LOG_ARCHIVE_DEST_2 = 'SERVICE=${lab.drIp}:1521/ORCL ASYNC DB_UNIQUE_NAME=DR';`);
    lab.sql(prod, 'ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_2 = ENABLE;');
    lab.sql(dr, 'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;');
    lab.sql(prod, 'CREATE TABLE clients (id NUMBER);');
    lab.sql(prod, 'INSERT INTO clients VALUES (1);');
    lab.sql(prod, 'COMMIT;');
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');

    note('[a] quel ROLE chaque cote annonce-t-il ?');
    note(`[a-1] PROD : ${lab.sql(prod, 'SELECT database_role, open_mode FROM v$database;').replace(/\n/g, ' ')}`);
    note(`[a-2] DR   : ${lab.sql(dr, 'SELECT database_role, open_mode FROM v$database;').replace(/\n/g, ' ')}`);
    note(`[a-3] SWITCHOVER_STATUS existe-t-il ? ${
      lab.sql(prod, 'SELECT switchover_status FROM v$database;').replace(/\n/g, ' ').slice(0, 80)}`);

    note('');
    note('[b] la standby accepte-t-elle une ECRITURE ?');
    note(`[b-1] INSERT sur DR : ${lab.sql(dr, 'INSERT INTO clients VALUES (99);').replace(/\n/g, ' ')}`);
    note(`[b-2] COMMIT sur DR : ${lab.sql(dr, 'COMMIT;').replace(/\n/g, ' ')}`);
    note(`[b-3] DR compte    : ${lab.sql(dr, 'SELECT COUNT(*) FROM clients;').replace(/\n/g, ' ')}`);
    note(`[b-4] CREATE TABLE sur DR : ${lab.sql(dr, 'CREATE TABLE t_sur_standby (id NUMBER);').replace(/\n/g, ' ')}`);

    note('');
    note('[c] la bascule existe-t-elle comme commande ?');
    for (const stmt of [
      'ALTER DATABASE SWITCHOVER TO DR;',
      'ALTER DATABASE COMMIT TO SWITCHOVER TO PHYSICAL STANDBY;',
      'ALTER DATABASE FAILOVER TO DR;',
      'ALTER DATABASE ACTIVATE STANDBY DATABASE;',
    ]) {
      note(`[c] ${stmt.padEnd(56)} ${lab.sql(prod, stmt).replace(/\n/g, ' ').slice(0, 50)}`);
    }

    note('');
    note('[d] apres ces commandes, les roles ont-ils bouge ?');
    note(`[d-1] PROD : ${lab.sql(prod, 'SELECT database_role FROM v$database;').replace(/\n/g, ' ')}`);
    note(`[d-2] DR   : ${lab.sql(dr, 'SELECT database_role FROM v$database;').replace(/\n/g, ' ')}`);

    expect(true).toBe(true);
  });
});
