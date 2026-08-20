/**
 * Concurrent-writer ROLLBACK integrity — audit 07, constat critique.
 *
 * The old undo model restored a full-table snapshot (truncate + reinsert
 * of the rolling-back session's begin() image), which silently destroyed
 * rows written in the meantime by another session with an open
 * transaction, and could serve a reader a state that never existed.
 * These tests pin the expected Oracle READ COMMITTED behaviour with two
 * concurrent writers on the same table.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';

let db: OracleDatabase;
let s1: ReturnType<OracleDatabase['connectAsSysdba']>;
let s2: ReturnType<OracleDatabase['connectAsSysdba']>;

const sql = (c: typeof s1, q: string) => db.executeSql(c.executor, q);
const rows = (c: typeof s1, q: string) => sql(c, q).rows;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup();
  s1 = db.connectAsSysdba();
  sql(s1, 'CREATE TABLE hr.t4 (id NUMBER, v VARCHAR2(20))');
  sql(s1, "INSERT INTO hr.t4 VALUES (1, 'orig')");
  sql(s1, 'COMMIT');
  s2 = db.connectAsSysdba();
});

describe("audit reproduction — S1 updates, S2 inserts, S1 rolls back", () => {
  it("S1's rollback restores its own change and keeps S2's uncommitted row", () => {
    sql(s1, "UPDATE hr.t4 SET v = 's1-change' WHERE id = 1");
    sql(s2, "INSERT INTO hr.t4 VALUES (2, 's2-new-row')");

    // Before rollback: S1 sees its own uncommitted change, not S2's insert.
    expect(rows(s1, 'SELECT id, v FROM hr.t4 ORDER BY id')).toEqual([[1, 's1-change']]);

    sql(s1, 'ROLLBACK');

    // After rollback S1 must read the pre-transaction value — not its
    // own rolled-back change, not a phantom mix.
    expect(rows(s1, 'SELECT id, v FROM hr.t4 ORDER BY id')).toEqual([[1, 'orig']]);

    // S2 still sees its own uncommitted insert on top of committed state.
    expect(rows(s2, 'SELECT id, v FROM hr.t4 ORDER BY id'))
      .toEqual([[1, 'orig'], [2, 's2-new-row']]);

    // S2's row survives its commit — it was never S1's to destroy.
    sql(s2, 'COMMIT');
    expect(rows(s1, 'SELECT id, v FROM hr.t4 ORDER BY id'))
      .toEqual([[1, 'orig'], [2, 's2-new-row']]);
    expect(rows(s2, 'SELECT id, v FROM hr.t4 ORDER BY id'))
      .toEqual([[1, 'orig'], [2, 's2-new-row']]);
  });

  it("the mirror ordering — S2 rolls back its insert, S1 commits its update", () => {
    sql(s1, "UPDATE hr.t4 SET v = 's1-change' WHERE id = 1");
    sql(s2, "INSERT INTO hr.t4 VALUES (2, 's2-new-row')");

    sql(s2, 'ROLLBACK');
    sql(s1, 'COMMIT');

    expect(rows(s1, 'SELECT id, v FROM hr.t4 ORDER BY id')).toEqual([[1, 's1-change']]);
    expect(rows(s2, 'SELECT id, v FROM hr.t4 ORDER BY id')).toEqual([[1, 's1-change']]);
  });

  it('both rollback — table returns to the committed state', () => {
    sql(s1, "UPDATE hr.t4 SET v = 's1-change' WHERE id = 1");
    sql(s2, "INSERT INTO hr.t4 VALUES (2, 's2-new-row')");
    sql(s1, 'ROLLBACK');
    sql(s2, 'ROLLBACK');
    expect(rows(s1, 'SELECT id, v FROM hr.t4 ORDER BY id')).toEqual([[1, 'orig']]);
    expect(rows(s2, 'SELECT id, v FROM hr.t4 ORDER BY id')).toEqual([[1, 'orig']]);
  });
});

describe('read consistency for a third session', () => {
  it('a session with no transaction sees only committed state while both writers are active', () => {
    const s3 = db.connectAsSysdba();
    sql(s1, "UPDATE hr.t4 SET v = 's1-change' WHERE id = 1");
    sql(s2, "INSERT INTO hr.t4 VALUES (2, 's2-new-row')");

    expect(rows(s3, 'SELECT id, v FROM hr.t4 ORDER BY id')).toEqual([[1, 'orig']]);

    sql(s1, 'COMMIT');
    expect(rows(s3, 'SELECT id, v FROM hr.t4 ORDER BY id')).toEqual([[1, 's1-change']]);

    sql(s2, 'COMMIT');
    expect(rows(s3, 'SELECT id, v FROM hr.t4 ORDER BY id'))
      .toEqual([[1, 's1-change'], [2, 's2-new-row']]);
  });

  it('concurrent DELETE and INSERT roll back independently', () => {
    sql(s1, 'DELETE FROM hr.t4 WHERE id = 1');
    sql(s2, "INSERT INTO hr.t4 VALUES (2, 's2-new-row')");
    sql(s1, 'ROLLBACK');
    expect(rows(s1, 'SELECT id, v FROM hr.t4 ORDER BY id')).toEqual([[1, 'orig']]);
    sql(s2, 'COMMIT');
    expect(rows(s1, 'SELECT id, v FROM hr.t4 ORDER BY id'))
      .toEqual([[1, 'orig'], [2, 's2-new-row']]);
  });
});

describe('single-session semantics are preserved', () => {
  it('plain rollback undoes update, delete and insert together', () => {
    sql(s1, "INSERT INTO hr.t4 VALUES (2, 'two')");
    sql(s1, "UPDATE hr.t4 SET v = 'changed' WHERE id = 1");
    sql(s1, 'DELETE FROM hr.t4 WHERE id = 2');
    sql(s1, 'ROLLBACK');
    expect(rows(s1, 'SELECT id, v FROM hr.t4 ORDER BY id')).toEqual([[1, 'orig']]);
  });

  it('rollback to savepoint keeps earlier changes and the transaction active', () => {
    sql(s1, "UPDATE hr.t4 SET v = 'first' WHERE id = 1");
    sql(s1, 'SAVEPOINT sp1');
    sql(s1, "INSERT INTO hr.t4 VALUES (2, 'second')");
    sql(s1, 'ROLLBACK TO SAVEPOINT sp1');
    expect(rows(s1, 'SELECT id, v FROM hr.t4 ORDER BY id')).toEqual([[1, 'first']]);
    sql(s1, 'ROLLBACK');
    expect(rows(s1, 'SELECT id, v FROM hr.t4 ORDER BY id')).toEqual([[1, 'orig']]);
  });

  it('commit makes changes durable', () => {
    sql(s1, "UPDATE hr.t4 SET v = 'kept' WHERE id = 1");
    sql(s1, 'COMMIT');
    sql(s1, 'ROLLBACK');
    expect(rows(s1, 'SELECT id, v FROM hr.t4 ORDER BY id')).toEqual([[1, 'kept']]);
  });
});
