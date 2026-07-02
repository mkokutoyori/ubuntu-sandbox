/**
 * Scenario 3 — tablespace lifecycle: creation, AUTOEXTEND, saturation,
 * ORA-01653, manual datafile addition, alert-log traceability.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances, getOracleDatabase } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function boot(name: string) {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  const { subShell } = SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']);
  return { srv, subShell };
}

const sql = (s: ReturnType<typeof boot>['subShell'], q: string) => s.processLine(q).output.join('\n');

describe('DBA_TABLESPACES / DBA_DATA_FILES / DBA_FREE_SPACE agree with the tablespace definition', () => {
  it('a freshly created tablespace reports its declared size as fully free', () => {
    const { subShell: s } = boot('ts1');
    sql(s, "CREATE TABLESPACE reporting DATAFILE '/u01/app/oracle/oradata/ORCL/reporting01.dbf' SIZE 1M;");

    expect(sql(s, "SELECT tablespace_name, status FROM dba_tablespaces WHERE tablespace_name='REPORTING';"))
      .toMatch(/REPORTING\s+ONLINE/);

    const df = sql(s, "SELECT file_name, bytes, autoextensible FROM dba_data_files WHERE tablespace_name='REPORTING';");
    expect(df).toContain('reporting01.dbf');
    expect(df).toMatch(/1048576/);
    expect(df).toMatch(/\bNO\b/);

    const free = sql(s, "SELECT bytes FROM dba_free_space WHERE tablespace_name='REPORTING';");
    expect(free).toMatch(/1048576/);
    s.dispose();
  });

  it('free space shrinks as rows are inserted and grows back after DELETE', () => {
    const { subShell: s } = boot('ts2');
    sql(s, "CREATE TABLESPACE ledger DATAFILE '/u01/app/oracle/oradata/ORCL/ledger01.dbf' SIZE 1M;");
    sql(s, 'CREATE TABLE ledger.entries (x VARCHAR2(10)) TABLESPACE ledger;');

    const freeBefore = Number(sql(s, "SELECT bytes FROM dba_free_space WHERE tablespace_name='LEDGER';").match(/\d+/)![0]);
    for (let i = 0; i < 100; i++) sql(s, `INSERT INTO ledger.entries VALUES ('${i}');`);
    const freeAfterInsert = Number(sql(s, "SELECT bytes FROM dba_free_space WHERE tablespace_name='LEDGER';").match(/\d+/)![0]);
    expect(freeAfterInsert).toBeLessThan(freeBefore);
    expect(freeBefore - freeAfterInsert).toBe(100 * 200);

    sql(s, 'DELETE FROM ledger.entries;');
    const freeAfterDelete = Number(sql(s, "SELECT bytes FROM dba_free_space WHERE tablespace_name='LEDGER';").match(/\d+/)![0]);
    expect(freeAfterDelete).toBe(freeBefore);
    s.dispose();
  });
});

describe('AUTOEXTEND grows a datafile transparently as a tablespace fills up', () => {
  it('inserts keep succeeding past the initial size while AUTOEXTEND has room under MAXSIZE', () => {
    const { srv, subShell: s } = boot('ts3');
    sql(s, "CREATE TABLESPACE app_growth DATAFILE '/u01/app/oracle/oradata/ORCL/app_growth01.dbf' "
      + 'SIZE 8K AUTOEXTEND ON NEXT 8K MAXSIZE 64K;');
    sql(s, 'CREATE TABLE app_growth.orders (item VARCHAR2(10)) TABLESPACE app_growth;');

    for (let i = 0; i < 100; i++) {
      const out = sql(s, `INSERT INTO app_growth.orders VALUES ('o${i}');`);
      expect(out).toMatch(/1 row created/);
    }

    const bytes = Number(sql(s, "SELECT bytes FROM dba_data_files WHERE tablespace_name='APP_GROWTH';").match(/\d+/)![0]);
    expect(bytes).toBeGreaterThan(8 * 1024);
    expect(bytes).toBeLessThanOrEqual(64 * 1024);

    const alert = getOracleDatabase(srv.getId()).instance.getAlertLog();
    const extendLine = alert.find(l => l.includes('Extending datafile') && l.includes('app_growth01.dbf'));
    expect(extendLine).toBeDefined();
    expect(extendLine).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}:/);
    s.dispose();
  });

  it('saturating a tablespace at its MAXSIZE raises ORA-01653', () => {
    const { subShell: s } = boot('ts4');
    sql(s, "CREATE TABLESPACE app_capped DATAFILE '/u01/app/oracle/oradata/ORCL/app_capped01.dbf' "
      + 'SIZE 8K AUTOEXTEND ON NEXT 8K MAXSIZE 16K;');
    sql(s, 'CREATE TABLE app_capped.orders (item VARCHAR2(10)) TABLESPACE app_capped;');

    let failure = '';
    for (let i = 0; i < 200 && !failure; i++) {
      const out = sql(s, `INSERT INTO app_capped.orders VALUES ('o${i}');`);
      if (/ORA-01653/.test(out)) failure = out;
    }
    expect(failure).toMatch(/ORA-01653/);
    expect(failure).toMatch(/APP_CAPPED\.ORDERS/);
    expect(failure).toMatch(/APP_CAPPED/);
    s.dispose();
  });

  it('a tablespace without AUTOEXTEND fails immediately at its declared size', () => {
    const { subShell: s } = boot('ts5');
    sql(s, "CREATE TABLESPACE app_fixed DATAFILE '/u01/app/oracle/oradata/ORCL/app_fixed01.dbf' SIZE 8K;");
    sql(s, 'CREATE TABLE app_fixed.orders (item VARCHAR2(10)) TABLESPACE app_fixed;');

    let failure = '';
    for (let i = 0; i < 200 && !failure; i++) {
      const out = sql(s, `INSERT INTO app_fixed.orders VALUES ('o${i}');`);
      if (/ORA-01653/.test(out)) failure = out;
    }
    expect(failure).toMatch(/ORA-01653/);

    const df = sql(s, "SELECT autoextensible FROM dba_data_files WHERE tablespace_name='APP_FIXED';");
    expect(df).toMatch(/\bNO\b/);
    s.dispose();
  });
});

describe('adding a datafile unblocks a saturated tablespace without an instance restart', () => {
  it('ALTER TABLESPACE ADD DATAFILE lets INSERT succeed again immediately', () => {
    const { srv, subShell: s } = boot('ts6');
    sql(s, "CREATE TABLESPACE app_relief DATAFILE '/u01/app/oracle/oradata/ORCL/app_relief01.dbf' SIZE 8K;");
    sql(s, 'CREATE TABLE app_relief.orders (item VARCHAR2(10)) TABLESPACE app_relief;');

    let failure = '';
    for (let i = 0; i < 200 && !failure; i++) {
      const out = sql(s, `INSERT INTO app_relief.orders VALUES ('o${i}');`);
      if (/ORA-01653/.test(out)) failure = out;
    }
    expect(failure).toMatch(/ORA-01653/);
    expect(getOracleDatabase(srv.getId()).instance.state).toBe('OPEN');

    sql(s, "ALTER TABLESPACE app_relief ADD DATAFILE '/u01/app/oracle/oradata/ORCL/app_relief02.dbf' SIZE 1M;");
    const after = sql(s, "INSERT INTO app_relief.orders VALUES ('unblocked');");
    expect(after).toMatch(/1 row created/);

    const files = sql(s, "SELECT file_name FROM dba_data_files WHERE tablespace_name='APP_RELIEF';");
    expect(files).toContain('app_relief01.dbf');
    expect(files).toContain('app_relief02.dbf');

    const db = getOracleDatabase(srv.getId());
    expect(db.instance.state).toBe('OPEN');
    s.dispose();
  });
});

describe('the physical filesystem view of datafiles stays coherent with the dictionary', () => {
  it('HOST ls sees every datafile the dictionary lists, at every phase', () => {
    const { srv, subShell: s } = boot('ts7');
    sql(s, "CREATE TABLESPACE fscoh DATAFILE '/u01/app/oracle/oradata/ORCL/fscoh01.dbf' SIZE 1M;");
    let ls = sql(s, 'HOST ls /u01/app/oracle/oradata/ORCL/');
    expect(ls).toContain('fscoh01.dbf');

    sql(s, "ALTER TABLESPACE fscoh ADD DATAFILE '/u01/app/oracle/oradata/ORCL/fscoh02.dbf' SIZE 1M;");
    ls = sql(s, 'HOST ls /u01/app/oracle/oradata/ORCL/');
    expect(ls).toContain('fscoh02.dbf');

    const dictionaryFiles = sql(s, "SELECT file_name FROM dba_data_files WHERE tablespace_name='FSCOH';");
    expect(dictionaryFiles).toContain('fscoh01.dbf');
    expect(dictionaryFiles).toContain('fscoh02.dbf');
    void srv;
    s.dispose();
  });
});
