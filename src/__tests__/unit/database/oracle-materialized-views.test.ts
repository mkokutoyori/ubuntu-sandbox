/**
 * Materialized views — real objects, not success-message stubs.
 *
 * Before (GAP §10.7): CREATE MATERIALIZED VIEW returned "Materialized
 * view created." without creating anything — SELECT against the MV
 * failed, DBA_MVIEWS stayed empty, DROP "succeeded" on nothing.
 *
 * Now: the defining query is executed into a real container table
 * (BUILD IMMEDIATE), the dictionary side lives in the catalog
 * (DBA_MVIEWS), DML on a base table flips STALENESS to STALE, and
 * DBMS_MVIEW.REFRESH re-executes the query (back to FRESH).
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
  run('CREATE TABLE hr.emp (id NUMBER, dept VARCHAR2(20), sal NUMBER);');
  run("INSERT INTO hr.emp VALUES (1, 'IT', 1000);");
  run("INSERT INTO hr.emp VALUES (2, 'IT', 2000);");
  run("INSERT INTO hr.emp VALUES (3, 'HR', 1500);");
});

describe('CREATE MATERIALIZED VIEW builds a queryable container', () => {
  it('SELECT against the MV returns the materialised rows', () => {
    run('CREATE MATERIALIZED VIEW hr.emp_by_dept AS SELECT dept, COUNT(*) AS cnt FROM hr.emp GROUP BY dept;');
    const out = run('SELECT * FROM hr.emp_by_dept ORDER BY dept;');
    expect(out).toMatch(/HR\s+1/);
    expect(out).toMatch(/IT\s+2/);
  });

  it('appears in DBA_MVIEWS with its metadata', () => {
    run('CREATE MATERIALIZED VIEW hr.emp_mv BUILD IMMEDIATE REFRESH COMPLETE ON DEMAND AS SELECT * FROM hr.emp;');
    const out = run("SELECT owner, mview_name, refresh_method, build_mode, staleness FROM dba_mviews;");
    expect(out).toMatch(/HR\s+EMP_MV/);
    expect(out).toMatch(/COMPLETE/);
    expect(out).toMatch(/IMMEDIATE/);
    expect(out).toMatch(/FRESH/);
  });

  it('rejects a duplicate name with ORA-00955', () => {
    run('CREATE MATERIALIZED VIEW hr.dup_mv AS SELECT * FROM hr.emp;');
    expect(run('CREATE MATERIALIZED VIEW hr.dup_mv AS SELECT * FROM hr.emp;')).toMatch(/ORA-00955/);
  });

  it('BUILD DEFERRED creates an empty, UNUSABLE container', () => {
    run('CREATE MATERIALIZED VIEW hr.def_mv BUILD DEFERRED AS SELECT * FROM hr.emp;');
    expect(run('SELECT COUNT(*) FROM hr.def_mv;')).toMatch(/\b0\b/);
    expect(run("SELECT staleness FROM dba_mviews WHERE mview_name = 'DEF_MV';")).toMatch(/UNUSABLE/);
  });
});

describe('staleness and DBMS_MVIEW.REFRESH', () => {
  it('the MV is a snapshot: base DML does not change it but marks it STALE', () => {
    run('CREATE MATERIALIZED VIEW hr.snap_mv AS SELECT COUNT(*) AS n FROM hr.emp;');
    expect(run('SELECT n FROM hr.snap_mv;')).toMatch(/\b3\b/);

    run("INSERT INTO hr.emp VALUES (4, 'IT', 3000);");
    // Snapshot unchanged…
    expect(run('SELECT n FROM hr.snap_mv;')).toMatch(/\b3\b/);
    // …but the dictionary knows it is stale.
    expect(run("SELECT staleness FROM dba_mviews WHERE mview_name = 'SNAP_MV';")).toMatch(/STALE/);
  });

  it('REFRESH re-executes the defining query and restores FRESH', () => {
    run('CREATE MATERIALIZED VIEW hr.r_mv AS SELECT COUNT(*) AS n FROM hr.emp;');
    run("INSERT INTO hr.emp VALUES (4, 'IT', 3000);");

    const out = run("EXEC DBMS_MVIEW.REFRESH('HR.R_MV')");
    expect(out).toMatch(/PL\/SQL procedure successfully completed/);
    expect(run('SELECT n FROM hr.r_mv;')).toMatch(/\b4\b/);
    expect(run("SELECT staleness FROM dba_mviews WHERE mview_name = 'R_MV';")).toMatch(/FRESH/);
  });

  it('REFRESH of an unknown MV raises ORA-12003', () => {
    expect(run("EXEC DBMS_MVIEW.REFRESH('HR.NO_SUCH_MV')")).toMatch(/ORA-12003/);
  });
});

describe('DROP MATERIALIZED VIEW', () => {
  it('removes both the container and the dictionary entry', () => {
    run('CREATE MATERIALIZED VIEW hr.gone_mv AS SELECT * FROM hr.emp;');
    expect(run('DROP MATERIALIZED VIEW hr.gone_mv;')).toMatch(/Materialized view dropped/);
    expect(run('SELECT * FROM hr.gone_mv;')).toMatch(/ORA-00942/);
    expect(run("SELECT COUNT(*) FROM dba_mviews WHERE mview_name = 'GONE_MV';")).toMatch(/\b0\b/);
  });

  it('raises ORA-12003 when the MV does not exist', () => {
    expect(run('DROP MATERIALIZED VIEW hr.never_was;')).toMatch(/ORA-12003/);
  });
});
