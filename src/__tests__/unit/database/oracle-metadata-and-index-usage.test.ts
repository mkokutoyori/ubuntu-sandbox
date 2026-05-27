/**
 * SQL-driven tests for object-management enhancements:
 *   - DBMS_METADATA.GET_DDL surface (SQL*Plus `DDL` directive)
 *   - ALTER INDEX … MONITORING USAGE
 *   - DBA_OBJECT_USAGE / V$OBJECT_USAGE
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

describe('DBMS_METADATA.GET_DDL surface (SQL*Plus DDL directive)', () => {
  it('reproduces CREATE TABLE for a user-created table', () => {
    const sh = newSession('ddl-tbl-1');
    sh.processLine('CREATE TABLE SYS.METATAB (ID NUMBER(10) NOT NULL, NAME VARCHAR2(60));');
    const out = run(sh, 'DDL TABLE SYS.METATAB;');
    expect(out).toMatch(/CREATE TABLE "SYS"\."METATAB"/);
    expect(out).toMatch(/"ID" NUMBER\(10\)/);
    expect(out).toMatch(/"NAME" VARCHAR2\(60\)/);
    sh.dispose();
  });

  it('reproduces CREATE TABLE with default schema = current user', () => {
    const sh = newSession('ddl-tbl-2');
    sh.processLine('CREATE TABLE MYTAB (X NUMBER);');
    const out = run(sh, 'DDL MYTAB;');
    expect(out).toMatch(/CREATE TABLE "SYS"\."MYTAB"/);
    expect(out).toMatch(/"X" NUMBER/);
    sh.dispose();
  });

  it('reproduces CREATE INDEX for a user-defined index', () => {
    const sh = newSession('ddl-idx-1');
    sh.processLine('CREATE TABLE T_IDX (ID NUMBER, NAME VARCHAR2(30));');
    sh.processLine('CREATE INDEX T_IDX_NAME_IX ON T_IDX (NAME);');
    const out = run(sh, 'DDL INDEX SYS.T_IDX_NAME_IX;');
    expect(out).toMatch(/CREATE INDEX "SYS"\."T_IDX_NAME_IX"/);
    expect(out).toMatch(/ON "SYS"\."T_IDX"/);
    sh.dispose();
  });

  it('reproduces CREATE SEQUENCE', () => {
    const sh = newSession('ddl-seq-1');
    sh.processLine('CREATE SEQUENCE S1 START WITH 100 INCREMENT BY 5 CACHE 20;');
    const out = run(sh, 'DDL SEQUENCE S1;');
    expect(out).toMatch(/CREATE SEQUENCE "SYS"\."S1"/);
    expect(out).toMatch(/INCREMENT BY 5/);
    expect(out).toMatch(/CACHE 20/);
    sh.dispose();
  });

  it('reproduces CREATE USER for an existing schema', () => {
    const sh = newSession('ddl-usr-1');
    const out = run(sh, 'DDL USER HR;');
    expect(out).toMatch(/CREATE USER "HR"/);
    expect(out).toMatch(/PROFILE "DEFAULT"/);
    sh.dispose();
  });

  it('returns ORA-31603 for an unknown object', () => {
    const sh = newSession('ddl-err-1');
    const out = run(sh, 'DDL TABLE SYS.DOES_NOT_EXIST;');
    expect(out).toMatch(/ORA-31603/);
    sh.dispose();
  });
});

describe('ALTER INDEX … MONITORING USAGE + DBA_OBJECT_USAGE', () => {
  it('records an index as MONITORING=YES after ALTER INDEX … MONITORING USAGE', () => {
    const sh = newSession('mon-1');
    sh.processLine('CREATE TABLE T_MON (ID NUMBER);');
    sh.processLine('CREATE INDEX T_MON_IDX ON T_MON (ID);');
    sh.processLine('ALTER INDEX T_MON_IDX MONITORING USAGE;');
    const out = run(sh, "SELECT INDEX_NAME, MONITORING, USED FROM DBA_OBJECT_USAGE WHERE INDEX_NAME='T_MON_IDX';");
    expect(out).toMatch(/T_MON_IDX/);
    expect(out).toMatch(/YES/);
    sh.dispose();
  });

  it('flips USED=YES once DML touches the underlying table', () => {
    const sh = newSession('mon-2');
    sh.processLine('CREATE TABLE T_USED (ID NUMBER);');
    sh.processLine('CREATE INDEX T_USED_IDX ON T_USED (ID);');
    sh.processLine('ALTER INDEX T_USED_IDX MONITORING USAGE;');
    sh.processLine('INSERT INTO T_USED VALUES (1);');
    const out = run(sh, "SELECT INDEX_NAME, USED FROM DBA_OBJECT_USAGE WHERE INDEX_NAME='T_USED_IDX';");
    expect(out).toMatch(/T_USED_IDX/);
    expect(out).toMatch(/YES/);
    sh.dispose();
  });

  it('ALTER INDEX … NOMONITORING USAGE closes the monitoring window', () => {
    const sh = newSession('mon-3');
    sh.processLine('CREATE TABLE T_NOMON (ID NUMBER);');
    sh.processLine('CREATE INDEX T_NOMON_IDX ON T_NOMON (ID);');
    sh.processLine('ALTER INDEX T_NOMON_IDX MONITORING USAGE;');
    sh.processLine('ALTER INDEX T_NOMON_IDX NOMONITORING USAGE;');
    const out = run(sh, "SELECT INDEX_NAME, MONITORING FROM DBA_OBJECT_USAGE WHERE INDEX_NAME='T_NOMON_IDX';");
    expect(out).toMatch(/T_NOMON_IDX/);
    expect(out).toMatch(/NO/);
    sh.dispose();
  });

  it('V$OBJECT_USAGE (legacy view) mirrors DBA_OBJECT_USAGE rows', () => {
    const sh = newSession('mon-4');
    sh.processLine('CREATE TABLE T_LEG (ID NUMBER);');
    sh.processLine('CREATE INDEX T_LEG_IDX ON T_LEG (ID);');
    sh.processLine('ALTER INDEX T_LEG_IDX MONITORING USAGE;');
    const out = run(sh, 'SELECT INDEX_NAME, MONITORING FROM V$OBJECT_USAGE;');
    expect(out).toMatch(/T_LEG_IDX/);
    expect(out).toMatch(/YES/);
    sh.dispose();
  });
});
