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
  run('CREATE TABLE hr.emp (id NUMBER, dept VARCHAR2(20), sal NUMBER);');
  run("INSERT INTO hr.emp VALUES (1, 'IT', 1000);");
  run("INSERT INTO hr.emp VALUES (2, 'IT', 2000);");
  run("INSERT INTO hr.emp VALUES (3, 'HR', 1500);");
  run('COMMIT;');
});

describe('grouped/aggregate result columns carry the right data type', () => {
  it('CTAS from a GROUP BY query types COUNT/SUM/AVG as NUMBER', () => {
    run('CREATE TABLE hr.agg AS '
      + 'SELECT dept, COUNT(*) cnt, SUM(sal) total, AVG(sal) avg_sal FROM hr.emp GROUP BY dept;');
    const out = run("SELECT column_name, data_type FROM dba_tab_columns "
      + "WHERE owner='HR' AND table_name = 'AGG' ORDER BY column_id;");
    expect(out).toMatch(/cnt\s+NUMBER/i);
    expect(out).toMatch(/total\s+NUMBER/i);
    expect(out).toMatch(/avg_sal\s+NUMBER/i);
  });

  it('the GROUP BY column keeps its source type (VARCHAR2)', () => {
    run('CREATE TABLE hr.agg2 AS SELECT dept, COUNT(*) cnt FROM hr.emp GROUP BY dept;');
    const out = run("SELECT column_name, data_type FROM dba_tab_columns "
      + "WHERE owner='HR' AND table_name = 'AGG2' ORDER BY column_id;");
    expect(out).toMatch(/dept\s+VARCHAR2/i);
    expect(out).toMatch(/cnt\s+NUMBER/i);
  });

  it('MIN/MAX over a NUMBER column types as NUMBER', () => {
    run('CREATE TABLE hr.agg3 AS '
      + 'SELECT dept, MIN(sal) lo, MAX(sal) hi FROM hr.emp GROUP BY dept;');
    const out = run("SELECT column_name, data_type FROM dba_tab_columns "
      + "WHERE owner='HR' AND table_name = 'AGG3' ORDER BY column_id;");
    expect(out).toMatch(/lo\s+NUMBER/i);
    expect(out).toMatch(/hi\s+NUMBER/i);
  });
});
