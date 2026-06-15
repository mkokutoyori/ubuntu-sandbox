/**
 * Index runtime — indexes finally exist at execution time (GAP §10.3).
 *
 * Before: IndexMeta was catalog decoration. Every UNIQUE/PK check, FK
 * parent lookup and WHERE col = :x was a full linear scan, while EXPLAIN
 * PLAN happily advertised INDEX UNIQUE SCAN — two views of the same
 * subject telling different stories. Bulk inserts into a keyed table
 * were O(n²).
 *
 * Also fixes a fidelity bug the linear scan carried: two rows with an
 * entirely-NULL unique key raised ORA-00001, whereas real Oracle does
 * not store all-NULL keys in unique indexes (any number may coexist).
 *
 * Now: a lazily-built, epoch-invalidated hash index in the storage layer
 * answers equality probes; constraint validation and single-table
 * SELECT equality predicates ride it; results stay identical to the
 * scan (candidates are always re-verified with the real comparator).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';

let db: OracleDatabase;
let session: SQLPlusSession;

const run = (sql: string) => session.processLine(sql).output.join('\n');

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  session = new SQLPlusSession(db);
  session.login('SYS', '', true);
});

describe('Oracle NULL semantics for unique keys', () => {
  it('allows any number of rows whose entire unique key is NULL', () => {
    run('CREATE TABLE hr.t1 (id NUMBER, code VARCHAR2(10) UNIQUE);');
    run("INSERT INTO hr.t1 VALUES (1, NULL);");
    const out = run("INSERT INTO hr.t1 VALUES (2, NULL);");
    expect(out).toContain('1 row created.');
    expect(out).not.toContain('ORA-00001');
  });

  it('raises ORA-00001 for duplicate composite keys with a NULL part', () => {
    run('CREATE TABLE hr.t2 (a NUMBER, b NUMBER, CONSTRAINT t2_uq UNIQUE (a, b));');
    run('INSERT INTO hr.t2 VALUES (1, NULL);');
    const out = run('INSERT INTO hr.t2 VALUES (1, NULL);');
    expect(out).toContain('ORA-00001');
  });

  it('allows duplicate composite keys when every part is NULL', () => {
    run('CREATE TABLE hr.t3 (a NUMBER, b NUMBER, CONSTRAINT t3_uq UNIQUE (a, b));');
    run('INSERT INTO hr.t3 VALUES (NULL, NULL);');
    const out = run('INSERT INTO hr.t3 VALUES (NULL, NULL);');
    expect(out).toContain('1 row created.');
  });

  it('ORA-00001 names the constraint with its schema, like real Oracle', () => {
    run('CREATE TABLE hr.t4 (id NUMBER, CONSTRAINT t4_pk PRIMARY KEY (id));');
    run('INSERT INTO hr.t4 VALUES (7);');
    const out = run('INSERT INTO hr.t4 VALUES (7);');
    expect(out).toMatch(/unique constraint \(HR\.T4_PK\) violated/);
  });
});

describe('index-backed equality lookups stay correct', () => {
  beforeEach(() => {
    run('CREATE TABLE hr.emp (id NUMBER PRIMARY KEY, name VARCHAR2(30), dept VARCHAR2(10));');
    run("INSERT INTO hr.emp VALUES (1, 'ALICE', 'IT');");
    run("INSERT INTO hr.emp VALUES (2, 'BOB', 'HR');");
    run("INSERT INTO hr.emp VALUES (3, 'CARL', 'IT');");
    run('COMMIT;');
  });

  it('SELECT by primary key returns the right row', () => {
    const out = run('SELECT name FROM hr.emp WHERE id = 2;');
    expect(out).toContain('BOB');
    expect(out).not.toContain('ALICE');
  });

  it('honours implicit number/string conversion in the probe', () => {
    const out = run("SELECT name FROM hr.emp WHERE id = '3';");
    expect(out).toContain('CARL');
  });

  it('sees rows inserted after the index was first probed', () => {
    run('SELECT name FROM hr.emp WHERE id = 1;');
    run("INSERT INTO hr.emp VALUES (4, 'DAVE', 'HR');");
    const out = run('SELECT name FROM hr.emp WHERE id = 4;');
    expect(out).toContain('DAVE');
  });

  it('stays correct after UPDATE moves a key', () => {
    run('UPDATE hr.emp SET id = 99 WHERE id = 1;');
    expect(run('SELECT name FROM hr.emp WHERE id = 99;')).toContain('ALICE');
    const gone = run('SELECT name FROM hr.emp WHERE id = 1;');
    expect(gone).toContain('no rows selected');
  });

  it('stays correct after DELETE', () => {
    run('DELETE FROM hr.emp WHERE id = 2;');
    const out = run('SELECT name FROM hr.emp WHERE id = 2;');
    expect(out).toContain('no rows selected');
  });

  it('stays correct after ROLLBACK restores rows', () => {
    run('DELETE FROM hr.emp WHERE id = 2;');
    run('ROLLBACK;');
    const out = run('SELECT name FROM hr.emp WHERE id = 2;');
    expect(out).toContain('BOB');
  });

  it('extra non-indexed predicates still filter the candidates', () => {
    const out = run("SELECT name FROM hr.emp WHERE id = 3 AND dept = 'HR';");
    expect(out).toContain('no rows selected');
  });

  it('an UPDATE that swaps duplicate keys onto rows still raises ORA-00001', () => {
    // Mid-statement staleness trap: the second row's uniqueness check must
    // see the first row already rewritten by this same UPDATE.
    const out = run('UPDATE hr.emp SET id = 5;');
    expect(out).toContain('ORA-00001');
  });
});

describe('UNIQUE enforcement across types', () => {
  it('detects duplicates on DATE keys', () => {
    run('CREATE TABLE hr.d1 (hired DATE UNIQUE);');
    run("INSERT INTO hr.d1 VALUES (DATE '2024-01-15');");
    const out = run("INSERT INTO hr.d1 VALUES (DATE '2024-01-15');");
    expect(out).toContain('ORA-00001');
  });

  it('detects duplicates on VARCHAR2 keys', () => {
    run('CREATE TABLE hr.s1 (code VARCHAR2(10) UNIQUE);');
    run("INSERT INTO hr.s1 VALUES ('X1');");
    const out = run("INSERT INTO hr.s1 VALUES ('X1');");
    expect(out).toContain('ORA-00001');
  });

  it("does not equate distinct numeric-looking strings ('05' vs '5')", () => {
    run('CREATE TABLE hr.s2 (code VARCHAR2(10) UNIQUE);');
    run("INSERT INTO hr.s2 VALUES ('5');");
    const out = run("INSERT INTO hr.s2 VALUES ('05');");
    expect(out).toContain('1 row created.');
  });
});

describe('FK parent lookups ride the parent key index', () => {
  beforeEach(() => {
    run('CREATE TABLE hr.dept (deptno NUMBER PRIMARY KEY, dname VARCHAR2(20));');
    run("INSERT INTO hr.dept VALUES (10, 'SALES');");
    run('CREATE TABLE hr.staff (id NUMBER PRIMARY KEY, deptno NUMBER, '
      + 'CONSTRAINT staff_dept_fk FOREIGN KEY (deptno) REFERENCES dept (deptno));');
  });

  it('accepts a child whose parent exists', () => {
    const out = run('INSERT INTO hr.staff VALUES (1, 10);');
    expect(out).toContain('1 row created.');
  });

  it('rejects a child whose parent is missing with ORA-02291', () => {
    const out = run('INSERT INTO hr.staff VALUES (2, 99);');
    expect(out).toContain('ORA-02291');
  });
});

describe('the index runtime is actually exercised', () => {
  it('probes answer PK SELECTs and bulk inserts do not rebuild per row', () => {
    run('CREATE TABLE hr.big (id NUMBER PRIMARY KEY, payload VARCHAR2(30));');
    for (let i = 1; i <= 60; i++) run(`INSERT INTO hr.big VALUES (${i}, 'row${i}');`);
    const storage = db.storage;
    const before = { ...storage.getIndexRuntimeStats() };
    run('SELECT payload FROM hr.big WHERE id = 37;');
    const after = storage.getIndexRuntimeStats();
    expect(after.probes).toBeGreaterThan(before.probes);
    // 60 single-row inserts each validate the PK; appends must extend the
    // existing structure, not rebuild it per statement.
    expect(after.builds).toBeLessThan(10);
  });

  it('EXPLAIN PLAN and execution agree on the index access path', () => {
    run('CREATE TABLE hr.acc (id NUMBER PRIMARY KEY, v VARCHAR2(10));');
    run("INSERT INTO hr.acc VALUES (1, 'a');");
    const { executor } = db.connectAsSysdba();
    const plan = db.executeSql(executor, 'EXPLAIN PLAN FOR SELECT * FROM hr.acc WHERE id = 1');
    const operations = plan.rows.map(r => String(r[1]));
    expect(operations.join('\n')).toMatch(/INDEX UNIQUE SCAN/i);
    const before = db.storage.getIndexRuntimeStats().probes;
    expect(run('SELECT v FROM hr.acc WHERE id = 1;')).toContain('a');
    expect(db.storage.getIndexRuntimeStats().probes).toBeGreaterThan(before);
  });
});
