/*
 * Sonde — `RECOVER DATABASE` existe sous SQL*Plus, et une recuperation INCOMPLETE y exige `OPEN RESETLOGS`.
 *
 * Releve AVANT (laboratoire RMAN, base en ARCHIVELOG, sauvegardee puis restauree par RMAN, base montee) :
 *
 *   SQL> RECOVER DATABASE UNTIL CANCEL;     ->  SP2-0734: unknown command beginning "RECOVER DATABASE UNT..." - rest of line ignored.
 *   SQL> RECOVER DATABASE;                  ->  SP2-0734
 *
 * La forme historique de la recuperation, celle que le DBA tapait avant RMAN et que les cours enseignent encore (user-managed recovery), n'existait pas ; seul le
 * `RECOVER` de RMAN posait `markIncompleteRecovery`. Oracle (SQL*Plus User's Guide, RECOVER ; Backup and Recovery User's Guide) : `RECOVER [AUTOMATIC] DATABASE [UNTIL
 * CANCEL | TIME 'AAAA-MM-JJ:HH24:MI:SS' | CHANGE n]` applique les journaux archives et rend `Media recovery complete.` ; apres une recuperation incomplete, `ALTER DATABASE
 * OPEN` repond ORA-01589 et seul `OPEN RESETLOGS` ouvre. La commande passe par le meme moteur de recuperation que RMAN (une seule implementation).
 *
 * Discrimine par `git stash push -- src/database src/terminal` : 4 des 5 cas tombent. Le TEMOIN (le RECOVER de RMAN suivi d'un OPEN ordinaire ouvre sans RESETLOGS)
 * passe des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  resetAllOracleInstances();
  Logger.reset();
  lab = await buildRmanLab();
});

const rman = (script: string): string => lab.sh(lab.prod, `printf '${script}\\n' | rman target /`);
const sql = (statement: string): string => lab.sql(lab.prod, statement);

function restoredAndMounted(): void {
  rman('SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nSQL "ALTER DATABASE ARCHIVELOG";\\nALTER DATABASE OPEN;');
  sql('CREATE TABLE clients (id NUMBER);');
  sql('INSERT INTO clients VALUES (1);');
  sql('COMMIT;');
  rman('BACKUP DATABASE;');
  sql('INSERT INTO clients VALUES (2);');
  sql('COMMIT;');
  sql('ALTER SYSTEM SWITCH LOGFILE;');
  rman('SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nRESTORE DATABASE;');
}

describe('RECOVER sous SQL*Plus', () => {
  it('TEMOIN — le RECOVER de RMAN suivi d un OPEN ordinaire ouvre sans RESETLOGS', () => {
    restoredAndMounted();
    rman('RECOVER DATABASE;');
    expect(sql('ALTER DATABASE OPEN;')).not.toContain('ORA-01589');
  });

  it('RECOVER DATABASE rend Media recovery complete et la base s ouvre normalement', () => {
    restoredAndMounted();
    expect(sql('RECOVER DATABASE;')).toContain('Media recovery complete.');
    expect(sql('ALTER DATABASE OPEN;')).not.toContain('ORA-01589');
    expect(sql('SELECT COUNT(*) AS n FROM clients;')).toMatch(/\b2\b/);
  });

  it('RECOVER DATABASE UNTIL CANCEL est incomplete : OPEN refuse, OPEN RESETLOGS ouvre', () => {
    restoredAndMounted();
    expect(sql('RECOVER DATABASE UNTIL CANCEL;')).toContain('Media recovery complete.');
    expect(sql('ALTER DATABASE OPEN;')).toContain('ORA-01589');
    expect(sql('ALTER DATABASE OPEN RESETLOGS;')).toContain('Database altered.');
  });

  it('UNTIL CHANGE borne la recuperation et exige RESETLOGS', () => {
    restoredAndMounted();
    const scn = Number(/(\d{6,})/.exec(sql('SELECT checkpoint_change# AS n FROM v$database;'))?.[1] ?? '0');
    expect(sql(`RECOVER DATABASE UNTIL CHANGE ${scn + 1};`)).toContain('Media recovery complete.');
    expect(sql('ALTER DATABASE OPEN;')).toContain('ORA-01589');
  });

  it('une forme qui n existe pas est refusee comme Oracle la refuse', () => {
    restoredAndMounted();
    expect(sql('RECOVER FROBNICATE;')).toContain('ORA-00905');
  });
});
