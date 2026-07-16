/**
 * SQL-driven tests for the fifth reactive slice:
 *   - SQL plans (PlanGenerator + V$SQL_PLAN)
 *   - DBMS_STATS (StatisticsManager + DBA_TAB_STATISTICS / COL_STATISTICS / TAB_HISTOGRAMS / IND_STATISTICS)
 *   - PL/SQL exceptions + EXECUTE IMMEDIATE + RAISE_APPLICATION_ERROR
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

async function run(sh: SqlPlusSubShell, sql: string): Promise<string> {
  return (await sh.processLine(sql)).output.join('\n');
}

describe('SQL plan (V$SQL_PLAN)', () => {
  it('a SELECT against a real table populates V$SQL_PLAN', async () => {
    const sh = newSession('plan-1');
    (await sh.processLine('CREATE TABLE PLAN_T (id NUMBER, name VARCHAR2(60));'));
    (await sh.processLine('INSERT INTO PLAN_T VALUES (1, \'a\');'));
    (await sh.processLine('SELECT * FROM PLAN_T;'));
    const out = (await run(sh, "SELECT OPERATION, OPTIONS, OBJECT_NAME FROM V$SQL_PLAN WHERE OBJECT_NAME='PLAN_T';"));
    expect(out).toMatch(/TABLE ACCESS\s+FULL\s+PLAN_T/);
    sh.dispose();
  });

  it('SELECT statement root row shows the total cost + cardinality', async () => {
    const sh = newSession('plan-2');
    (await sh.processLine('CREATE TABLE PLAN_T2 (id NUMBER);'));
    (await sh.processLine('SELECT * FROM PLAN_T2;'));
    const out = (await run(sh, "SELECT OPERATION, COST, CARDINALITY FROM V$SQL_PLAN WHERE ID=0;"));
    expect(out).toMatch(/SELECT STATEMENT/);
    sh.dispose();
  });

  it('a query with WHERE on an indexed column triggers an index scan', async () => {
    const sh = newSession('plan-3');
    (await sh.processLine('CREATE TABLE PLAN_IDX (id NUMBER, code VARCHAR2(10));'));
    (await sh.processLine('CREATE INDEX PLAN_IDX_CODE_IX ON PLAN_IDX (code);'));
    (await sh.processLine("SELECT * FROM PLAN_IDX WHERE code = 'X';"));
    const out = (await run(sh, "SELECT OPERATION, OPTIONS, OBJECT_NAME FROM V$SQL_PLAN WHERE OBJECT_NAME IN ('PLAN_IDX_CODE_IX','PLAN_IDX');"));
    expect(out).toMatch(/INDEX\s+RANGE SCAN\s+PLAN_IDX_CODE_IX/);
    expect(out).toMatch(/TABLE ACCESS\s+BY INDEX ROWID\s+PLAN_IDX/);
    sh.dispose();
  });
});

describe('DBMS_STATS', () => {
  it('GATHER_TABLE_STATS populates DBA_TAB_STATISTICS', async () => {
    const sh = newSession('stats-1');
    (await sh.processLine('CREATE TABLE STATS_T (id NUMBER, name VARCHAR2(30));'));
    (await sh.processLine("INSERT INTO STATS_T VALUES (1, 'a');"));
    (await sh.processLine("INSERT INTO STATS_T VALUES (2, 'b');"));
    (await sh.processLine("INSERT INTO STATS_T VALUES (3, 'c');"));
    (await sh.processLine("BEGIN DBMS_STATS.GATHER_TABLE_STATS('SYS', 'STATS_T'); END;"));
    const out = (await run(sh, "SELECT TABLE_NAME, NUM_ROWS, LAST_ANALYZED FROM DBA_TAB_STATISTICS WHERE TABLE_NAME='STATS_T';"));
    expect(out).toMatch(/STATS_T/);
    expect(out).toMatch(/\s3\s/);
    expect(out).toMatch(/\d{4}-\d{2}-\d{2}T/);
    sh.dispose();
  });

  it('GATHER_TABLE_STATS populates DBA_COL_STATISTICS with NUM_DISTINCT', async () => {
    const sh = newSession('stats-2');
    (await sh.processLine('CREATE TABLE COL_T (id NUMBER, cat VARCHAR2(10));'));
    (await sh.processLine("INSERT INTO COL_T VALUES (1, 'A');"));
    (await sh.processLine("INSERT INTO COL_T VALUES (2, 'A');"));
    (await sh.processLine("INSERT INTO COL_T VALUES (3, 'B');"));
    (await sh.processLine("BEGIN DBMS_STATS.GATHER_TABLE_STATS('SYS', 'COL_T'); END;"));
    const out = (await run(sh, "SELECT COLUMN_NAME, NUM_DISTINCT, HISTOGRAM FROM DBA_COL_STATISTICS WHERE TABLE_NAME='COL_T';"));
    expect(out).toMatch(/CAT\s+2\s+FREQUENCY/);
    expect(out).toMatch(/ID\s+3\s+FREQUENCY/);
    sh.dispose();
  });

  it('GATHER_TABLE_STATS populates DBA_TAB_HISTOGRAMS', async () => {
    const sh = newSession('stats-3');
    (await sh.processLine('CREATE TABLE HIST_T (cat VARCHAR2(10));'));
    (await sh.processLine("INSERT INTO HIST_T VALUES ('A');"));
    (await sh.processLine("INSERT INTO HIST_T VALUES ('B');"));
    (await sh.processLine("INSERT INTO HIST_T VALUES ('C');"));
    (await sh.processLine("BEGIN DBMS_STATS.GATHER_TABLE_STATS('SYS', 'HIST_T'); END;"));
    const out = (await run(sh, "SELECT ENDPOINT_NUMBER, ENDPOINT_VALUE FROM DBA_TAB_HISTOGRAMS WHERE TABLE_NAME='HIST_T';"));
    expect(out).toMatch(/A/);
    expect(out).toMatch(/B/);
    expect(out).toMatch(/C/);
    sh.dispose();
  });

  it('GATHER_SCHEMA_STATS gathers every table in the schema', async () => {
    const sh = newSession('stats-4');
    (await sh.processLine("BEGIN DBMS_STATS.GATHER_SCHEMA_STATS('HR'); END;"));
    const out = (await run(sh, "SELECT TABLE_NAME FROM DBA_TAB_STATISTICS WHERE OWNER='HR' AND LAST_ANALYZED IS NOT NULL;"));
    // HR has demo tables seeded by installAllDemoSchemas
    expect(out).toMatch(/EMPLOYEES|DEPARTMENTS/);
    sh.dispose();
  });

  it('GATHER_INDEX_STATS refreshes a single index entry without re-touching peers', async () => {
    const sh = newSession('stats-gi');
    (await sh.processLine('CREATE TABLE GI_T (id NUMBER, cat VARCHAR2(2));'));
    for (let i = 1; i <= 20; i++) {
      (await sh.processLine(`INSERT INTO GI_T VALUES (${i}, '${i % 4}');`));
    }
    (await sh.processLine('CREATE INDEX GI_T_CAT ON GI_T(cat);'));
    (await sh.processLine("BEGIN DBMS_STATS.GATHER_INDEX_STATS('SYS', 'GI_T_CAT'); END;"));
    const out = (await run(sh, "SELECT DISTINCT_KEYS FROM DBA_IND_STATISTICS WHERE INDEX_NAME='GI_T_CAT';"));
    expect(out).toMatch(/\s4\s/);
    (await sh.processLine("BEGIN DBMS_STATS.DELETE_INDEX_STATS('SYS', 'GI_T_CAT'); END;"));
    (await sh.processLine('/'));
    const out2 = (await run(sh, "SELECT DISTINCT_KEYS, STALE_STATS FROM DBA_IND_STATISTICS WHERE INDEX_NAME='GI_T_CAT';"));
    expect(out2).toMatch(/\s0\s+YES/);
    sh.dispose();
  });

  it('GATHER_TABLE_STATS computes BLEVEL and CLUSTERING_FACTOR for an index', async () => {
    const sh = newSession('stats-idx');
    (await sh.processLine('CREATE TABLE IDX_T (id NUMBER, cat VARCHAR2(2));'));
    for (let i = 1; i <= 50; i++) {
      (await sh.processLine(`INSERT INTO IDX_T VALUES (${i}, '${i % 4}');`));
    }
    (await sh.processLine('CREATE UNIQUE INDEX IDX_T_PK ON IDX_T(id);'));
    (await sh.processLine('CREATE INDEX IDX_T_CAT ON IDX_T(cat);'));
    (await sh.processLine("BEGIN DBMS_STATS.GATHER_TABLE_STATS('SYS', 'IDX_T'); END;"));
    const out = (await run(sh, "SELECT INDEX_NAME, BLEVEL, LEAF_BLOCKS, DISTINCT_KEYS, CLUSTERING_FACTOR FROM DBA_IND_STATISTICS WHERE TABLE_NAME='IDX_T' ORDER BY INDEX_NAME;"));
    // Unique index over 50 distinct ids → distinct_keys = 50.
    expect(out).toMatch(/IDX_T_PK\s+\d+\s+\d+\s+50\s+\d+/);
    // Non-unique index over 4 distinct categories → distinct_keys = 4.
    expect(out).toMatch(/IDX_T_CAT\s+\d+\s+\d+\s+4\s+\d+/);
    sh.dispose();
  });
});

describe('PL/SQL exceptions + EXECUTE IMMEDIATE', () => {
  it('RAISE_APPLICATION_ERROR throws an ORA-20xxx error', async () => {
    const sh = newSession('plsql-1');
    const out = (await run(sh,
      "BEGIN RAISE_APPLICATION_ERROR(-20100, 'Custom failure'); END;"));
    expect(out).toMatch(/ORA-20100|-20100/);
    expect(out).toMatch(/Custom failure/);
    sh.dispose();
  });

  it('RAISE NO_DATA_FOUND raises ORA-01403', async () => {
    const sh = newSession('plsql-2');
    const out = (await run(sh, 'BEGIN RAISE NO_DATA_FOUND; END;'));
    expect(out).toMatch(/ORA-01403|no data found/);
    sh.dispose();
  });

  it('EXECUTE IMMEDIATE runs dynamic DDL', async () => {
    const sh = newSession('plsql-3');
    (await sh.processLine("BEGIN EXECUTE IMMEDIATE 'CREATE TABLE EI_TBL (id NUMBER)'; END;"));
    const out = (await run(sh, "SELECT TABLE_NAME FROM DBA_TABLES WHERE TABLE_NAME='EI_TBL';"));
    expect(out).toMatch(/EI_TBL/);
    sh.dispose();
  });

  it('EXECUTE IMMEDIATE runs dynamic DML inside a block', async () => {
    const sh = newSession('plsql-4');
    (await sh.processLine('CREATE TABLE EI_T2 (id NUMBER);'));
    (await sh.processLine("BEGIN EXECUTE IMMEDIATE 'INSERT INTO EI_T2 VALUES (42)'; END;"));
    const out = (await run(sh, 'SELECT * FROM EI_T2;'));
    expect(out).toMatch(/42/);
    sh.dispose();
  });
});
