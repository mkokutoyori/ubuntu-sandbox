/*
 * Probe: the online restore of a datafile. Oracle Database Backup and Recovery User's Guide, "Performing Complete Database Recovery / Restoring and Recovering
 * Datafiles while the database is open": take the lost file offline (ALTER DATABASE DATAFILE n OFFLINE, which needs ARCHIVELOG mode: ORA-01145 otherwise),
 * RESTORE DATAFILE n, RECOVER DATAFILE n, bring it online; the rest of the database keeps working meanwhile. The simulator accepted ALTER DATABASE DATAFILE n
 * OFFLINE/ONLINE and ignored it (V$DATAFILE stayed ONLINE), let queries and DML through on an OFFLINE tablespace, refused every RESTORE under an open database
 * (RMAN-06403), and brought a file online whatever its state. Now: a datafile has its own online/offline state (V$DATAFILE, DBA_DATA_FILES); a statement that
 * touches a table of an offline file is ORA-00376 + ORA-01110, as is a tablespace taken offline; ONLINE refuses a file missing on disk (ORA-01157) and a file
 * restored but not recovered (ORA-01113, status RECOVER); RESTORE DATAFILE/TABLESPACE runs under an open database for offline targets and is refused for an online
 * one with the enqueue error (ORA-19573); RECOVER clears the state. RESTORE DATABASE still needs MOUNT.
 *
 * Discriminated with git stash on src: 7 of 10 fall before the fix; three pass either way: the witness that a table of another tablespace stays usable, the
 * witness that RESTORE DATABASE under an open database stays refused, and OFFLINE FOR DROP, which the base accepted by accepting everything.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

const FILE = '/u01/app/oracle/oradata/ORCL/shop_data01.dbf';
let lab: RmanLab;

const sql = (statement: string) => lab.sql(lab.prod, statement);
const rman = (...lines: string[]) => lab.sh(lab.prod, `rman target / <<'EOF'\n${lines.join('\n')}\nEOF`);

async function prepare(archivelog: boolean): Promise<void> {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset(); BackupKey._reset(); DeviceCatalogRegistry._reset();
  lab = await buildRmanLab();
  if (archivelog) {
    sql('SHUTDOWN IMMEDIATE;'); sql('STARTUP MOUNT;'); sql('ALTER DATABASE ARCHIVELOG;'); sql('ALTER DATABASE OPEN;');
  }
  sql(`CREATE TABLESPACE shop_data DATAFILE '${FILE}' SIZE 50M;`);
  sql('CREATE TABLE system.orders (id NUMBER) TABLESPACE shop_data;');
  sql('CREATE TABLE system.other (id NUMBER) TABLESPACE users;');
  sql('INSERT INTO system.orders VALUES (1);');
  sql('INSERT INTO system.other VALUES (1);');
  sql('COMMIT;');
}

describe('datafile offline and online restore', () => {
  beforeEach(async () => { await prepare(true); });

  it('ALTER DATABASE DATAFILE n OFFLINE is reflected by V$DATAFILE', () => {
    expect(sql('ALTER DATABASE DATAFILE 5 OFFLINE;')).toContain('Database altered.');
    expect(sql('SELECT status FROM v$datafile WHERE file# = 5;')).toContain('OFFLINE');
    expect(sql('SELECT online_status FROM dba_data_files WHERE file_id = 5;')).toContain('OFFLINE');
  });

  it('a table of an offline file is ORA-00376 for queries and DML, with the file in ORA-01110', () => {
    sql('ALTER DATABASE DATAFILE 5 OFFLINE;');
    const read = sql('SELECT COUNT(*) FROM system.orders;');
    expect(read).toContain('ORA-00376: file 5 cannot be read at this time');
    expect(read).toContain(`ORA-01110: data file 5: '${FILE}'`);
    expect(sql('INSERT INTO system.orders VALUES (2);')).toContain('ORA-00376');
    expect(sql('DELETE FROM system.orders;')).toContain('ORA-00376');
  });

  it('witness: a table of another tablespace stays usable meanwhile', () => {
    sql('ALTER DATABASE DATAFILE 5 OFFLINE;');
    expect(sql('SELECT COUNT(*) FROM system.other;')).toMatch(/\b1\b/);
    expect(sql('INSERT INTO system.other VALUES (2);')).toContain('1 row created.');
  });

  it('a tablespace taken offline blocks its tables the same way', () => {
    sql('ALTER TABLESPACE shop_data OFFLINE NORMAL;');
    expect(sql('SELECT COUNT(*) FROM system.orders;')).toContain('ORA-00376');
    sql('ALTER TABLESPACE shop_data ONLINE;');
    expect(sql('SELECT COUNT(*) FROM system.orders;')).toMatch(/\b1\b/);
  });

  it('the whole chain: lose the file, take it offline, RESTORE and RECOVER under an open database, bring it online', () => {
    rman("BACKUP DATABASE FORMAT '/u01/app/oracle/fast_recovery_area/b_%U';");
    sql('INSERT INTO system.orders VALUES (2);'); sql('COMMIT;'); sql('ALTER SYSTEM SWITCH LOGFILE;');
    sql('ALTER DATABASE DATAFILE 5 OFFLINE;');
    lab.sh(lab.prod, `rm -f ${FILE}`);
    const missing = sql('ALTER DATABASE DATAFILE 5 ONLINE;');
    expect(missing).toContain('ORA-01157: cannot identify/lock data file 5');
    expect(missing).toContain(`ORA-01110: data file 5: '${FILE}'`);
    const restored = rman('RESTORE DATAFILE 5;');
    expect(restored).not.toContain('RMAN-06403');
    expect(restored).toContain('restore');
    expect(lab.sh(lab.prod, `ls ${FILE}`)).toContain('shop_data01.dbf');
    const notRecovered = sql('ALTER DATABASE DATAFILE 5 ONLINE;');
    expect(notRecovered).toContain('ORA-01113: file 5 needs media recovery');
    expect(sql('SELECT status FROM v$datafile WHERE file# = 5;')).toContain('RECOVER');
    rman('RECOVER DATAFILE 5;');
    expect(sql('ALTER DATABASE DATAFILE 5 ONLINE;')).toContain('Database altered.');
    expect(sql('SELECT status FROM v$datafile WHERE file# = 5;')).toContain('ONLINE');
    expect(sql('SELECT COUNT(*) FROM system.orders;')).toMatch(/\b2\b/);
  });

  it('RESTORE TABLESPACE works the same way for an offline tablespace', () => {
    rman("BACKUP DATABASE FORMAT '/u01/app/oracle/fast_recovery_area/t_%U';");
    sql('ALTER SYSTEM SWITCH LOGFILE;');
    sql('ALTER TABLESPACE shop_data OFFLINE NORMAL;');
    const output = rman('RESTORE TABLESPACE shop_data;', 'RECOVER TABLESPACE shop_data;');
    expect(output).not.toContain('RMAN-06403');
    expect(sql('ALTER TABLESPACE shop_data ONLINE;')).toContain('Tablespace altered.');
  });

  it('RESTORE of an online datafile under an open database is refused with the enqueue error', () => {
    rman("BACKUP DATABASE FORMAT '/u01/app/oracle/fast_recovery_area/o_%U';");
    const output = rman('RESTORE DATAFILE 5;');
    expect(output).toContain('ORA-19573: cannot obtain exclusive enqueue for datafile 5');
  });

  it('witness: RESTORE DATABASE under an open database stays refused', () => {
    rman("BACKUP DATABASE FORMAT '/u01/app/oracle/fast_recovery_area/d_%U';");
    expect(rman('RESTORE DATABASE;')).toContain('RMAN-06403');
  });
});

describe('without ARCHIVELOG mode', () => {
  beforeEach(async () => { await prepare(false); });

  it('a datafile cannot be taken offline (ORA-01145), a tablespace OFFLINE IMMEDIATE neither', () => {
    expect(sql('ALTER DATABASE DATAFILE 5 OFFLINE;')).toContain('ORA-01145');
    expect(sql('ALTER TABLESPACE shop_data OFFLINE IMMEDIATE;')).toContain('ORA-01145');
  });

  it('OFFLINE FOR DROP and a normal tablespace OFFLINE stay possible', () => {
    expect(sql('ALTER DATABASE DATAFILE 5 OFFLINE FOR DROP;')).toContain('Database altered.');
  });
});
