/**
 * ALTER TABLESPACE — supports ADD DATAFILE, ONLINE/OFFLINE,
 * READ ONLY/WRITE, RENAME, BEGIN/END BACKUP, LOGGING/NOLOGGING/
 * FORCE LOGGING, FLASHBACK, SHRINK, COALESCE, RENAME DATAFILE.
 *
 * Each variant must mutate the catalog *and* (where applicable)
 * the underlying VFS via the bus, keeping v\$datafile, dba_data_files,
 * dba_tablespaces and the device filesystem in lockstep.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function setup(name: string) {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
  subShell.processLine(
    "CREATE TABLESPACE app_data DATAFILE '/u01/oradata/ORCL/app_data01.dbf' SIZE 100M;"
  );
  return subShell;
}

const sql = (s: ReturnType<typeof setup>, q: string) => s.processLine(q).output.join('\n');

describe('ALTER TABLESPACE …', () => {
  it('ADD DATAFILE adds a new datafile to the tablespace and writes it to VFS', () => {
    const s = setup('alter-add');
    sql(s, "ALTER TABLESPACE app_data ADD DATAFILE '/u01/oradata/ORCL/app_data02.dbf' SIZE 200M;");
    const files = sql(s, "SELECT file_name FROM dba_data_files WHERE tablespace_name='APP_DATA';");
    expect(files).toContain('app_data01.dbf');
    expect(files).toContain('app_data02.dbf');
    const ls = sql(s, 'HOST ls /u01/oradata/ORCL/');
    expect(ls).toContain('app_data02.dbf');
    s.dispose();
  });

  it('OFFLINE / ONLINE flips the STATUS in dba_tablespaces', () => {
    const s = setup('alter-offline');
    sql(s, 'ALTER TABLESPACE app_data OFFLINE;');
    expect(sql(s, "SELECT status FROM dba_tablespaces WHERE tablespace_name='APP_DATA';"))
      .toMatch(/OFFLINE/);
    sql(s, 'ALTER TABLESPACE app_data ONLINE;');
    expect(sql(s, "SELECT status FROM dba_tablespaces WHERE tablespace_name='APP_DATA';"))
      .toMatch(/ONLINE/);
    s.dispose();
  });

  it('READ ONLY / READ WRITE flips the STATUS', () => {
    const s = setup('alter-ro');
    sql(s, 'ALTER TABLESPACE app_data READ ONLY;');
    expect(sql(s, "SELECT status FROM dba_tablespaces WHERE tablespace_name='APP_DATA';"))
      .toMatch(/READ ONLY/);
    sql(s, 'ALTER TABLESPACE app_data READ WRITE;');
    expect(sql(s, "SELECT status FROM dba_tablespaces WHERE tablespace_name='APP_DATA';"))
      .toMatch(/ONLINE/);
    s.dispose();
  });

  it('RENAME TO renames the tablespace', () => {
    const s = setup('alter-rename');
    sql(s, 'ALTER TABLESPACE app_data RENAME TO app_data_v2;');
    const out = sql(s, 'SELECT tablespace_name FROM dba_tablespaces;');
    expect(out).toContain('APP_DATA_V2');
    expect(out).not.toMatch(/\bAPP_DATA\b/);
    s.dispose();
  });

  it('BEGIN/END BACKUP, LOGGING/NOLOGGING, FLASHBACK, SHRINK, COALESCE return success', () => {
    const s = setup('alter-misc');
    for (const stmt of [
      'ALTER TABLESPACE app_data BEGIN BACKUP;',
      'ALTER TABLESPACE app_data END BACKUP;',
      'ALTER TABLESPACE app_data NOLOGGING;',
      'ALTER TABLESPACE app_data LOGGING;',
      'ALTER TABLESPACE app_data FORCE LOGGING;',
      'ALTER TABLESPACE app_data NO FORCE LOGGING;',
      'ALTER TABLESPACE app_data FLASHBACK ON;',
      'ALTER TABLESPACE app_data FLASHBACK OFF;',
      'ALTER TABLESPACE app_data SHRINK SPACE;',
      'ALTER TABLESPACE app_data COALESCE;',
    ]) {
      const out = sql(s, stmt);
      expect(out, `failed: ${stmt}`).toMatch(/Tablespace altered\./i);
    }
    s.dispose();
  });

  it('RENAME DATAFILE moves the file on the VFS', () => {
    const s = setup('alter-rename-df');
    sql(s, "ALTER TABLESPACE app_data RENAME DATAFILE '/u01/oradata/ORCL/app_data01.dbf' TO '/u02/oradata/ORCL/app_data01.dbf';");
    expect(sql(s, 'HOST ls /u01/oradata/ORCL/')).not.toContain('app_data01.dbf');
    expect(sql(s, 'HOST ls /u02/oradata/ORCL/')).toContain('app_data01.dbf');
    s.dispose();
  });
});
