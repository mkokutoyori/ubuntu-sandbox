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
function run(sh: SqlPlusSubShell, sql: string): string {
  return sh.processLine(sql).output.join('\n');
}

/** Table t: x NUMBER, s VARCHAR2 — one row (1,'abc'), one row (NULL,NULL). */
function setup(name: string): SqlPlusSubShell {
  const sh = session(name);
  run(sh, 'CREATE TABLE t (x NUMBER, s VARCHAR2(10));');
  run(sh, "INSERT INTO t VALUES (1, 'abc');");
  run(sh, 'INSERT INTO t VALUES (NULL, NULL);');
  return sh;
}

describe('UNKNOWN filters rows out of WHERE', () => {
  it("NULL LIKE '%' is UNKNOWN, not TRUE", () => {
    const sh = setup('tv1');
    expect(run(sh, "SELECT x FROM t WHERE s LIKE '%';")).toContain('1 row selected');
    sh.dispose();
  });

  it('NOT LIKE over a NULL value is still UNKNOWN', () => {
    const sh = setup('tv2');
    expect(run(sh, "SELECT x FROM t WHERE s NOT LIKE 'z%';")).toContain('1 row selected');
    sh.dispose();
  });

  it('NOT (x = 1) over NULL x is UNKNOWN (row excluded)', () => {
    const sh = setup('tv3');
    expect(run(sh, 'SELECT x FROM t WHERE NOT (x = 1);')).toContain('no rows selected');
    sh.dispose();
  });

  it('x NOT IN (2, NULL) returns no rows at all', () => {
    const sh = setup('tv4');
    expect(run(sh, 'SELECT x FROM t WHERE x NOT IN (2, NULL);')).toContain('no rows selected');
    sh.dispose();
  });

  it('x IN (1, NULL) still finds the matching row', () => {
    const sh = setup('tv5');
    expect(run(sh, 'SELECT x FROM t WHERE x IN (1, NULL);')).toContain('1 row selected');
    sh.dispose();
  });

  it('NOT BETWEEN over NULL x is UNKNOWN (row excluded)', () => {
    const sh = setup('tv6');
    expect(run(sh, 'SELECT x FROM t WHERE x NOT BETWEEN 5 AND 9;')).toContain('1 row selected');
    sh.dispose();
  });

  it('UNKNOWN OR TRUE is TRUE (row kept through OR)', () => {
    const sh = setup('tv7');
    const out = run(sh, 'SELECT x FROM t WHERE x = 1 OR x IS NULL;');
    expect(out).toContain('2 rows selected');
    sh.dispose();
  });
});

describe('LIKE case sensitivity', () => {
  it("'abc' does not match 'A%'", () => {
    const sh = setup('cs1');
    expect(run(sh, "SELECT x FROM t WHERE s LIKE 'A%';")).toContain('no rows selected');
    expect(run(sh, "SELECT x FROM t WHERE s LIKE 'a%';")).toContain('1 row selected');
    sh.dispose();
  });
});

describe('CHECK constraints accept UNKNOWN', () => {
  it('NULL passes CHECK (x > 0); negative value still violates', () => {
    const sh = session('ck1');
    run(sh, 'CREATE TABLE c (x NUMBER CHECK (x > 0));');
    expect(run(sh, 'INSERT INTO c VALUES (NULL);')).toContain('1 row created');
    expect(run(sh, 'INSERT INTO c VALUES (-1);')).toContain('ORA-02290');
    sh.dispose();
  });
});
