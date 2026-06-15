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

describe('ALTER TABLE ADD/DROP CONSTRAINT actually enforces (was a silent no-op)', () => {
  it('ADD a UNIQUE constraint then enforce it (ORA-00001)', () => {
    run('CREATE TABLE hr.t (id NUMBER, code VARCHAR2(10));');
    run("INSERT INTO hr.t VALUES (1, 'A');");
    run('ALTER TABLE hr.t ADD CONSTRAINT t_uk UNIQUE (code);');
    const dup = run("INSERT INTO hr.t VALUES (2, 'A');");
    expect(dup).toMatch(/ORA-00001/);
  });

  it('ADD a CHECK constraint then enforce it (ORA-02290)', () => {
    run('CREATE TABLE hr.t (id NUMBER, age NUMBER);');
    run('ALTER TABLE hr.t ADD CONSTRAINT t_chk CHECK (age >= 0);');
    expect(run('INSERT INTO hr.t VALUES (1, -5);')).toMatch(/ORA-02290/);
    expect(run('INSERT INTO hr.t VALUES (1, 5);')).toContain('1 row created.');
  });

  it('ADD a FK constraint then enforce it (ORA-02291)', () => {
    run('CREATE TABLE hr.dept (deptno NUMBER PRIMARY KEY);');
    run('INSERT INTO hr.dept VALUES (10);');
    run('CREATE TABLE hr.emp (id NUMBER, deptno NUMBER);');
    run('ALTER TABLE hr.emp ADD CONSTRAINT emp_fk FOREIGN KEY (deptno) REFERENCES hr.dept (deptno);');
    expect(run('INSERT INTO hr.emp VALUES (1, 99);')).toMatch(/ORA-02291/);
    expect(run('INSERT INTO hr.emp VALUES (1, 10);')).toContain('1 row created.');
  });

  it('ADD CONSTRAINT validates existing rows (rejects violating data)', () => {
    run('CREATE TABLE hr.t (id NUMBER, code VARCHAR2(10));');
    run("INSERT INTO hr.t VALUES (1, 'A');");
    run("INSERT INTO hr.t VALUES (2, 'A');");
    expect(run('ALTER TABLE hr.t ADD CONSTRAINT t_uk UNIQUE (code);')).toMatch(/ORA-00001/);
  });

  it('DROP CONSTRAINT stops the enforcement', () => {
    run('CREATE TABLE hr.t (id NUMBER, code VARCHAR2(10) CONSTRAINT t_uk UNIQUE);');
    run("INSERT INTO hr.t VALUES (1, 'A');");
    expect(run("INSERT INTO hr.t VALUES (2, 'A');")).toMatch(/ORA-00001/);
    run('ALTER TABLE hr.t DROP CONSTRAINT t_uk;');
    expect(run("INSERT INTO hr.t VALUES (3, 'A');")).toContain('1 row created.');
  });

  it('DROP of an unknown constraint raises ORA-02443', () => {
    run('CREATE TABLE hr.t (id NUMBER);');
    expect(run('ALTER TABLE hr.t DROP CONSTRAINT nope;')).toMatch(/ORA-02443/);
  });
});
