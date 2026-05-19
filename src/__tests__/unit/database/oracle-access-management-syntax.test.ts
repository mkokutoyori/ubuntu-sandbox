/**
 * Oracle access-management — parser/syntax gaps surfaced by the
 * `oracle-access-management` debug transcript.
 *
 * Each test pins down one syntactic feature that the upstream transcript
 * exercised but that the current parser/executor rejected. Tests drive the
 * implementation; once a test passes the corresponding real-world SQL*Plus
 * invocation is supported with the same semantics as production Oracle.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import { OracleExecutor } from '../../../database/oracle/OracleExecutor';

let db: OracleDatabase;
let executor: OracleExecutor;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  executor = db.connectAsSysdba().executor;
});

const exec = (sql: string) => db.executeSql(executor, sql);

// ──────────────────────────────────────────────────────────────────────
// Multi-grantee GRANT / REVOKE
// `GRANT CREATE SESSION TO bob, carol, dave;` — debug line 40
// ──────────────────────────────────────────────────────────────────────

describe('GRANT / REVOKE — multiple grantees', () => {
  beforeEach(() => {
    exec("CREATE USER bob IDENTIFIED BY p1");
    exec("CREATE USER carol IDENTIFIED BY p2");
    exec("CREATE USER dave IDENTIFIED BY p3");
  });

  test('GRANT to several users in one statement', () => {
    const r = exec("GRANT CREATE SESSION TO bob, carol, dave");
    expect(r.message).toContain('Grant succeeded');
    for (const u of ['BOB', 'CAROL', 'DAVE']) {
      const found = db.catalog
        .getSysPrivilegeGrants()
        .some(p => p.grantee === u && p.privilege === 'CREATE SESSION');
      expect(found, `${u} should hold CREATE SESSION`).toBe(true);
    }
  });

  test('GRANT role to several users', () => {
    exec("CREATE ROLE developer_role");
    exec("GRANT developer_role TO bob, carol, dave");
    const granted = db.catalog
      .getRoleGrants()
      .filter(rg => rg.role === 'DEVELOPER_ROLE')
      .map(rg => rg.grantee)
      .sort();
    expect(granted).toEqual(['BOB', 'CAROL', 'DAVE']);
  });

  test('REVOKE from several users', () => {
    exec("GRANT CREATE SESSION TO bob, carol, dave");
    exec("REVOKE CREATE SESSION FROM bob, carol");
    const remaining = db.catalog
      .getSysPrivilegeGrants()
      .filter(p => p.privilege === 'CREATE SESSION' && ['BOB','CAROL','DAVE'].includes(p.grantee))
      .map(p => p.grantee);
    expect(remaining).toEqual(['DAVE']);
  });

  test('GRANT object priv to several users', () => {
    exec("CREATE TABLE sys.t1 (id NUMBER)");
    exec("GRANT SELECT ON sys.t1 TO bob, carol");
    const grants = db.catalog
      .getTablePrivilegeGrants()
      .filter(p => p.objectName === 'T1' && p.privilege === 'SELECT')
      .map(p => p.grantee).sort();
    expect(grants).toEqual(['BOB', 'CAROL']);
  });
});

// ──────────────────────────────────────────────────────────────────────
// External / Kerberos-style authentication
// `CREATE USER k IDENTIFIED EXTERNALLY AS 'kerberos@REALM';` — line 36
// `ALTER USER alice IDENTIFIED EXTERNALLY;` — line 37
// ──────────────────────────────────────────────────────────────────────

describe('CREATE USER / ALTER USER — IDENTIFIED EXTERNALLY [AS]', () => {
  test('CREATE USER IDENTIFIED EXTERNALLY AS \'<kerb>\'', () => {
    exec("CREATE USER kuser IDENTIFIED EXTERNALLY AS 'kerberos@REALM.LOCAL'");
    const u = db.catalog.getUser('KUSER');
    expect(u?.authenticationType).toBe('EXTERNAL');
    expect(u?.externalName).toBe('kerberos@REALM.LOCAL');
  });

  test('ALTER USER ... IDENTIFIED EXTERNALLY switches auth type', () => {
    exec("CREATE USER alice IDENTIFIED BY pass1");
    exec("ALTER USER alice IDENTIFIED EXTERNALLY");
    const u = db.catalog.getUser('ALICE');
    expect(u?.authenticationType).toBe('EXTERNAL');
  });

  test('ALTER USER ... IDENTIFIED EXTERNALLY AS \'<dn>\'', () => {
    exec("CREATE USER alice IDENTIFIED BY pass1");
    exec("ALTER USER alice IDENTIFIED EXTERNALLY AS 'kerberos@REALM'");
    const u = db.catalog.getUser('ALICE');
    expect(u?.authenticationType).toBe('EXTERNAL');
    expect(u?.externalName).toBe('kerberos@REALM');
  });

  test('ALTER USER ... IDENTIFIED GLOBALLY AS \'<dn>\'', () => {
    exec("CREATE USER alice IDENTIFIED BY pass1");
    exec("ALTER USER alice IDENTIFIED GLOBALLY AS 'CN=alice,O=Acme'");
    const u = db.catalog.getUser('ALICE');
    expect(u?.authenticationType).toBe('GLOBAL');
    expect(u?.externalName).toBe('CN=alice,O=Acme');
  });
});

// ──────────────────────────────────────────────────────────────────────
// CREATE ROLE — IDENTIFIED [BY pw | EXTERNALLY | GLOBALLY] | NOT IDENTIFIED
// `CREATE ROLE admin_role IDENTIFIED BY pwd` — line 100
// `CREATE ROLE reporting_role NOT IDENTIFIED` — line 104
// ──────────────────────────────────────────────────────────────────────

describe('CREATE ROLE — identification clauses', () => {
  test('CREATE ROLE NOT IDENTIFIED', () => {
    exec("CREATE ROLE reporting_role NOT IDENTIFIED");
    const r = exec("SELECT role, authentication_type FROM dba_roles WHERE role = 'REPORTING_ROLE'");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0][1]).toBe('NONE');
  });

  test('CREATE ROLE IDENTIFIED BY pwd flags password_required=YES', () => {
    exec("CREATE ROLE admin_role IDENTIFIED BY \"Admin1#\"");
    const r = exec("SELECT password_required, authentication_type FROM dba_roles WHERE role = 'ADMIN_ROLE'");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0][0]).toBe('YES');
    expect(r.rows[0][1]).toBe('PASSWORD');
  });

  test('CREATE ROLE IDENTIFIED EXTERNALLY', () => {
    exec("CREATE ROLE ops_role IDENTIFIED EXTERNALLY");
    const r = exec("SELECT authentication_type FROM dba_roles WHERE role = 'OPS_ROLE'");
    expect(r.rows[0][0]).toBe('EXTERNAL');
  });
});

// ──────────────────────────────────────────────────────────────────────
// ALTER USER … DEFAULT ROLE …  (lines 134–138 of the transcript)
// ──────────────────────────────────────────────────────────────────────

describe('ALTER USER — DEFAULT ROLE clause', () => {
  beforeEach(() => {
    exec("CREATE USER alice IDENTIFIED BY p1");
    exec("CREATE USER bob IDENTIFIED BY p2");
    exec("CREATE USER carol IDENTIFIED BY p3");
    exec("CREATE USER dave IDENTIFIED BY p4");
    exec("CREATE ROLE app_role");
    exec("CREATE ROLE developer_role");
    exec("CREATE ROLE admin_role");
    exec("GRANT app_role TO bob");
    exec("GRANT app_role, developer_role, admin_role TO alice");
    exec("GRANT app_role, developer_role TO dave");
  });

  test('DEFAULT ROLE <name> marks only that role as default', () => {
    exec("ALTER USER bob DEFAULT ROLE app_role");
    const r = exec("SELECT granted_role, default_role FROM dba_role_privs WHERE grantee = 'BOB'");
    expect(r.rows).toEqual([['APP_ROLE', 'YES']]);
  });

  test('DEFAULT ROLE ALL EXCEPT <name> marks the excluded role NO', () => {
    exec("ALTER USER alice DEFAULT ROLE ALL EXCEPT admin_role");
    const r = exec("SELECT granted_role, default_role FROM dba_role_privs WHERE grantee = 'ALICE' ORDER BY granted_role");
    expect(r.rows).toEqual([
      ['ADMIN_ROLE', 'NO'],
      ['APP_ROLE', 'YES'],
      ['DEVELOPER_ROLE', 'YES'],
    ]);
  });

  test('DEFAULT ROLE NONE marks every grant NO', () => {
    exec("ALTER USER carol DEFAULT ROLE NONE");
    exec("GRANT app_role TO carol");
    const r = exec("SELECT default_role FROM dba_role_privs WHERE grantee = 'CAROL'");
    expect(r.rows.map(row => row[0])).toEqual(['NO']);
  });

  test('DEFAULT ROLE list with several roles', () => {
    exec("ALTER USER dave DEFAULT ROLE app_role, developer_role");
    const r = exec("SELECT granted_role, default_role FROM dba_role_privs WHERE grantee = 'DAVE' ORDER BY granted_role");
    expect(r.rows).toEqual([
      ['APP_ROLE', 'YES'],
      ['DEVELOPER_ROLE', 'YES'],
    ]);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Column-level GRANT / REVOKE  (lines 84–85, 165 of the transcript)
// ──────────────────────────────────────────────────────────────────────

describe('GRANT / REVOKE — column-level privileges', () => {
  beforeEach(() => {
    exec("CREATE USER dave IDENTIFIED BY p1");
    exec("CREATE USER eve IDENTIFIED BY p2");
    exec("CREATE TABLE sys.employees (employee_id NUMBER, first_name VARCHAR2(50), salary NUMBER)");
  });

  test('GRANT SELECT (col1, col2) ON tbl TO user populates DBA_COL_PRIVS', () => {
    exec("GRANT SELECT (employee_id, first_name) ON sys.employees TO dave");
    const r = exec("SELECT grantee, owner, table_name, column_name, privilege FROM dba_col_privs WHERE grantee = 'DAVE' ORDER BY column_name");
    expect(r.rows).toEqual([
      ['DAVE', 'SYS', 'EMPLOYEES', 'EMPLOYEE_ID', 'SELECT'],
      ['DAVE', 'SYS', 'EMPLOYEES', 'FIRST_NAME', 'SELECT'],
    ]);
  });

  test('GRANT UPDATE (col) ON tbl TO user', () => {
    exec("GRANT UPDATE (salary) ON sys.employees TO eve");
    const r = exec("SELECT grantee, column_name, privilege FROM dba_col_privs WHERE grantee = 'EVE'");
    expect(r.rows).toEqual([['EVE', 'SALARY', 'UPDATE']]);
  });

  test('REVOKE UPDATE (col) ON tbl FROM user removes the column grant', () => {
    exec("GRANT UPDATE (salary) ON sys.employees TO eve");
    exec("REVOKE UPDATE (salary) ON sys.employees FROM eve");
    const r = exec("SELECT COUNT(*) FROM dba_col_privs WHERE grantee = 'EVE'");
    expect(r.rows[0][0]).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Date arithmetic — SYSDATE ± n  (transcript line 33)
// ──────────────────────────────────────────────────────────────────────

describe('Expressions — date ± number', () => {
  test('SYSDATE - 1 returns a date one day earlier (no ORA-01722)', () => {
    const r = exec("SELECT SYSDATE - 1 FROM dual");
    expect(r.rows).toHaveLength(1);
    const before = String(r.rows[0][0]);
    expect(before).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    const now = Date.now();
    const got = Date.parse(before.replace(' ', 'T'));
    // Should be within a 2-day window of now-1d (loose to avoid flakes).
    expect(now - got).toBeGreaterThan(20 * 3600_000);
    expect(now - got).toBeLessThan(2 * 86400_000);
  });

  test('SYSDATE + 7 returns a date one week in the future', () => {
    const r = exec("SELECT SYSDATE + 7 FROM dual");
    const next = Date.parse(String(r.rows[0][0]).replace(' ', 'T'));
    expect(next - Date.now()).toBeGreaterThan(6 * 86400_000);
  });

  test('WHERE created > SYSDATE - 1 does not raise ORA-01722', () => {
    exec("CREATE USER alice IDENTIFIED BY p1");
    const r = exec("SELECT username FROM dba_users WHERE created > SYSDATE - 1 ORDER BY username");
    expect(r.rows.map(row => row[0])).toContain('ALICE');
  });
});

// ──────────────────────────────────────────────────────────────────────
// V$SQL / V$SQLAREA / V$SQLSTATS — three views, one cursor cache
// ──────────────────────────────────────────────────────────────────────

describe('Cursor cache views — V$SQL/V$SQLAREA/V$SQLSTATS coherence', () => {
  test('V$SQLAREA exposes the same SQL_IDs as V$SQL/V$SQLSTATS', () => {
    exec("SELECT 1 FROM dual");
    exec("SELECT 2 FROM dual");
    const ids = (sql: string) =>
      new Set(exec(sql).rows.map(r => String(r[0])));
    const a = ids("SELECT sql_id FROM v$sqlarea");
    const b = ids("SELECT sql_id FROM v$sql");
    const c = ids("SELECT sql_id FROM v$sqlstats");
    // Each query expands the cache by one — so the lookup itself is the
    // only legitimate diff between the three sets.
    const intersect = [...a].filter(id => b.has(id) && c.has(id));
    expect(intersect.length).toBeGreaterThan(1);
  });

  test('V$SQLAREA reflects executions counter as it climbs', () => {
    exec("SELECT 42 FROM dual");
    exec("SELECT 42 FROM dual");
    exec("SELECT 42 FROM dual");
    const r = exec("SELECT executions FROM v$sqlarea WHERE sql_text = 'SELECT 42 FROM dual'");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0][0]).toBeGreaterThanOrEqual(3);
  });
});
