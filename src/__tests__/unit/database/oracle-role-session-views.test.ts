/**
 * Oracle role / session dictionary views — TDD.
 *
 * Views that report real catalog access-control state and were missing
 * (ORA-00942 in the access-management debug transcript):
 *   ROLE_SYS_PRIVS, ROLE_TAB_PRIVS, ROLE_ROLE_PRIVS,
 *   SESSION_ROLES, SESSION_PRIVS.
 *
 * No stubs: every row is derived from the catalog grant registry.
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

describe('ROLE_SYS_PRIVS', () => {
  test('reports system privileges granted to a role (real grant state)', () => {
    exec('CREATE ROLE app_role');
    exec('GRANT CREATE SESSION TO app_role');
    exec('GRANT CREATE TABLE TO app_role WITH ADMIN OPTION');

    const r = exec(
      "SELECT ROLE, PRIVILEGE, ADMIN_OPTION FROM ROLE_SYS_PRIVS WHERE ROLE = 'APP_ROLE' ORDER BY PRIVILEGE"
    );
    expect(r.rows.length).toBe(2);
    expect(r.rows[0]).toEqual(['APP_ROLE', 'CREATE SESSION', 'NO']);
    expect(r.rows[1]).toEqual(['APP_ROLE', 'CREATE TABLE', 'YES']);
  });

  test('does not list privileges granted directly to users', () => {
    exec('CREATE USER u1 IDENTIFIED BY p');
    exec('GRANT CREATE TABLE TO u1');
    const r = exec("SELECT * FROM ROLE_SYS_PRIVS WHERE ROLE = 'U1'");
    expect(r.rows.length).toBe(0);
  });

  test('predefined DBA role exposes its system privileges', () => {
    const r = exec("SELECT COUNT(*) FROM ROLE_SYS_PRIVS WHERE ROLE = 'DBA'");
    expect(Number(r.rows[0][0])).toBeGreaterThan(0);
  });
});

describe('ROLE_TAB_PRIVS', () => {
  test('reports object privileges granted to a role', () => {
    exec('CREATE ROLE read_role');
    exec('CREATE TABLE hr.employees (id NUMBER, salary NUMBER)');
    exec('GRANT SELECT ON hr.employees TO read_role');

    const r = exec(
      "SELECT ROLE, OWNER, TABLE_NAME, PRIVILEGE, GRANTABLE FROM ROLE_TAB_PRIVS WHERE ROLE = 'READ_ROLE'"
    );
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]).toEqual(['READ_ROLE', 'HR', 'EMPLOYEES', 'SELECT', 'NO']);
  });

  test('object privileges granted to users are excluded', () => {
    exec('CREATE USER u2 IDENTIFIED BY p');
    exec('CREATE TABLE hr.t2 (id NUMBER)');
    exec('GRANT SELECT ON hr.t2 TO u2');
    const r = exec("SELECT * FROM ROLE_TAB_PRIVS WHERE ROLE = 'U2'");
    expect(r.rows.length).toBe(0);
  });
});
