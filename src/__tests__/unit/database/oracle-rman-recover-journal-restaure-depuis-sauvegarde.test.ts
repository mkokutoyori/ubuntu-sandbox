/*
 * Sonde — un RECOVER qui doit extraire un journal archive de sa sauvegarde le DIT, au lieu d'affirmer qu'il est « already on disk ».
 *
 * Releve AVANT (laboratoire RMAN, ARCHIVELOG, sauvegarde de la base, deux changements de journal, `BACKUP ARCHIVELOG ALL DELETE INPUT` : plus aucun .arc sur le disque) :
 *   RESTORE DATAFILE puis RECOVER DATAFILE -> « archived log for thread 1 with sequence N is already on disk as file ... » alors que le fichier venait d'etre recree depuis la
 *   piece de sauvegarde : le texte contredisait l'etat, et un lecteur qui venait de lire `LIST ARCHIVELOG ALL` -> « specification does not match any archived log » ne comprenait plus.
 * Oracle (Backup and Recovery Reference, RECOVER) restaure alors le journal : `starting archived log restore to default destination`, `restoring archived log`, `reading from backup piece`,
 * `restored backup piece 1`, puis `archived log file name=... thread=1 sequence=N` ; la forme « is already on disk » n'est dite que pour un journal deja present.
 *
 * Discrimine par `git stash push -- src/terminal` : 2 des 3 cas tombent avant. TEMOIN : un journal encore sur le disque garde « is already on disk » (passe des deux cotes).
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

function lostDatafileAfterArchiveBackup(deleteInput: boolean): string {
  rman('SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nSQL "ALTER DATABASE ARCHIVELOG";\\nALTER DATABASE OPEN;');
  sql('CREATE TABLE clients (id NUMBER);');
  sql('INSERT INTO clients VALUES (1);');
  sql('COMMIT;');
  rman('BACKUP DATABASE;');
  sql('INSERT INTO clients VALUES (2);');
  sql('COMMIT;');
  sql('ALTER SYSTEM SWITCH LOGFILE;');
  rman(deleteInput ? 'BACKUP ARCHIVELOG ALL DELETE INPUT;' : 'BACKUP ARCHIVELOG ALL;');
  lab.sh(lab.prod, 'rm -f /u01/app/oracle/oradata/ORCL/users01.dbf');
  rman('SHUTDOWN ABORT;');
  rman('STARTUP MOUNT;');
  return rman('RESTORE DATAFILE 4;\\nRECOVER DATAFILE 4;');
}

describe('RECOVER and the archived logs it needs', () => {
  it('TEMOIN — a log still on disk is applied as already on disk', () => {
    const out = lostDatafileAfterArchiveBackup(false);
    expect(out).toMatch(/is already on disk as file \S+\.arc/);
    expect(out).not.toContain('restoring archived log');
  });

  it('a log deleted after its backup is restored from the backup piece, and says so', () => {
    const out = lostDatafileAfterArchiveBackup(true);
    expect(out).toContain('channel ORA_DISK_1: starting archived log restore to default destination');
    expect(out).toMatch(/channel ORA_DISK_1: reading from backup piece \S+\.bkp/);
  });

  it('the restored log is then named by its file, not claimed to be on disk beforehand', () => {
    const out = lostDatafileAfterArchiveBackup(true);
    expect(out).toMatch(/archived log file name=\S+\.arc thread=1 sequence=\d+/);
    expect(out).not.toContain('is already on disk');
  });
});
