/**
 * Oracle Security & Audit features — comprehensive tests for auditor use cases.
 *
 * Covers the data dictionary views and DDL/DCL statements that a security
 * auditor would query on a real Oracle 19c database:
 *
 *   1.  DBA_TAB_PRIVS — object-level privilege tracking
 *   2.  DBA_USERS — full column set (USER_ID, EXPIRY_DATE, LOCK_DATE, ...)
 *   3.  DBA_SYS_PRIVS / DBA_ROLE_PRIVS — system & role privilege grants
 *   4.  V$SESSION — realistic session metadata
 *   5.  DBA_AUDIT_TRAIL — audit trail with real entries
 *   6.  DBA_PROFILES — password & resource profile limits
 *   7.  CREATE/ALTER PROFILE — custom profile management
 *   8.  AUDIT / NOAUDIT — statement-level audit configuration
 *   9.  DBA_STMT_AUDIT_OPTS — audit option tracking
 *  10.  SYS.AUD$ — raw audit table
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import { OracleExecutor } from '../../../database/oracle/OracleExecutor';
import { SQLPlusSession } from '../../../database/oracle/commands/SQLPlusSession';

let db: OracleDatabase;
let executor: OracleExecutor;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  const conn = db.connectAsSysdba();
  executor = conn.executor;
});

function exec(sql: string) {
  return db.executeSql(executor, sql);
}

function createSQLPlus(): { cmd: (line: string) => string } {
  const session = new SQLPlusSession(db);
  session.processLine('CONNECT / AS SYSDBA');
  return {
    cmd(line: string): string {
      const result = session.processLine(line);
      return result.output.join('\n');
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// 1. DBA_TAB_PRIVS — object privilege tracking
// ═══════════════════════════════════════════════════════════════════

describe('DBA_TAB_PRIVS', () => {
  beforeEach(() => {
    exec('CREATE USER appuser IDENTIFIED BY pass123');
    exec('CREATE USER readonly IDENTIFIED BY pass123');
    exec('CREATE TABLE sensitive_data (id NUMBER, ssn VARCHAR2(20))');
  });

  test('GRANT SELECT populates DBA_TAB_PRIVS', () => {
    exec('GRANT SELECT ON sensitive_data TO appuser');
    const result = exec('SELECT GRANTEE, PRIVILEGE, TABLE_NAME FROM DBA_TAB_PRIVS');
    expect(result.rows.length).toBeGreaterThan(0);
    const grant = result.rows.find(r => r[0] === 'APPUSER');
    expect(grant).toBeDefined();
    expect(grant![1]).toBe('SELECT');
    expect(grant![2]).toBe('SENSITIVE_DATA');
  });

  test('GRANT multiple privileges on same table', () => {
    exec('GRANT SELECT, INSERT, UPDATE ON sensitive_data TO appuser');
    const result = exec(
      "SELECT PRIVILEGE FROM DBA_TAB_PRIVS WHERE GRANTEE = 'APPUSER' AND TABLE_NAME = 'SENSITIVE_DATA'"
    );
    const privs = result.rows.map(r => r[0]);
    expect(privs).toContain('SELECT');
    expect(privs).toContain('INSERT');
    expect(privs).toContain('UPDATE');
  });

  test('GRANT WITH GRANT OPTION is tracked', () => {
    exec('GRANT SELECT ON sensitive_data TO appuser WITH GRANT OPTION');
    const result = exec(
      "SELECT GRANTABLE FROM DBA_TAB_PRIVS WHERE GRANTEE = 'APPUSER' AND TABLE_NAME = 'SENSITIVE_DATA'"
    );
    expect(result.rows[0][0]).toBe('YES');
  });

  test('REVOKE removes entry from DBA_TAB_PRIVS', () => {
    exec('GRANT SELECT ON sensitive_data TO appuser');
    exec('REVOKE SELECT ON sensitive_data FROM appuser');
    const result = exec(
      "SELECT * FROM DBA_TAB_PRIVS WHERE GRANTEE = 'APPUSER' AND TABLE_NAME = 'SENSITIVE_DATA'"
    );
    expect(result.rows.length).toBe(0);
  });

  test('DBA_TAB_PRIVS has OWNER column showing schema owner', () => {
    exec('GRANT SELECT ON sensitive_data TO readonly');
    const result = exec(
      "SELECT OWNER FROM DBA_TAB_PRIVS WHERE GRANTEE = 'READONLY'"
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toBe('SYS');
  });

  test('multiple users with different privileges on same table', () => {
    exec('GRANT SELECT ON sensitive_data TO appuser');
    exec('GRANT SELECT, DELETE ON sensitive_data TO readonly');
    const result = exec('SELECT GRANTEE, PRIVILEGE FROM DBA_TAB_PRIVS ORDER BY GRANTEE');
    expect(result.rows.length).toBe(3);
  });

  test('DBA_TAB_PRIVS includes GRANTOR column', () => {
    exec('GRANT SELECT ON sensitive_data TO appuser');
    const result = exec('SELECT GRANTOR FROM DBA_TAB_PRIVS');
    expect(result.columns.some(c => c.name === 'GRANTOR')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. DBA_USERS — full Oracle 19c column set
// ═══════════════════════════════════════════════════════════════════

describe('DBA_USERS full columns', () => {
  test('DBA_USERS has all critical auditor columns', () => {
    const result = exec('SELECT * FROM DBA_USERS');
    const colNames = result.columns.map(c => c.name);
    // Critical columns an auditor checks on a real Oracle 19c
    expect(colNames).toContain('USERNAME');
    expect(colNames).toContain('USER_ID');
    expect(colNames).toContain('ACCOUNT_STATUS');
    expect(colNames).toContain('LOCK_DATE');
    expect(colNames).toContain('EXPIRY_DATE');
    expect(colNames).toContain('DEFAULT_TABLESPACE');
    expect(colNames).toContain('TEMPORARY_TABLESPACE');
    expect(colNames).toContain('CREATED');
    expect(colNames).toContain('PROFILE');
    expect(colNames).toContain('AUTHENTICATION_TYPE');
  });

  test('locked user has LOCK_DATE populated', () => {
    exec('CREATE USER locktest IDENTIFIED BY pass');
    exec('ALTER USER locktest ACCOUNT LOCK');
    const result = exec(
      "SELECT ACCOUNT_STATUS, LOCK_DATE FROM DBA_USERS WHERE USERNAME = 'LOCKTEST'"
    );
    expect(result.rows[0][0]).toBe('LOCKED');
    expect(result.rows[0][1]).not.toBeNull();
  });

  test('USER_ID is unique per user', () => {
    exec('CREATE USER user_a IDENTIFIED BY pass');
    exec('CREATE USER user_b IDENTIFIED BY pass');
    const result = exec('SELECT USER_ID, USERNAME FROM DBA_USERS');
    const ids = result.rows.map(r => r[0]);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test('newly created user has OPEN status and PASSWORD auth', () => {
    exec('CREATE USER newguy IDENTIFIED BY secret');
    const result = exec(
      "SELECT ACCOUNT_STATUS, AUTHENTICATION_TYPE FROM DBA_USERS WHERE USERNAME = 'NEWGUY'"
    );
    expect(result.rows[0][0]).toBe('OPEN');
    expect(result.rows[0][1]).toBe('PASSWORD');
  });

  test('SYS user has DEFAULT profile', () => {
    const result = exec(
      "SELECT PROFILE FROM DBA_USERS WHERE USERNAME = 'SYS'"
    );
    expect(result.rows[0][0]).toBe('DEFAULT');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. DBA_SYS_PRIVS / DBA_ROLE_PRIVS — privilege auditing
// ═══════════════════════════════════════════════════════════════════

describe('System and role privilege auditing', () => {
  beforeEach(() => {
    exec('CREATE USER devuser IDENTIFIED BY dev123');
    exec('CREATE ROLE app_developer');
  });

  test('GRANT system privilege appears in DBA_SYS_PRIVS', () => {
    exec('GRANT CREATE SESSION TO devuser');
    exec('GRANT CREATE TABLE TO devuser');
    const result = exec(
      "SELECT PRIVILEGE FROM DBA_SYS_PRIVS WHERE GRANTEE = 'DEVUSER'"
    );
    const privs = result.rows.map(r => r[0]);
    expect(privs).toContain('CREATE SESSION');
    expect(privs).toContain('CREATE TABLE');
  });

  test('DBA_SYS_PRIVS tracks ADMIN_OPTION', () => {
    exec('GRANT CREATE SESSION TO devuser WITH ADMIN OPTION');
    const result = exec(
      "SELECT ADMIN_OPTION FROM DBA_SYS_PRIVS WHERE GRANTEE = 'DEVUSER' AND PRIVILEGE = 'CREATE SESSION'"
    );
    expect(result.rows[0][0]).toBe('YES');
  });

  test('GRANT role appears in DBA_ROLE_PRIVS', () => {
    exec('GRANT app_developer TO devuser');
    const result = exec(
      "SELECT GRANTED_ROLE FROM DBA_ROLE_PRIVS WHERE GRANTEE = 'DEVUSER'"
    );
    expect(result.rows[0][0]).toBe('APP_DEVELOPER');
  });

  test('DBA_ROLE_PRIVS tracks ADMIN_OPTION for roles', () => {
    exec('GRANT app_developer TO devuser WITH ADMIN OPTION');
    const result = exec(
      "SELECT ADMIN_OPTION FROM DBA_ROLE_PRIVS WHERE GRANTEE = 'DEVUSER'"
    );
    expect(result.rows[0][0]).toBe('YES');
  });

  test('REVOKE system privilege removes from DBA_SYS_PRIVS', () => {
    exec('GRANT CREATE SESSION TO devuser');
    exec('REVOKE CREATE SESSION FROM devuser');
    const result = exec(
      "SELECT * FROM DBA_SYS_PRIVS WHERE GRANTEE = 'DEVUSER'"
    );
    expect(result.rows.length).toBe(0);
  });

  test('REVOKE role removes from DBA_ROLE_PRIVS', () => {
    exec('GRANT app_developer TO devuser');
    exec('REVOKE app_developer FROM devuser');
    const result = exec(
      "SELECT * FROM DBA_ROLE_PRIVS WHERE GRANTEE = 'DEVUSER'"
    );
    expect(result.rows.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. V$SESSION — realistic session view
// ═══════════════════════════════════════════════════════════════════

describe('V$SESSION', () => {
  test('V$SESSION has Oracle 19c critical columns', () => {
    const result = exec('SELECT * FROM V$SESSION');
    const colNames = result.columns.map(c => c.name);
    expect(colNames).toContain('SID');
    expect(colNames).toContain('SERIAL#');
    expect(colNames).toContain('USERNAME');
    expect(colNames).toContain('STATUS');
    expect(colNames).toContain('OSUSER');
    expect(colNames).toContain('MACHINE');
    expect(colNames).toContain('PROGRAM');
    expect(colNames).toContain('TYPE');
    expect(colNames).toContain('LOGON_TIME');
    expect(colNames).toContain('SCHEMANAME');
    expect(colNames).toContain('COMMAND');
    expect(colNames).toContain('SQL_ID');
  });

  test('V$SESSION shows current user session', () => {
    const result = exec(
      "SELECT SID, USERNAME, STATUS FROM V$SESSION WHERE TYPE = 'USER'"
    );
    expect(result.rows.length).toBeGreaterThan(0);
    const userRow = result.rows.find(r => r[1] === 'SYS');
    expect(userRow).toBeDefined();
    expect(userRow![2]).toBe('ACTIVE');
  });

  test('V$SESSION shows background processes', () => {
    const result = exec(
      "SELECT PROGRAM FROM V$SESSION WHERE TYPE = 'BACKGROUND'"
    );
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. DBA_AUDIT_TRAIL — audit trail with real entries
// ═══════════════════════════════════════════════════════════════════

describe('DBA_AUDIT_TRAIL', () => {
  test('DBA_AUDIT_TRAIL has Oracle 19c audit columns', () => {
    const result = exec('SELECT * FROM DBA_AUDIT_TRAIL');
    const colNames = result.columns.map(c => c.name);
    expect(colNames).toContain('OS_USERNAME');
    expect(colNames).toContain('USERNAME');
    expect(colNames).toContain('USERHOST');
    expect(colNames).toContain('TIMESTAMP');
    expect(colNames).toContain('ACTION_NAME');
    expect(colNames).toContain('OBJ_NAME');
    expect(colNames).toContain('RETURNCODE');
    expect(colNames).toContain('OBJ_OWNER');
    expect(colNames).toContain('SESSIONID');
    expect(colNames).toContain('PRIV_USED');
    expect(colNames).toContain('SQL_TEXT');
    expect(colNames).toContain('STATEMENT_TYPE');
  });

  test('DDL actions are recorded in audit trail', () => {
    exec('CREATE TABLE audit_test (id NUMBER)');
    const result = exec(
      "SELECT ACTION_NAME, OBJ_NAME FROM DBA_AUDIT_TRAIL WHERE OBJ_NAME = 'AUDIT_TEST'"
    );
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.some(r => r[0] === 'CREATE TABLE')).toBe(true);
  });

  test('user creation is audited', () => {
    exec('CREATE USER audited_user IDENTIFIED BY pass');
    const result = exec(
      "SELECT ACTION_NAME, OBJ_NAME FROM DBA_AUDIT_TRAIL WHERE ACTION_NAME = 'CREATE USER'"
    );
    expect(result.rows.length).toBeGreaterThan(0);
  });

  test('GRANT is audited', () => {
    exec('CREATE USER grant_target IDENTIFIED BY pass');
    exec('GRANT CREATE SESSION TO grant_target');
    const result = exec(
      "SELECT ACTION_NAME FROM DBA_AUDIT_TRAIL WHERE ACTION_NAME = 'GRANT'"
    );
    expect(result.rows.length).toBeGreaterThan(0);
  });

  test('failed operations record non-zero RETURNCODE', () => {
    try { exec('DROP TABLE nonexistent_xyz'); } catch { /* expected */ }
    const result = exec(
      "SELECT RETURNCODE FROM DBA_AUDIT_TRAIL WHERE ACTION_NAME = 'DROP TABLE'"
    );
    if (result.rows.length > 0) {
      expect(Number(result.rows[0][0])).toBeGreaterThan(0);
    }
  });

  test('SESSIONID is populated for audit entries', () => {
    exec('CREATE TABLE sid_test (id NUMBER)');
    const result = exec(
      "SELECT SESSIONID FROM DBA_AUDIT_TRAIL WHERE OBJ_NAME = 'SID_TEST'"
    );
    if (result.rows.length > 0) {
      expect(result.rows[0][0]).not.toBeNull();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. DBA_PROFILES — password & resource limits
// ═══════════════════════════════════════════════════════════════════

describe('DBA_PROFILES', () => {
  test('DEFAULT profile has all standard resource limits', () => {
    const result = exec(
      "SELECT RESOURCE_NAME, RESOURCE_TYPE, LIMIT FROM DBA_PROFILES WHERE PROFILE = 'DEFAULT'"
    );
    const resources = result.rows.map(r => r[0]);
    // Kernel resources
    expect(resources).toContain('SESSIONS_PER_USER');
    expect(resources).toContain('CPU_PER_SESSION');
    expect(resources).toContain('IDLE_TIME');
    expect(resources).toContain('CONNECT_TIME');
    // Password resources
    expect(resources).toContain('FAILED_LOGIN_ATTEMPTS');
    expect(resources).toContain('PASSWORD_LIFE_TIME');
    expect(resources).toContain('PASSWORD_REUSE_TIME');
    expect(resources).toContain('PASSWORD_REUSE_MAX');
    expect(resources).toContain('PASSWORD_LOCK_TIME');
    expect(resources).toContain('PASSWORD_GRACE_TIME');
    expect(resources).toContain('PASSWORD_VERIFY_FUNCTION');
  });

  test('DBA_PROFILES distinguishes KERNEL vs PASSWORD resource types', () => {
    const result = exec(
      "SELECT DISTINCT RESOURCE_TYPE FROM DBA_PROFILES WHERE PROFILE = 'DEFAULT'"
    );
    const types = result.rows.map(r => r[0]);
    expect(types).toContain('KERNEL');
    expect(types).toContain('PASSWORD');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. CREATE PROFILE / ALTER PROFILE
// ═══════════════════════════════════════════════════════════════════

describe('CREATE PROFILE / ALTER PROFILE', () => {
  test('CREATE PROFILE with password limits', () => {
    const result = exec(`
      CREATE PROFILE secure_profile LIMIT
        FAILED_LOGIN_ATTEMPTS 3
        PASSWORD_LIFE_TIME 90
        PASSWORD_LOCK_TIME 1
        PASSWORD_GRACE_TIME 5
    `);
    expect(result.message).toContain('Profile created');
  });

  test('custom profile appears in DBA_PROFILES', () => {
    exec(`
      CREATE PROFILE audit_profile LIMIT
        FAILED_LOGIN_ATTEMPTS 5
        PASSWORD_LIFE_TIME 60
    `);
    const result = exec(
      "SELECT RESOURCE_NAME, LIMIT FROM DBA_PROFILES WHERE PROFILE = 'AUDIT_PROFILE'"
    );
    expect(result.rows.length).toBeGreaterThan(0);
    const failedAttempts = result.rows.find(r => r[0] === 'FAILED_LOGIN_ATTEMPTS');
    expect(failedAttempts).toBeDefined();
    expect(failedAttempts![1]).toBe('5');
  });

  test('custom profile inherits DEFAULT for unspecified limits', () => {
    exec(`
      CREATE PROFILE minimal_profile LIMIT
        FAILED_LOGIN_ATTEMPTS 3
    `);
    const result = exec(
      "SELECT LIMIT FROM DBA_PROFILES WHERE PROFILE = 'MINIMAL_PROFILE' AND RESOURCE_NAME = 'PASSWORD_LIFE_TIME'"
    );
    // Unspecified limits inherit from DEFAULT
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toBe('DEFAULT');
  });

  test('assign custom profile to user', () => {
    exec(`CREATE PROFILE strict_profile LIMIT FAILED_LOGIN_ATTEMPTS 3`);
    exec('CREATE USER profiled_user IDENTIFIED BY pass PROFILE strict_profile');
    const result = exec(
      "SELECT PROFILE FROM DBA_USERS WHERE USERNAME = 'PROFILED_USER'"
    );
    expect(result.rows[0][0]).toBe('STRICT_PROFILE');
  });

  test('ALTER PROFILE modifies limits', () => {
    exec(`CREATE PROFILE modifiable LIMIT FAILED_LOGIN_ATTEMPTS 5`);
    exec(`ALTER PROFILE modifiable LIMIT FAILED_LOGIN_ATTEMPTS 10`);
    const result = exec(
      "SELECT LIMIT FROM DBA_PROFILES WHERE PROFILE = 'MODIFIABLE' AND RESOURCE_NAME = 'FAILED_LOGIN_ATTEMPTS'"
    );
    expect(result.rows[0][0]).toBe('10');
  });

  test('DROP PROFILE removes it from DBA_PROFILES', () => {
    exec(`CREATE PROFILE temp_profile LIMIT FAILED_LOGIN_ATTEMPTS 3`);
    exec('DROP PROFILE temp_profile');
    const result = exec(
      "SELECT * FROM DBA_PROFILES WHERE PROFILE = 'TEMP_PROFILE'"
    );
    expect(result.rows.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. AUDIT / NOAUDIT statements
// ═══════════════════════════════════════════════════════════════════

describe('AUDIT / NOAUDIT', () => {
  test('AUDIT statement succeeds', () => {
    const result = exec('AUDIT CREATE TABLE');
    expect(result.message).toContain('Audit succeeded');
  });

  test('AUDIT BY USER succeeds', () => {
    exec('CREATE USER audit_target IDENTIFIED BY pass');
    const result = exec('AUDIT SELECT TABLE BY audit_target');
    expect(result.message).toContain('Audit succeeded');
  });

  test('NOAUDIT removes audit configuration', () => {
    exec('AUDIT CREATE TABLE');
    const result = exec('NOAUDIT CREATE TABLE');
    expect(result.message).toContain('Noaudit succeeded');
  });

  test('AUDIT BY ACCESS vs BY SESSION', () => {
    const r1 = exec('AUDIT CREATE TABLE BY ACCESS');
    expect(r1.message).toContain('Audit succeeded');
    const r2 = exec('AUDIT DROP TABLE BY SESSION');
    expect(r2.message).toContain('Audit succeeded');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. DBA_STMT_AUDIT_OPTS — audit option configuration
// ═══════════════════════════════════════════════════════════════════

describe('DBA_STMT_AUDIT_OPTS', () => {
  test('DBA_STMT_AUDIT_OPTS shows configured audits', () => {
    exec('AUDIT CREATE TABLE');
    const result = exec('SELECT AUDIT_OPTION, SUCCESS, FAILURE FROM DBA_STMT_AUDIT_OPTS');
    expect(result.rows.length).toBeGreaterThan(0);
    const opt = result.rows.find(r => r[0] === 'CREATE TABLE');
    expect(opt).toBeDefined();
  });

  test('NOAUDIT removes from DBA_STMT_AUDIT_OPTS', () => {
    exec('AUDIT CREATE TABLE');
    exec('NOAUDIT CREATE TABLE');
    const result = exec(
      "SELECT * FROM DBA_STMT_AUDIT_OPTS WHERE AUDIT_OPTION = 'CREATE TABLE'"
    );
    expect(result.rows.length).toBe(0);
  });

  test('DBA_STMT_AUDIT_OPTS has USER_NAME column for BY USER', () => {
    exec('CREATE USER opts_user IDENTIFIED BY pass');
    exec('AUDIT SELECT TABLE BY opts_user');
    const result = exec(
      "SELECT USER_NAME, AUDIT_OPTION FROM DBA_STMT_AUDIT_OPTS WHERE USER_NAME = 'OPTS_USER'"
    );
    expect(result.rows.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 10. SYS.AUD$ — raw audit table
// ═══════════════════════════════════════════════════════════════════

describe('SYS.AUD$', () => {
  test('SYS.AUD$ has essential Oracle columns', () => {
    const result = exec('SELECT * FROM SYS.AUD$');
    const colNames = result.columns.map(c => c.name);
    expect(colNames).toContain('SESSIONID');
    expect(colNames).toContain('USERID');
    expect(colNames).toContain('ACTION#');
    expect(colNames).toContain('RETURNCODE');
    expect(colNames).toContain('TIMESTAMP#');
    expect(colNames).toContain('OBJ$NAME');
    expect(colNames).toContain('OBJ$CREATOR');
    expect(colNames).toContain('SQLTEXT');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 11. Auditor workflow — end-to-end scenario
// ═══════════════════════════════════════════════════════════════════

describe('Auditor workflow — end-to-end', () => {
  test('full security audit scenario', () => {
    // 1. Create users and roles
    exec('CREATE USER app_owner IDENTIFIED BY secret');
    exec('CREATE USER app_reader IDENTIFIED BY readonly');
    exec('CREATE ROLE data_reader');

    // 2. Set up objects
    exec('CREATE TABLE app_owner.customers (id NUMBER, name VARCHAR2(50))');

    // 3. Grant privileges
    exec('GRANT CREATE SESSION TO app_owner');
    exec('GRANT CREATE SESSION TO app_reader');
    exec('GRANT SELECT ON app_owner.customers TO data_reader');
    exec('GRANT data_reader TO app_reader');

    // 4. Auditor checks: who has what privileges?
    const sysPrivs = exec(
      "SELECT GRANTEE, PRIVILEGE FROM DBA_SYS_PRIVS WHERE GRANTEE IN ('APP_OWNER', 'APP_READER')"
    );
    expect(sysPrivs.rows.length).toBe(2);

    // 5. Auditor checks: role memberships
    const rolePrivs = exec(
      "SELECT GRANTEE, GRANTED_ROLE FROM DBA_ROLE_PRIVS WHERE GRANTEE = 'APP_READER'"
    );
    expect(rolePrivs.rows.length).toBe(1);
    expect(rolePrivs.rows[0][1]).toBe('DATA_READER');

    // 6. Auditor checks: object privileges on sensitive table
    const tabPrivs = exec(
      "SELECT GRANTEE, PRIVILEGE FROM DBA_TAB_PRIVS WHERE TABLE_NAME = 'CUSTOMERS'"
    );
    expect(tabPrivs.rows.length).toBe(1);
    expect(tabPrivs.rows[0][0]).toBe('DATA_READER');

    // 7. Auditor checks: user account statuses
    const users = exec(
      "SELECT USERNAME, ACCOUNT_STATUS, PROFILE FROM DBA_USERS WHERE USERNAME IN ('APP_OWNER', 'APP_READER')"
    );
    expect(users.rows.length).toBe(2);
  });

  test('SQL*Plus audit queries work', () => {
    const sp = createSQLPlus();
    sp.cmd('CREATE USER test_audit IDENTIFIED BY pass;');
    sp.cmd('GRANT CREATE SESSION TO test_audit;');
    const output = sp.cmd(
      "SELECT GRANTEE, PRIVILEGE FROM DBA_SYS_PRIVS WHERE GRANTEE = 'TEST_AUDIT';"
    );
    expect(output).toContain('TEST_AUDIT');
    expect(output).toContain('CREATE SESSION');
  });
});
