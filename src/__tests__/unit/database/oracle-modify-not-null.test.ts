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
  run('CREATE TABLE hr.t (id NUMBER, name VARCHAR2(20));');
});

describe('ALTER TABLE MODIFY (col NOT NULL) enforces the constraint', () => {
  it('a NULL insert is rejected after MODIFY NOT NULL (ORA-01400)', () => {
    run('ALTER TABLE hr.t MODIFY (name NOT NULL);');
    expect(run("INSERT INTO hr.t (id) VALUES (1);")).toMatch(/ORA-01400/);
    expect(run("INSERT INTO hr.t VALUES (2, 'x');")).toContain('1 row created.');
  });

  it('MODIFY NOT NULL on a column with existing NULLs raises ORA-02296', () => {
    run("INSERT INTO hr.t (id) VALUES (1);");
    expect(run('ALTER TABLE hr.t MODIFY (name NOT NULL);')).toMatch(/ORA-02296/);
  });

  it('MODIFY (col NULL) lifts a NOT NULL constraint again', () => {
    run('ALTER TABLE hr.t MODIFY (name NOT NULL);');
    expect(run("INSERT INTO hr.t (id) VALUES (1);")).toMatch(/ORA-01400/);
    run('ALTER TABLE hr.t MODIFY (name NULL);');
    expect(run("INSERT INTO hr.t (id) VALUES (2);")).toContain('1 row created.');
  });
});
