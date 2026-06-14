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
  run('CREATE TABLE hr.dept (deptno NUMBER PRIMARY KEY);');
  run('CREATE TABLE hr.emp (id NUMBER PRIMARY KEY, deptno NUMBER, '
    + 'CONSTRAINT emp_fk FOREIGN KEY (deptno) REFERENCES hr.dept (deptno));');
});

describe('DROP TABLE of a referenced parent needs CASCADE CONSTRAINTS', () => {
  it('plain DROP of the parent raises ORA-02449', () => {
    expect(run('DROP TABLE hr.dept;')).toMatch(/ORA-02449/);
  });

  it('DROP … CASCADE CONSTRAINTS drops the parent and the child FK', () => {
    expect(run('DROP TABLE hr.dept CASCADE CONSTRAINTS;')).toContain('Table dropped.');
    // The child survives, its FK is gone, so any deptno now inserts freely.
    run('INSERT INTO hr.emp VALUES (1, 999);');
    expect(run('SELECT deptno FROM hr.emp;')).toMatch(/999/);
  });

  it('the child table drops without CASCADE (it is not referenced)', () => {
    expect(run('DROP TABLE hr.emp;')).toContain('Table dropped.');
  });
});
