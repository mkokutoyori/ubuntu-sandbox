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
  run('CREATE TABLE hr.dept (deptno NUMBER PRIMARY KEY, dname VARCHAR2(20));');
  run('CREATE TABLE hr.emp (id NUMBER PRIMARY KEY, deptno NUMBER, '
    + 'CONSTRAINT emp_dept_fk FOREIGN KEY (deptno) REFERENCES hr.dept (deptno));');
});

describe('TRUNCATE TABLE state and referential rules', () => {
  it('a parent referenced by an enabled FK raises ORA-02266', () => {
    expect(run('TRUNCATE TABLE hr.dept;')).toMatch(/ORA-02266/);
  });

  it('the child table truncates fine', () => {
    expect(run('TRUNCATE TABLE hr.emp;')).toContain('Table truncated.');
  });

  it('the parent truncates once the FK child is dropped', () => {
    run('DROP TABLE hr.emp;');
    expect(run('TRUNCATE TABLE hr.dept;')).toContain('Table truncated.');
  });

  it('TRUNCATE of a non-existent table raises ORA-00942', () => {
    expect(run('TRUNCATE TABLE hr.nope;')).toMatch(/ORA-00942/);
  });
});
