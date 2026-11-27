/*
 * Probe: an inline column constraint REFERENCES schema.table (col) was refused with ORA-00900 (Expected RPAREN) at the dot, while the table-level
 * FOREIGN KEY form and the unqualified inline form were accepted. Oracle SQL Language Reference, inline_ref_constraint: the referenced object is
 * [schema.]object. The inline parser now accepts the qualified name the table-level one already did, and the constraint is enforced the same way.
 *
 * Discriminated with git stash on src: 3 of 4 fall before the fix; the witness (the unqualified inline form) and the table-level form pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';

let session: SQLPlusSession;
const run = (sql: string) => session.processLine(sql).output.join('\n');

beforeEach(() => {
  const db = new OracleDatabase();
  db.instance.startup();
  session = new SQLPlusSession(db);
  session.login('SYS', '', true);
  run('CREATE TABLE hr.dept (deptno NUMBER PRIMARY KEY);');
  run('INSERT INTO hr.dept VALUES (10);');
  run('COMMIT;');
});

describe('inline REFERENCES with a qualified parent', () => {
  it('witness: the unqualified inline form is accepted and enforced', () => {
    expect(run('CREATE TABLE hr.e0 (id NUMBER PRIMARY KEY, deptno NUMBER REFERENCES dept (deptno));')).toContain('Table created.');
    expect(run('INSERT INTO hr.e0 VALUES (1, 99);')).toMatch(/ORA-02291/);
  });

  it('a qualified inline reference is accepted', () => {
    expect(run('CREATE TABLE hr.e1 (id NUMBER PRIMARY KEY, deptno NUMBER REFERENCES hr.dept (deptno));')).toContain('Table created.');
  });

  it('it is enforced: a missing parent is ORA-02291, an existing one is accepted', () => {
    run('CREATE TABLE hr.e2 (id NUMBER PRIMARY KEY, deptno NUMBER NOT NULL REFERENCES hr.dept (deptno));');
    expect(run('INSERT INTO hr.e2 VALUES (1, 99);')).toMatch(/ORA-02291/);
    expect(run('INSERT INTO hr.e2 VALUES (2, 10);')).toContain('1 row created.');
  });

  it('a named inline constraint with a qualified parent works and the parent cannot be deleted (ORA-02292)', () => {
    run('CREATE TABLE hr.e3 (id NUMBER PRIMARY KEY, deptno NUMBER CONSTRAINT e3_fk REFERENCES hr.dept (deptno));');
    run('INSERT INTO hr.e3 VALUES (1, 10);');
    expect(run('DELETE FROM hr.dept WHERE deptno = 10;')).toMatch(/ORA-02292/);
  });
});
