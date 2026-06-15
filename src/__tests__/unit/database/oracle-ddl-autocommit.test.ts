/**
 * DDL implicit COMMIT fidelity (Oracle SQL Language Reference, "Types of
 * SQL Statements"): every DDL statement commits the current transaction
 * before executing — and the pre-commit survives even when the DDL itself
 * fails. Session/system control statements never commit.
 *
 * Historically only CREATE TABLE / DROP TABLE / TRUNCATE did this; the
 * commit is now centralized in the executor's dispatch path.
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

/** Open a session with one uncommitted row in table T. */
function withPendingInsert(name: string): SqlPlusSubShell {
  const sh = session(name);
  run(sh, 'CREATE TABLE t (x NUMBER);');
  run(sh, 'INSERT INTO t VALUES (1);');
  return sh;
}

function countRows(sh: SqlPlusSubShell): string {
  return run(sh, 'SELECT COUNT(*) FROM t;');
}

describe('DDL implicit COMMIT', () => {
  it('CREATE INDEX commits the pending transaction (rollback is a no-op)', () => {
    const sh = withPendingInsert('ddl1');
    run(sh, 'CREATE INDEX t_idx ON t (x);');
    run(sh, 'ROLLBACK;');
    expect(countRows(sh)).toContain('1');
    sh.dispose();
  });

  it('CREATE SEQUENCE commits the pending transaction', () => {
    const sh = withPendingInsert('ddl2');
    run(sh, 'CREATE SEQUENCE s1;');
    run(sh, 'ROLLBACK;');
    expect(countRows(sh)).toContain('1');
    sh.dispose();
  });

  it('CREATE VIEW commits the pending transaction', () => {
    const sh = withPendingInsert('ddl3');
    run(sh, 'CREATE VIEW v1 AS SELECT x FROM t;');
    run(sh, 'ROLLBACK;');
    expect(countRows(sh)).toContain('1');
    sh.dispose();
  });

  it('GRANT (DCL is DDL in Oracle) commits the pending transaction', () => {
    const sh = withPendingInsert('ddl4');
    run(sh, 'CREATE USER u1 IDENTIFIED BY pw;'); // itself DDL — re-open the txn
    run(sh, 'INSERT INTO t VALUES (2);');
    run(sh, 'GRANT CONNECT TO u1;');
    run(sh, 'ROLLBACK;');
    expect(countRows(sh)).toContain('2');
    sh.dispose();
  });

  it('a FAILING DDL still commits beforehand (the pre-commit survives)', () => {
    const sh = withPendingInsert('ddl5');
    const out = run(sh, 'CREATE INDEX bad_idx ON no_such_table (x);');
    expect(out).toContain('ORA-');
    run(sh, 'ROLLBACK;');
    expect(countRows(sh)).toContain('1');
    sh.dispose();
  });

  it('ALTER SESSION (session control, not DDL) does NOT commit', () => {
    const sh = withPendingInsert('ddl6');
    run(sh, "ALTER SESSION SET NLS_DATE_FORMAT='YYYY-MM-DD';");
    run(sh, 'ROLLBACK;');
    expect(countRows(sh)).toContain('0');
    sh.dispose();
  });

  it('SAVEPOINT + DDL: savepoints die with the implicit commit (ORA-01086)', () => {
    const sh = withPendingInsert('ddl7');
    run(sh, 'SAVEPOINT sp1;');
    run(sh, 'CREATE SEQUENCE s2;');
    const out = run(sh, 'ROLLBACK TO sp1;');
    expect(out).toContain('ORA-01086');
    sh.dispose();
  });
});

describe('Index DDL enforcement', () => {
  it('CREATE INDEX on a missing table raises ORA-00942', () => {
    const sh = session('idx1');
    expect(run(sh, 'CREATE INDEX i1 ON no_such (x);')).toContain('ORA-00942');
    sh.dispose();
  });

  it('CREATE INDEX on a missing column raises ORA-00904', () => {
    const sh = withPendingInsert('idx2');
    expect(run(sh, 'CREATE INDEX i1 ON t (nope);')).toContain('ORA-00904');
    sh.dispose();
  });

  it('duplicate index name raises ORA-00955', () => {
    const sh = withPendingInsert('idx3');
    run(sh, 'CREATE INDEX i1 ON t (x);');
    expect(run(sh, 'CREATE INDEX i1 ON t (x);')).toContain('ORA-00955');
    sh.dispose();
  });

  it('CREATE UNIQUE INDEX over duplicate keys raises ORA-01452', () => {
    const sh = withPendingInsert('idx4');
    run(sh, 'INSERT INTO t VALUES (1);');
    expect(run(sh, 'CREATE UNIQUE INDEX i1 ON t (x);')).toContain('ORA-01452');
    sh.dispose();
  });

  it('all-NULL keys never collide in a unique index', () => {
    const sh = withPendingInsert('idx5');
    run(sh, 'INSERT INTO t VALUES (NULL);');
    run(sh, 'INSERT INTO t VALUES (NULL);');
    expect(run(sh, 'CREATE UNIQUE INDEX i1 ON t (x);')).toContain('Index created.');
    sh.dispose();
  });

  it('DROP INDEX on a missing index raises ORA-01418', () => {
    const sh = session('idx6');
    expect(run(sh, 'DROP INDEX nope;')).toContain('ORA-01418');
    sh.dispose();
  });
});
