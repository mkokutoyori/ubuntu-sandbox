/**
 * Oracle Access Management — TDD tests for users, roles, privileges, profiles, quotas.
 *
 * Covers the complete lifecycle expected from the debug transcript:
 *   1. CREATE USER with QUOTA clause
 *   2. ALTER USER with QUOTA, DEFAULT TABLESPACE, PROFILE
 *   3. CREATE/ALTER/DROP PROFILE with all limit types
 *   4. DBA_TS_QUOTAS and USER_TS_QUOTAS views
 *   5. DBA_PROFILES with SecurityEngine backing
 *   6. GRANT/REVOKE privilege flows
 *   7. ALTER USER ACCOUNT LOCK/UNLOCK
 *   8. PASSWORD EXPIRE
 *   9. Profile fractions (PASSWORD_LOCK_TIME 1/24)
 *  10. SHOW USER; (SQLPlus command with semicolon)
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import { OracleExecutor } from '../../../database/oracle/OracleExecutor';
import { SQLPlusSession } from '../../../database/oracle/commands/SQLPlusSession';
import type { SecurityEngine } from '../../../database/oracle/security/SecurityEngine';

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

function engine(): SecurityEngine {
  return db.securityEngine;
}

// ═══════════════════════════════════════════════════════════════════
// 1. CREATE USER with QUOTA
// ═══════════════════════════════════════════════════════════════════

describe('CREATE USER — QUOTA clause', () => {
  test('CREATE USER with QUOTA 100M ON tablespace', () => {
    exec("CREATE USER alice IDENTIFIED BY pass1 QUOTA 100M ON users");
    const quota = engine().quotas.getQuota('ALICE', 'USERS');
    expect(quota).toBeDefined();
    expect(quota!.maxBytes).toBe(100 * 1024 * 1024);
  });

  test('CREATE USER with QUOTA UNLIMITED ON tablespace', () => {
    exec("CREATE USER bob IDENTIFIED BY pass1 QUOTA UNLIMITED ON users");
    const quota = engine().quotas.getQuota('BOB', 'USERS');
    expect(quota?.maxBytes).toBe(-1);
  });

  test('CREATE USER with multiple QUOTA clauses', () => {
    exec("CREATE USER carol IDENTIFIED BY pass1 QUOTA 100M ON users QUOTA 500M ON data");
    expect(engine().quotas.getQuota('CAROL', 'USERS')?.maxBytes).toBe(100 * 1024 * 1024);
    expect(engine().quotas.getQuota('CAROL', 'DATA')?.maxBytes).toBe(500 * 1024 * 1024);
  });

  test('CREATE USER with DEFAULT TABLESPACE and QUOTA', () => {
    const result = exec("CREATE USER dave IDENTIFIED BY pass1 DEFAULT TABLESPACE users TEMPORARY TABLESPACE temp QUOTA 200M ON users");
    expect(result.message).toContain('User created');
    const user = db.catalog.getUser('DAVE');
    expect(user?.defaultTablespace).toBe('USERS');
    expect(user?.temporaryTablespace).toBe('TEMP');
  });

  test('DBA_TS_QUOTAS reflects created quota', () => {
    exec("CREATE USER quota_user IDENTIFIED BY pass1 QUOTA 50M ON users");
    const result = exec("SELECT USERNAME, TABLESPACE_NAME, MAX_BYTES FROM DBA_TS_QUOTAS WHERE USERNAME = 'QUOTA_USER'");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0][0]).toBe('QUOTA_USER');
    expect(result.rows[0][1]).toBe('USERS');
    expect(result.rows[0][2]).toBe(50 * 1024 * 1024);
  });

  test('USER_TS_QUOTAS shows current user quotas', () => {
    exec("CREATE USER qview IDENTIFIED BY pass1 QUOTA 100M ON users");
    const result = exec("SELECT TABLESPACE_NAME, MAX_BYTES FROM USER_TS_QUOTAS");
    // DBA user connecting, not qview — but let's verify the view structure
    expect(result.columns.map(c => c.name)).toContain('TABLESPACE_NAME');
    expect(result.columns.map(c => c.name)).toContain('MAX_BYTES');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. ALTER USER
// ═══════════════════════════════════════════════════════════════════

describe('ALTER USER', () => {
  beforeEach(() => {
    exec("CREATE USER modify_me IDENTIFIED BY oldpass");
  });

  test('ALTER USER IDENTIFIED BY changes password', () => {
    exec("ALTER USER modify_me IDENTIFIED BY newpass");
    expect(db.catalog.authenticate('modify_me', 'newpass')).toBe(true);
    expect(db.catalog.authenticate('modify_me', 'oldpass')).toBe(false);
  });

  test('ALTER USER ACCOUNT LOCK locks user', () => {
    exec("ALTER USER modify_me ACCOUNT LOCK");
    const user = db.catalog.getUser('MODIFY_ME');
    expect(user?.accountStatus).toBe('LOCKED');
  });

  test('ALTER USER ACCOUNT UNLOCK unlocks user', () => {
    exec("ALTER USER modify_me ACCOUNT LOCK");
    exec("ALTER USER modify_me ACCOUNT UNLOCK");
    const user = db.catalog.getUser('MODIFY_ME');
    expect(user?.accountStatus).toBe('OPEN');
  });

  test('ALTER USER QUOTA grants quota', () => {
    exec("ALTER USER modify_me QUOTA 200M ON users");
    expect(engine().quotas.getQuota('MODIFY_ME', 'USERS')?.maxBytes).toBe(200 * 1024 * 1024);
  });

  test('ALTER USER DEFAULT TABLESPACE changes tablespace', () => {
    exec("ALTER USER modify_me DEFAULT TABLESPACE system");
    expect(db.catalog.getUser('MODIFY_ME')?.defaultTablespace).toBe('SYSTEM');
  });

  test('ALTER USER PROFILE assigns profile', () => {
    exec("CREATE PROFILE strict_p LIMIT FAILED_LOGIN_ATTEMPTS 3");
    exec("ALTER USER modify_me PROFILE strict_p");
    expect(db.catalog.getUser('MODIFY_ME')?.profile).toBe('STRICT_P');
  });

  test('ALTER USER PASSWORD EXPIRE marks password expired', () => {
    exec("ALTER USER modify_me PASSWORD EXPIRE");
    expect(engine().passwords.isForceExpired('MODIFY_ME')).toBe(true);
  });

  test('ALTER USER on non-existent user throws ORA-01917', () => {
    expect(() => exec("ALTER USER ghost_user IDENTIFIED BY pass")).toThrow(/1917|does not exist/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. CREATE/ALTER/DROP PROFILE
// ═══════════════════════════════════════════════════════════════════

describe('CREATE PROFILE', () => {
  test('creates profile with basic limits', () => {
    exec("CREATE PROFILE basic_p LIMIT FAILED_LOGIN_ATTEMPTS 5 PASSWORD_LIFE_TIME 90");
    expect(engine().profiles.profileExists('BASIC_P')).toBe(true);
    expect(engine().profiles.resolveLimit('BASIC_P', 'FAILED_LOGIN_ATTEMPTS')).toBe('5');
    expect(engine().profiles.resolveLimit('BASIC_P', 'PASSWORD_LIFE_TIME')).toBe('90');
  });

  test('creates profile with all password parameters', () => {
    exec(`CREATE PROFILE full_p LIMIT
      FAILED_LOGIN_ATTEMPTS 5
      PASSWORD_LIFE_TIME 90
      PASSWORD_REUSE_TIME 365
      PASSWORD_REUSE_MAX 5
      PASSWORD_LOCK_TIME 1
      PASSWORD_GRACE_TIME 7
      SESSIONS_PER_USER 10
      IDLE_TIME 30
      CONNECT_TIME 240
    `);
    expect(engine().profiles.resolveLimit('FULL_P', 'SESSIONS_PER_USER')).toBe('10');
    expect(engine().profiles.resolveLimit('FULL_P', 'IDLE_TIME')).toBe('30');
    expect(engine().profiles.resolveLimit('FULL_P', 'CONNECT_TIME')).toBe('240');
  });

  test('fractional PASSWORD_LOCK_TIME 1/24 is accepted', () => {
    exec("CREATE PROFILE frac_p LIMIT FAILED_LOGIN_ATTEMPTS 3 PASSWORD_LOCK_TIME 1/24");
    expect(engine().profiles.profileExists('FRAC_P')).toBe(true);
    const lockTime = engine().profiles.resolveLockTimeDays('FRAC_P');
    expect(lockTime).toBeCloseTo(1 / 24);
  });

  test('fractional 1/1440 is accepted', () => {
    exec("CREATE PROFILE min_p LIMIT PASSWORD_LOCK_TIME 1/1440");
    expect(engine().profiles.resolveLockTimeDays('MIN_P')).toBeCloseTo(1 / 1440);
  });

  test('UNLIMITED value accepted', () => {
    exec("CREATE PROFILE unlim_p LIMIT PASSWORD_LOCK_TIME UNLIMITED");
    expect(engine().profiles.resolveLimit('UNLIM_P', 'PASSWORD_LOCK_TIME')).toBe('UNLIMITED');
  });

  test('DEFAULT value accepted', () => {
    exec("CREATE PROFILE def_p LIMIT FAILED_LOGIN_ATTEMPTS DEFAULT");
    expect(engine().profiles.resolveLimit('DEF_P', 'FAILED_LOGIN_ATTEMPTS')).toBe('10');
  });

  test('DBA_PROFILES shows created profile', () => {
    exec("CREATE PROFILE myprofile LIMIT FAILED_LOGIN_ATTEMPTS 7");
    const result = exec("SELECT PROFILE, RESOURCE_NAME, LIMIT FROM DBA_PROFILES WHERE PROFILE = 'MYPROFILE' AND RESOURCE_NAME = 'FAILED_LOGIN_ATTEMPTS'");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0][2]).toBe('7');
  });

  test('cannot create profile named DEFAULT', () => {
    expect(() => exec("CREATE PROFILE default LIMIT FAILED_LOGIN_ATTEMPTS 5")).toThrow();
  });
});

describe('ALTER PROFILE', () => {
  beforeEach(() => {
    exec("CREATE PROFILE alt_p LIMIT FAILED_LOGIN_ATTEMPTS 5");
  });

  test('ALTER PROFILE updates limit', () => {
    exec("ALTER PROFILE alt_p LIMIT FAILED_LOGIN_ATTEMPTS 3");
    expect(engine().profiles.resolveLimit('ALT_P', 'FAILED_LOGIN_ATTEMPTS')).toBe('3');
  });

  test('ALTER PROFILE DEFAULT updates default limits', () => {
    exec("ALTER PROFILE default LIMIT FAILED_LOGIN_ATTEMPTS 3");
    expect(engine().profiles.resolveLimit('DEFAULT', 'FAILED_LOGIN_ATTEMPTS')).toBe('3');
  });

  test('ALTER PROFILE on non-existent profile throws', () => {
    expect(() => exec("ALTER PROFILE ghost_p LIMIT IDLE_TIME 30")).toThrow();
  });
});

describe('DROP PROFILE', () => {
  test('DROP PROFILE removes profile', () => {
    exec("CREATE PROFILE todrop_p LIMIT IDLE_TIME 30");
    exec("DROP PROFILE todrop_p");
    expect(engine().profiles.profileExists('TODROP_P')).toBe(false);
  });

  test('cannot drop DEFAULT profile', () => {
    expect(() => exec("DROP PROFILE default")).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. DBA_PROFILES view accuracy
// ═══════════════════════════════════════════════════════════════════

describe('DBA_PROFILES view', () => {
  test('DEFAULT profile has all resource parameters', () => {
    const result = exec("SELECT RESOURCE_NAME FROM DBA_PROFILES WHERE PROFILE = 'DEFAULT'");
    const resourceNames = result.rows.map(r => r[0] as string);
    expect(resourceNames).toContain('FAILED_LOGIN_ATTEMPTS');
    expect(resourceNames).toContain('PASSWORD_LIFE_TIME');
    expect(resourceNames).toContain('SESSIONS_PER_USER');
    expect(resourceNames).toContain('IDLE_TIME');
    expect(resourceNames).toContain('CONNECT_TIME');
  });

  test('DEFAULT FAILED_LOGIN_ATTEMPTS is 10', () => {
    const result = exec("SELECT LIMIT FROM DBA_PROFILES WHERE PROFILE = 'DEFAULT' AND RESOURCE_NAME = 'FAILED_LOGIN_ATTEMPTS'");
    expect(result.rows[0][0]).toBe('10');
  });

  test('resource type for PASSWORD params is PASSWORD', () => {
    const result = exec("SELECT RESOURCE_TYPE FROM DBA_PROFILES WHERE PROFILE = 'DEFAULT' AND RESOURCE_NAME = 'PASSWORD_LIFE_TIME'");
    expect(result.rows[0][0]).toBe('PASSWORD');
  });

  test('resource type for KERNEL params is KERNEL', () => {
    const result = exec("SELECT RESOURCE_TYPE FROM DBA_PROFILES WHERE PROFILE = 'DEFAULT' AND RESOURCE_NAME = 'SESSIONS_PER_USER'");
    expect(result.rows[0][0]).toBe('KERNEL');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. GRANT/REVOKE
// ═══════════════════════════════════════════════════════════════════

describe('GRANT and REVOKE', () => {
  beforeEach(() => {
    exec("CREATE USER grantee_user IDENTIFIED BY pass1");
    exec("CREATE TABLE grant_target (id NUMBER, name VARCHAR2(50))");
  });

  test('GRANT SELECT populates DBA_TAB_PRIVS', () => {
    exec("GRANT SELECT ON grant_target TO grantee_user");
    const result = exec("SELECT GRANTEE, PRIVILEGE, TABLE_NAME FROM DBA_TAB_PRIVS WHERE GRANTEE = 'GRANTEE_USER'");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0][1]).toBe('SELECT');
  });

  test('GRANT role assigns role', () => {
    exec("GRANT CONNECT TO grantee_user");
    const result = exec("SELECT GRANTEE, GRANTED_ROLE FROM DBA_ROLE_PRIVS WHERE GRANTEE = 'GRANTEE_USER'");
    const roles = result.rows.map(r => r[1]);
    expect(roles).toContain('CONNECT');
  });

  test('GRANT system privilege', () => {
    exec("GRANT CREATE TABLE TO grantee_user");
    const result = exec("SELECT GRANTEE, PRIVILEGE FROM DBA_SYS_PRIVS WHERE GRANTEE = 'GRANTEE_USER'");
    const privs = result.rows.map(r => r[1]);
    expect(privs).toContain('CREATE TABLE');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. SHOW USER in SQLPlus
// ═══════════════════════════════════════════════════════════════════

describe('SQLPlus SHOW USER', () => {
  test('SHOW USER returns current user', () => {
    const session = new SQLPlusSession(db);
    session.login('SYS', 'oracle', true);
    const result = session.processLine('SHOW USER');
    expect(result.output.join('\n')).toMatch(/USER is "SYS"/i);
  });

  test('SHOW USER; (with semicolon) still works', () => {
    const session = new SQLPlusSession(db);
    session.login('SYS', 'oracle', true);
    // SHOW USER; — semicolon should be stripped
    const result = session.processLine('SHOW USER;');
    expect(result.output.join('\n')).not.toContain('SP2-0158');
    expect(result.output.join('\n')).toMatch(/USER is/i);
  });

  test('CONNECT / AS SYSDBA sets user to SYS', () => {
    const session = new SQLPlusSession(db);
    session.processLine('CONNECT / AS SYSDBA');
    const result = session.processLine('SHOW USER');
    expect(result.output.join('\n')).toContain('SYS');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. DBA_USERS view accuracy
// ═══════════════════════════════════════════════════════════════════

describe('DBA_USERS view', () => {
  test('shows all default users', () => {
    const result = exec("SELECT USERNAME FROM DBA_USERS ORDER BY USERNAME");
    const usernames = result.rows.map(r => r[0] as string);
    expect(usernames).toContain('SYS');
    expect(usernames).toContain('SYSTEM');
    expect(usernames).toContain('HR');
  });

  test('includes PROFILE column', () => {
    const result = exec("SELECT USERNAME, PROFILE FROM DBA_USERS WHERE USERNAME = 'SYS'");
    expect(result.rows[0][1]).toBe('DEFAULT');
  });

  test('CREATE USER appears in DBA_USERS', () => {
    exec("CREATE USER newuser IDENTIFIED BY pass");
    const result = exec("SELECT USERNAME FROM DBA_USERS WHERE USERNAME = 'NEWUSER'");
    expect(result.rows).toHaveLength(1);
  });

  test('LOCKED user shows LOCKED status', () => {
    exec("CREATE USER locktest IDENTIFIED BY pass ACCOUNT LOCK");
    const result = exec("SELECT ACCOUNT_STATUS FROM DBA_USERS WHERE USERNAME = 'LOCKTEST'");
    expect(result.rows[0][0]).toBe('LOCKED');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. ALTER SYSTEM KILL SESSION
// ═══════════════════════════════════════════════════════════════════

describe('ALTER SYSTEM KILL SESSION', () => {
  test('kills an active session', () => {
    // Connect a session to get a real sid/serial
    exec("CREATE USER sess_user IDENTIFIED BY pass");
    exec("GRANT CREATE SESSION TO sess_user");
    const conn = db.connect('sess_user', 'pass');
    const sessions = engine().sessions.getAllSessions();
    const userSession = sessions.find(s => s.username === 'SESS_USER');
    expect(userSession).toBeDefined();

    const sid = userSession!.sid;
    const serial = userSession!.serial;
    exec(`ALTER SYSTEM KILL SESSION '${sid},${serial}'`);

    const afterSessions = engine().sessions.getAllSessions();
    expect(afterSessions.find(s => s.sid === sid)).toBeUndefined();
  });

  test('killing non-existent session throws ORA-00031', () => {
    expect(() => exec("ALTER SYSTEM KILL SESSION '999,999'")).toThrow(/31|no such session/i);
  });

  test('ALTER SYSTEM DISCONNECT SESSION works', () => {
    exec("CREATE USER disc_user IDENTIFIED BY pass");
    exec("GRANT CREATE SESSION TO disc_user");
    const conn = db.connect('disc_user', 'pass');
    const sessions = engine().sessions.getAllSessions();
    const sess = sessions.find(s => s.username === 'DISC_USER');
    expect(sess).toBeDefined();
    exec(`ALTER SYSTEM DISCONNECT SESSION '${sess!.sid},${sess!.serial}' IMMEDIATE`);
    expect(engine().sessions.getAllSessions().find(s => s.sid === sess!.sid)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. OS security context
// ═══════════════════════════════════════════════════════════════════

describe('OS security context in V$SESSION', () => {
  test('V$SESSION shows TERMINAL column', () => {
    const result = exec("SELECT SID, TERMINAL FROM V$SESSION WHERE TYPE = 'USER'");
    expect(result.columns.map(c => c.name)).toContain('TERMINAL');
  });

  test('V$SESSION shows BLOCKING_SESSION column', () => {
    const result = exec("SELECT BLOCKING_SESSION FROM V$SESSION WHERE ROWNUM < 5");
    expect(result.columns.map(c => c.name)).toContain('BLOCKING_SESSION');
  });

  test('V$SESSION shows SQL_CHILD_NUMBER column', () => {
    const result = exec("SELECT SQL_CHILD_NUMBER FROM V$SESSION WHERE ROWNUM < 5");
    expect(result.columns.map(c => c.name)).toContain('SQL_CHILD_NUMBER');
  });

  test('V$SESSION shows SQL_EXEC_START column', () => {
    const result = exec("SELECT SQL_EXEC_START FROM V$SESSION WHERE ROWNUM < 5");
    expect(result.columns.map(c => c.name)).toContain('SQL_EXEC_START');
  });

  test('V$SESSION shows EVENT column', () => {
    const result = exec("SELECT EVENT, WAIT_CLASS FROM V$SESSION WHERE ROWNUM < 5");
    expect(result.columns.map(c => c.name)).toContain('EVENT');
    expect(result.columns.map(c => c.name)).toContain('WAIT_CLASS');
  });

  test('V$SESSION shows LAST_CALL_ET column', () => {
    const result = exec("SELECT LAST_CALL_ET FROM V$SESSION WHERE ROWNUM < 5");
    expect(result.columns.map(c => c.name)).toContain('LAST_CALL_ET');
  });
});
