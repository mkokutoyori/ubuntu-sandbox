/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * CLAUDE.md nomme la limite : « Data Guard switchover() swaps two role
 * fields; there is no redo transport. » En la mesurant, on trouve plus
 * bas encore : AUCUNE commande ne permet de declarer une standby. Les
 * quatre vues V$DATAGUARD_* couvrent un objet memoire que personne ne
 * peuple.
 *
 * Ce banc mesure le chemin qu'un vrai Data Guard emprunte, dans l'ordre
 * ou un operateur le tape :
 *
 *   ALTER SYSTEM SET LOG_ARCHIVE_DEST_2 = 'SERVICE=dr ASYNC
 *     VALID_FOR=(ONLINE_LOGFILES,PRIMARY_ROLE) DB_UNIQUE_NAME=DR';
 *   ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_2 = ENABLE;
 *   ALTER SYSTEM SWITCH LOGFILE;
 *
 * et la question qui decide de tout : le journal archive arrive-t-il
 * sur le DISQUE de la standby, en ayant traverse le fil ?
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

const note = (l: string) => { console.log(l); };
const ARC_DIR = '/u01/app/oracle/archivelog';
let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  lab = await buildRmanLab();
});

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

describe('Data Guard : le transport du redo', () => {
  it('releve', () => {
    const prod = lab.prod;
    const dr = lab.dr;
    const db = getOracleDatabase(prod.getId());
    (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
    const dbDr = getOracleDatabase(dr.getId());
    (dbDr.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;

    note('[a] la standby peut-elle seulement etre declaree ?');
    for (const stmt of [
      `ALTER SYSTEM SET LOG_ARCHIVE_DEST_2 = 'SERVICE=${lab.drIp}:1521/ORCL ASYNC DB_UNIQUE_NAME=DR';`,
      'ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_2 = ENABLE;',
      'ALTER DATABASE ADD STANDBY LOGFILE;',
      'ALTER DATABASE RECOVER MANAGED STANDBY DATABASE DISCONNECT FROM SESSION;',
    ]) {
      const out = lab.sql(prod, stmt).replace(/\n/g, ' ');
      note(`[a] ${stmt.slice(0, 56).padEnd(58)} ${out.slice(0, 60)}`);
    }

    note('');
    note('[b] la valeur est-elle au moins STOCKEE et rendue ?');
    note(lab.sql(prod, 'SHOW PARAMETER log_archive_dest_2'));
    note(lab.sql(prod, 'SELECT dest_id, destination, status FROM v$archive_dest WHERE dest_id <= 3;'));

    note('');
    note('[c] les vues Data Guard, sur une base qui a « declare » une standby :');
    note(lab.sql(prod, 'SELECT * FROM v$dataguard_config;'));
    note(lab.sql(prod, 'SELECT name, value FROM v$dataguard_stats;'));

    note('');
    note('[d] un switch : ou le journal atterrit-il ?');
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    note(`[d-1] PROD ${ARC_DIR} : ${sh(prod, `ls ${ARC_DIR}`).replace(/\n/g, ' ')}`);
    note(`[d-2] DR   ${ARC_DIR} : ${sh(dr, `ls ${ARC_DIR}`).replace(/\n/g, ' ')}`);

    note(`[d-3] V$ARCHIVE_DEST apres le switch :`);
    note(lab.sql(prod, 'SELECT dest_id, destination, status, log_sequence FROM v$archive_dest WHERE dest_id <= 3;'));
    note('[d-3b] V$ARCHIVE_DEST_STATUS (l erreur exacte) :');
    note(lab.sql(prod, 'SELECT dest_id, status, error FROM v$archive_dest_status WHERE dest_id = 2;'));
    note('[d-4] V$DATAGUARD_STATS :');
    note(lab.sql(prod, 'SELECT name, value FROM v$dataguard_stats;'));
    note('[d-5] la standby a-t-elle ENREGISTRE le journal ?');
    note(lab.sql(dr, 'SELECT sequence#, name FROM v$archived_log;'));
    note(`[d-6] le CORPS recu est-il celui de PROD ?`);
    note(`      PROD : ${sh(prod, `head -c 50 ${ARC_DIR}/1_1_arc.arc`)}`);
    note(`      DR   : ${sh(dr, `head -c 50 ${ARC_DIR}/1_1_arc.arc`)}`);
    note(`      identiques : ${
      sh(prod, `cat ${ARC_DIR}/1_1_arc.arc`) === sh(dr, `cat ${ARC_DIR}/1_1_arc.arc`) ? 'OUI' : 'non'}`);
    note(`[d-7] alert log de DR : ${
      sh(dr, 'grep RFS /u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log').split('\n').slice(0, 2).join(' | ')}`);

    note('');
    note('[e] une destination injoignable :');
    lab.sql(prod, "ALTER SYSTEM SET LOG_ARCHIVE_DEST_3 = 'SERVICE=fantome ASYNC';");
    lab.sql(prod, 'ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_3 = ENABLE;');
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    note(lab.sql(prod, 'SELECT dest_id, status FROM v$archive_dest WHERE dest_id = 3;'));

    expect(true).toBe(true);
  });
});
