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
  run('CREATE TABLE hr.t (id NUMBER);');
  run('INSERT INTO hr.t VALUES (1);');
  run('INSERT INTO hr.t VALUES (2);');
  run('COMMIT;');
});

describe('ALTER TABLE ADD (col DEFAULT …) backfills and keeps the default', () => {
  it('existing rows get the DEFAULT, not NULL', () => {
    run("ALTER TABLE hr.t ADD (status VARCHAR2(10) DEFAULT 'NEW');");
    expect(run('SELECT COUNT(*) FROM hr.t WHERE status = \'NEW\';')).toMatch(/\b2\b/);
  });

  it('new rows that omit the column also get the DEFAULT', () => {
    run("ALTER TABLE hr.t ADD (status VARCHAR2(10) DEFAULT 'NEW');");
    run('INSERT INTO hr.t (id) VALUES (3);');
    expect(run("SELECT status FROM hr.t WHERE id = 3;")).toContain('NEW');
  });

  it('ADD NOT NULL with a DEFAULT succeeds and enforces', () => {
    run('ALTER TABLE hr.t ADD (flag NUMBER DEFAULT 0 NOT NULL);');
    expect(run('SELECT COUNT(*) FROM hr.t WHERE flag = 0;')).toMatch(/\b2\b/);
  });

  it('ADD a NOT NULL column with no default on a non-empty table → ORA-01758', () => {
    expect(run('ALTER TABLE hr.t ADD (mandatory NUMBER NOT NULL);')).toMatch(/ORA-01758/);
  });
});
