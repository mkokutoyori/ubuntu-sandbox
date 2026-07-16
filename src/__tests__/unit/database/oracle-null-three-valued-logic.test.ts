/**
 * SQL three-valued logic (Oracle / SQL standard): NULL operands make
 * comparisons, LIKE, BETWEEN and IN evaluate to UNKNOWN. WHERE keeps
 * only TRUE rows; NOT UNKNOWN stays UNKNOWN; CHECK constraints accept
 * UNKNOWN. Also: Oracle LIKE is case-sensitive.
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

function session(name: string): SqlPlusSubShell {
  const srv = new LinuxServer('linux-server', name, 100, 100);
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}
async function run(sh: SqlPlusSubShell, sql: string): Promise<string> {
  return (await sh.processLine(sql)).output.join('\n');
}

/** Table t: x NUMBER, s VARCHAR2 — one row (1,'abc'), one row (NULL,NULL). */
async function setup(name: string): Promise<SqlPlusSubShell> {
  const sh = session(name);
  (await run(sh, 'CREATE TABLE t (x NUMBER, s VARCHAR2(10));'));
  (await run(sh, "INSERT INTO t VALUES (1, 'abc');"));
  (await run(sh, 'INSERT INTO t VALUES (NULL, NULL);'));
  return sh;
}

describe('UNKNOWN filters rows out of WHERE', () => {
  it("NULL LIKE '%' is UNKNOWN, not TRUE", async () => {
    const sh = (await setup('tv1'));
    expect((await run(sh, "SELECT x FROM t WHERE s LIKE '%';"))).toContain('1 row selected');
    sh.dispose();
  });

  it('NOT LIKE over a NULL value is still UNKNOWN', async () => {
    const sh = (await setup('tv2'));
    expect((await run(sh, "SELECT x FROM t WHERE s NOT LIKE 'z%';"))).toContain('1 row selected');
    sh.dispose();
  });

  it('NOT (x = 1) over NULL x is UNKNOWN (row excluded)', async () => {
    const sh = (await setup('tv3'));
    expect((await run(sh, 'SELECT x FROM t WHERE NOT (x = 1);'))).toContain('no rows selected');
    sh.dispose();
  });

  it('x NOT IN (2, NULL) returns no rows at all', async () => {
    const sh = (await setup('tv4'));
    expect((await run(sh, 'SELECT x FROM t WHERE x NOT IN (2, NULL);'))).toContain('no rows selected');
    sh.dispose();
  });

  it('x IN (1, NULL) still finds the matching row', async () => {
    const sh = (await setup('tv5'));
    expect((await run(sh, 'SELECT x FROM t WHERE x IN (1, NULL);'))).toContain('1 row selected');
    sh.dispose();
  });

  it('NOT BETWEEN over NULL x is UNKNOWN (row excluded)', async () => {
    const sh = (await setup('tv6'));
    expect((await run(sh, 'SELECT x FROM t WHERE x NOT BETWEEN 5 AND 9;'))).toContain('1 row selected');
    sh.dispose();
  });

  it('UNKNOWN OR TRUE is TRUE (row kept through OR)', async () => {
    const sh = (await setup('tv7'));
    const out = (await run(sh, 'SELECT x FROM t WHERE x = 1 OR x IS NULL;'));
    expect(out).toContain('2 rows selected');
    sh.dispose();
  });
});

describe('LIKE case sensitivity', () => {
  it("'abc' does not match 'A%'", async () => {
    const sh = (await setup('cs1'));
    expect((await run(sh, "SELECT x FROM t WHERE s LIKE 'A%';"))).toContain('no rows selected');
    expect((await run(sh, "SELECT x FROM t WHERE s LIKE 'a%';"))).toContain('1 row selected');
    sh.dispose();
  });
});

describe('CHECK constraints accept UNKNOWN', () => {
  it('NULL passes CHECK (x > 0); negative value still violates', async () => {
    const sh = session('ck1');
    (await run(sh, 'CREATE TABLE c (x NUMBER CHECK (x > 0));'));
    expect((await run(sh, 'INSERT INTO c VALUES (NULL);'))).toContain('1 row created');
    expect((await run(sh, 'INSERT INTO c VALUES (-1);'))).toContain('ORA-02290');
    sh.dispose();
  });
});

describe('SET AUTOCOMMIT ON (SQL*Plus)', () => {
  it('commits each DML immediately — ROLLBACK undoes nothing', async () => {
    const sh = session('ac1');
    (await run(sh, 'CREATE TABLE a (x NUMBER);'));
    (await run(sh, 'SET AUTOCOMMIT ON'));
    (await run(sh, 'INSERT INTO a VALUES (1);'));
    (await run(sh, 'ROLLBACK;'));
    expect((await run(sh, 'SELECT COUNT(*) FROM a;'))).toContain('1');
    sh.dispose();
  });

  it('OFF restores deferred transactions', async () => {
    const sh = session('ac2');
    (await run(sh, 'CREATE TABLE a (x NUMBER);'));
    (await run(sh, 'SET AUTOCOMMIT OFF'));
    (await run(sh, 'INSERT INTO a VALUES (1);'));
    (await run(sh, 'ROLLBACK;'));
    expect((await run(sh, 'SELECT COUNT(*) FROM a;'))).toContain('0');
    sh.dispose();
  });
});

describe('dictionary SEARCH_CONDITION', () => {
  it('CHECK predicates and NOT NULL conditions are visible', async () => {
    const sh = session('sc1');
    (await run(sh, 'CREATE TABLE s (x NUMBER NOT NULL, y NUMBER, CONSTRAINT s_chk CHECK (y > 0));'));
    const out = (await run(sh, "SELECT constraint_name, search_condition FROM user_constraints WHERE table_name = 'S';"));
    expect(out).toContain('S_CHK');
    expect(out).toMatch(/Y > 0/i);
    expect(out).toMatch(/IS NOT NULL/);
    sh.dispose();
  });
});
