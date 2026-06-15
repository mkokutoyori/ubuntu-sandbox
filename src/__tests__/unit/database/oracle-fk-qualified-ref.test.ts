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
  run('INSERT INTO hr.dept VALUES (10);');
  run('COMMIT;');
});

describe('a schema-qualified FK reference is enforced (ORA-02291)', () => {
  it('REFERENCES hr.dept enforces the parent key like REFERENCES dept', () => {
    run('CREATE TABLE hr.emp (id NUMBER PRIMARY KEY, deptno NUMBER, '
      + 'CONSTRAINT emp_fk FOREIGN KEY (deptno) REFERENCES hr.dept (deptno));');
    const bad = run('INSERT INTO hr.emp VALUES (1, 99);');
    expect(bad).toMatch(/ORA-02291/);
    const good = run('INSERT INTO hr.emp VALUES (2, 10);');
    expect(good).toContain('1 row created.');
  });

  it('the DELETE-side rule also fires for a qualified FK (ORA-02292)', () => {
    run('CREATE TABLE hr.emp (id NUMBER PRIMARY KEY, deptno NUMBER, '
      + 'CONSTRAINT emp_fk FOREIGN KEY (deptno) REFERENCES hr.dept (deptno));');
    run('INSERT INTO hr.emp VALUES (1, 10);');
    expect(run('DELETE FROM hr.dept WHERE deptno = 10;')).toMatch(/ORA-02292/);
  });
});
