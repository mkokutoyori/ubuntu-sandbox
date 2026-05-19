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
