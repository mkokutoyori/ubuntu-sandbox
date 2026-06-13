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
  run('CREATE TABLE hr.tgt (id NUMBER PRIMARY KEY, val VARCHAR2(10));');
  run("INSERT INTO hr.tgt VALUES (1, 'old');");
  run('CREATE TABLE hr.src (id NUMBER, val VARCHAR2(10));');
  run("INSERT INTO hr.src VALUES (1, 'new');");
  run("INSERT INTO hr.src VALUES (2, 'ins');");
});

const merge = () => run(
  'MERGE INTO hr.tgt t USING hr.src s ON (t.id = s.id) '
  + 'WHEN MATCHED THEN UPDATE SET t.val = s.val '
  + 'WHEN NOT MATCHED THEN INSERT (id, val) VALUES (s.id, s.val);');

describe('MERGE reports "N rows merged." like real SQL*Plus', () => {
  it('an update + insert merge reports the total, not a per-clause breakdown', () => {
    const out = merge();
    expect(out).toMatch(/\b2 rows merged\.\s*$/);
    expect(out).not.toMatch(/\(updated\)|\(inserted\)/);
  });

  it('still applies the upsert correctly', () => {
    merge();
    const res = run('SELECT id, val FROM hr.tgt ORDER BY id;');
    expect(res).toMatch(/1\s+new/);
    expect(res).toMatch(/2\s+ins/);
  });
});
