/**
 * SQL-driven tests for the structural catalogue extensions:
 *   - ALL_USERS (native, smaller shape than DBA_USERS)
 *   - DBA_TAB_COLS (variant of DBA_TAB_COLUMNS)
 *   - DBA_TYPES / DBA_TYPE_ATTRS / DBA_COLL_TYPES
 *   - DBA_EXTERNAL_TABLES / DBA_EXTERNAL_LOCATIONS
 *   - DBA_EDITIONS
 *
 * Every assertion verifies that what we expose is coherent with what
 * the underlying catalog / registries hold.
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

function newSession(name: string): SqlPlusSubShell {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}

function run(sh: SqlPlusSubShell, sql: string): string {
  return sh.processLine(sql).output.join('\n');
}

describe('ALL_USERS', () => {
  it('lists every account with the native 10-column shape', () => {
    const sh = newSession('au-1');
    const out = run(sh, 'SELECT USERNAME, ORACLE_MAINTAINED FROM ALL_USERS;');
    expect(out).toMatch(/SYS/);
    expect(out).toMatch(/HR/);
    expect(out).toMatch(/SCOTT/);
    // ORACLE_MAINTAINED is Y for SYS, N for SCOTT
    expect(out).toMatch(/SYS\s+Y/);
    expect(out).toMatch(/SCOTT\s+N/);
    sh.dispose();
  });

  it('stays coherent with DBA_USERS — same usernames appear in both', () => {
    const sh = newSession('au-2');
    const a = run(sh, 'SELECT USERNAME FROM ALL_USERS;');
    const d = run(sh, 'SELECT USERNAME FROM DBA_USERS;');
    for (const u of ['SYS', 'SYSTEM', 'HR', 'SCOTT', 'FCUBSLIVE']) {
      expect(a, `ALL_USERS missing ${u}`).toMatch(new RegExp(u));
      expect(d, `DBA_USERS missing ${u}`).toMatch(new RegExp(u));
    }
    sh.dispose();
  });
});

describe('DBA_TAB_COLS', () => {
  it('returns every column of a user table including HIDDEN_COLUMN flag', () => {
    const sh = newSession('tc-1');
    sh.processLine('CREATE TABLE MYTAB (ID NUMBER(10) NOT NULL, NAME VARCHAR2(60));');
    const out = run(sh, "SELECT COLUMN_NAME, DATA_TYPE, HIDDEN_COLUMN FROM DBA_TAB_COLS WHERE TABLE_NAME='MYTAB';");
    expect(out).toMatch(/ID\s+NUMBER\s+NO/);
    expect(out).toMatch(/NAME\s+VARCHAR2\s+NO/);
    sh.dispose();
  });

  it('reports the same DATA_TYPE values as DBA_TAB_COLUMNS', () => {
    const sh = newSession('tc-2');
    sh.processLine('CREATE TABLE T_CMP (ID NUMBER, NAME VARCHAR2(30));');
    const a = run(sh, "SELECT DATA_TYPE FROM DBA_TAB_COLS WHERE TABLE_NAME='T_CMP' AND COLUMN_NAME='NAME';");
    const b = run(sh, "SELECT DATA_TYPE FROM DBA_TAB_COLUMNS WHERE TABLE_NAME='T_CMP' AND COLUMN_NAME='NAME';");
    // Both should agree the type is VARCHAR2.
    expect(a).toMatch(/VARCHAR2/);
    expect(b).toMatch(/VARCHAR2/);
    sh.dispose();
  });
});

describe('Object types (DBA_TYPES / DBA_TYPE_ATTRS / DBA_COLL_TYPES)', () => {
  it('seeds the system-supplied types (XMLTYPE, SDO_GEOMETRY)', () => {
    const sh = newSession('ty-1');
    const out = run(sh, 'SELECT OWNER, TYPE_NAME FROM DBA_TYPES;');
    expect(out).toMatch(/XDB\s+XMLTYPE/);
    expect(out).toMatch(/MDSYS\s+SDO_GEOMETRY/);
    sh.dispose();
  });

  it('exposes SDO_GEOMETRY attributes in DBA_TYPE_ATTRS', () => {
    const sh = newSession('ty-2');
    const out = run(sh, "SELECT ATTR_NAME FROM DBA_TYPE_ATTRS WHERE TYPE_NAME='SDO_GEOMETRY';");
    expect(out).toMatch(/SDO_GTYPE/);
    expect(out).toMatch(/SDO_SRID/);
    sh.dispose();
  });

  it('records CREATE TYPE … AS OBJECT in DBA_TYPES + DBA_TYPE_ATTRS', () => {
    const sh = newSession('ty-3');
    sh.processLine('CREATE TYPE SYS.ADDR_T AS OBJECT (STREET VARCHAR2(100), CITY VARCHAR2(60));');
    const t = run(sh, "SELECT OWNER, TYPE_NAME, ATTRIBUTES FROM DBA_TYPES WHERE TYPE_NAME='ADDR_T';");
    expect(t).toMatch(/SYS\s+ADDR_T/);
    expect(t).toMatch(/2/);
    const a = run(sh, "SELECT ATTR_NAME, ATTR_TYPE_NAME FROM DBA_TYPE_ATTRS WHERE TYPE_NAME='ADDR_T' ORDER BY ATTR_NO;");
    expect(a).toMatch(/STREET\s+VARCHAR2/);
    expect(a).toMatch(/CITY\s+VARCHAR2/);
    sh.dispose();
  });

  it('records CREATE TYPE … AS VARRAY in DBA_COLL_TYPES', () => {
    const sh = newSession('ty-4');
    sh.processLine('CREATE TYPE SYS.NUM_ARR AS VARRAY(10) OF NUMBER;');
    const out = run(sh, "SELECT TYPE_NAME, COLL_TYPE, UPPER_BOUND, ELEM_TYPE_NAME FROM DBA_COLL_TYPES WHERE TYPE_NAME='NUM_ARR';");
    expect(out).toMatch(/NUM_ARR/);
    expect(out).toMatch(/VARRAY/);
    expect(out).toMatch(/10/);
    expect(out).toMatch(/NUMBER/);
    sh.dispose();
  });

  it('a collection type also surfaces in DBA_TYPES with TYPECODE=COLLECTION', () => {
    const sh = newSession('ty-5');
    sh.processLine('CREATE TYPE SYS.NAME_TAB AS TABLE OF VARCHAR2(60);');
    const out = run(sh, "SELECT TYPE_NAME, TYPECODE FROM DBA_TYPES WHERE TYPE_NAME='NAME_TAB';");
    expect(out).toMatch(/NAME_TAB\s+COLLECTION/);
    sh.dispose();
  });
});

describe('External tables (DBA_EXTERNAL_TABLES / DBA_EXTERNAL_LOCATIONS)', () => {
  it('registers ORGANIZATION EXTERNAL tables in DBA_EXTERNAL_TABLES', () => {
    const sh = newSession('xt-1');
    sh.processLine(
      "CREATE TABLE SYS.LOG_EXT (msg VARCHAR2(4000)) ORGANIZATION EXTERNAL "
      + "(TYPE ORACLE_LOADER DEFAULT DIRECTORY LOG_DIR ACCESS PARAMETERS "
      + "(RECORDS DELIMITED BY NEWLINE) LOCATION ('app.log'));");
    const out = run(sh, "SELECT OWNER, TABLE_NAME, TYPE_NAME, DEFAULT_DIRECTORY_NAME FROM DBA_EXTERNAL_TABLES WHERE TABLE_NAME='LOG_EXT';");
    expect(out).toMatch(/SYS/);
    expect(out).toMatch(/LOG_EXT/);
    expect(out).toMatch(/ORACLE_LOADER/);
    expect(out).toMatch(/LOG_DIR/);
    sh.dispose();
  });

  it('LOCATION list lands in DBA_EXTERNAL_LOCATIONS', () => {
    const sh = newSession('xt-2');
    sh.processLine(
      "CREATE TABLE SYS.MULTI_EXT (X NUMBER) ORGANIZATION EXTERNAL "
      + "(TYPE ORACLE_LOADER DEFAULT DIRECTORY DATA_PUMP_DIR ACCESS PARAMETERS "
      + "(RECORDS DELIMITED BY NEWLINE) LOCATION ('a.txt','b.txt'));");
    const out = run(sh, "SELECT TABLE_NAME, LOCATION FROM DBA_EXTERNAL_LOCATIONS WHERE TABLE_NAME='MULTI_EXT';");
    expect(out).toMatch(/a\.txt/);
    expect(out).toMatch(/b\.txt/);
    sh.dispose();
  });
});

describe('DBA_EDITIONS', () => {
  it('contains the implicit ORA$BASE root edition', () => {
    const sh = newSession('ed-1');
    const out = run(sh, 'SELECT EDITION_NAME, USABLE FROM DBA_EDITIONS;');
    expect(out).toMatch(/ORA\$BASE/);
    expect(out).toMatch(/YES/);
    sh.dispose();
  });
});
