/**
 * Section 4 — Full authentication integration: SecurityEngine in connect(),
 * failed login lockout, password expiry enforcement, CREATE SESSION privilege.
 *
 * Tests that OracleDatabase.connect() goes through the SecurityEngine's full
 * authenticate() flow, not just the catalog's simple password check.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { OracleExecutor } from '@/database/oracle/OracleExecutor';

// ── Harness ───────────────────────────────────────────────────────────────────

let db: OracleDatabase;
let sysdba: OracleExecutor;

function setup() {
  db = new OracleDatabase('test-device');
  db.instance.startup();
  const conn = db.connectAsSysdba();
  sysdba = conn.executor;
}

function exec(sql: string, executor: OracleExecutor = sysdba) {
  const rs = db.executeSql(executor, sql);
  if (rs.error) throw new Error(rs.error);
  return rs;
}

// ── Failed login tracking ─────────────────────────────────────────────────────

describe('Failed login tracking', () => {
  beforeEach(setup);

  it('records failed logins in LoginTracker', () => {
    exec("CREATE USER failuser IDENTIFIED BY correctpass");
    // Wrong password
    try { db.connect('FAILUSER', 'wrongpass'); } catch {}
    const count = db.securityEngine.loginTracker.getFailedCount('FAILUSER');
    expect(count).toBe(1);
  });

  it('auto-locks account after FAILED_LOGIN_ATTEMPTS exceeded', () => {
    exec("CREATE PROFILE strict LIMIT FAILED_LOGIN_ATTEMPTS 3");
    exec("CREATE USER lockme IDENTIFIED BY mypass PROFILE strict");
    exec("GRANT CREATE SESSION TO lockme");

    // 3 failed attempts
    for (let i = 0; i < 3; i++) {
      try { db.connect('LOCKME', 'wrong'); } catch {}
    }

    // Account should now be locked
    expect(() => db.connect('LOCKME', 'mypass')).toThrow(/ORA-28000/);
  });

  it('successful login resets failed counter', () => {
    exec("CREATE USER resetme IDENTIFIED BY mypass");
    exec("GRANT CREATE SESSION TO resetme");

    try { db.connect('RESETME', 'wrong'); } catch {}
    expect(db.securityEngine.loginTracker.getFailedCount('RESETME')).toBe(1);

    const { sid } = db.connect('RESETME', 'mypass');
    expect(db.securityEngine.loginTracker.getFailedCount('RESETME')).toBe(0);
    db.disconnect(sid);
  });

  it('locked account cannot connect even with correct password', () => {
    exec("CREATE USER lockedone IDENTIFIED BY mypass");
    exec("ALTER USER lockedone ACCOUNT LOCK");

    expect(() => db.connect('LOCKEDONE', 'mypass')).toThrow(/ORA-28000/);
  });
});

// ── Password expiry enforcement ───────────────────────────────────────────────

describe('Password expiry enforcement in connect()', () => {
  beforeEach(setup);

  it('force-expired password prevents connect with ORA-28001', () => {
    exec("CREATE USER expconn IDENTIFIED BY mypass");
    exec("GRANT CREATE SESSION TO expconn");
    exec("ALTER USER expconn PASSWORD EXPIRE");

    expect(() => db.connect('EXPCONN', 'mypass')).toThrow(/ORA-28001/);
  });

  it('OPEN account connects successfully', () => {
    exec("CREATE USER openconn IDENTIFIED BY mypass");
    exec("GRANT CREATE SESSION TO openconn");

    const { sid } = db.connect('OPENCONN', 'mypass');
    expect(sid).toBeGreaterThan(0);
    db.disconnect(sid);
  });

  it('wrong password throws ORA-01017', () => {
    exec("CREATE USER wrongpass IDENTIFIED BY mypass");
    exec("GRANT CREATE SESSION TO wrongpass");

    expect(() => db.connect('WRONGPASS', 'badpass')).toThrow(/ORA-01017/);
  });
});

// ── Full authentication lifecycle ─────────────────────────────────────────────

describe('Full authentication lifecycle', () => {
  beforeEach(setup);

  it('create user → grant → connect → query → disconnect lifecycle', () => {
    exec("CREATE USER appuser IDENTIFIED BY apppass DEFAULT TABLESPACE USERS");
    exec("GRANT CREATE SESSION TO appuser");
    exec("GRANT CREATE TABLE TO appuser");

    const { sid, executor } = db.connect('APPUSER', 'apppass');
    expect(sid).toBeGreaterThan(0);

    const rs = db.executeSql(executor, "SELECT USER FROM DUAL");
    expect(rs.rows?.[0]?.[0]).toBe('APPUSER');

    // Session should appear in V$SESSION
    const sessionRs = db.executeSql(executor, "SELECT USERNAME FROM V$SESSION WHERE TYPE = 'USER'");
    const usernames = (sessionRs.rows ?? []).map(r => r[0]);
    expect(usernames).toContain('APPUSER');

    db.disconnect(sid);

    // After disconnect, session should be gone from SecurityEngine
    const allSessions = db.securityEngine.sessions.getAllSessions();
    expect(allSessions.find(s => s.sid === sid)).toBeUndefined();
  });

  it('multiple concurrent sessions for same user', () => {
    exec("CREATE PROFILE multi LIMIT SESSIONS_PER_USER 3");
    exec("CREATE USER multiuser IDENTIFIED BY pass PROFILE multi");
    exec("GRANT CREATE SESSION TO multiuser");

    const s1 = db.connect('MULTIUSER', 'pass');
    const s2 = db.connect('MULTIUSER', 'pass');
    const s3 = db.connect('MULTIUSER', 'pass');

    expect(db.securityEngine.sessions.countUserSessions('MULTIUSER')).toBe(3);

    // 4th connection should fail
    expect(() => db.connect('MULTIUSER', 'pass')).toThrow(/ORA-02391/);

    db.disconnect(s1.sid);
    db.disconnect(s2.sid);
    db.disconnect(s3.sid);
  });

  it('DROP USER cleans up all security state', () => {
    exec("CREATE USER dropme IDENTIFIED BY pass");
    exec("GRANT CREATE SESSION TO dropme");

    const { sid } = db.connect('DROPME', 'pass');
    db.disconnect(sid);

    exec("DROP USER dropme");

    // Should not exist in password history either
    const userExists = db.catalog.userExists('DROPME');
    expect(userExists).toBe(false);

    const sessions = db.securityEngine.sessions.getAllSessions();
    expect(sessions.find(s => s.username === 'DROPME')).toBeUndefined();
  });
});

// ── Audit trail recording ──────────────────────────────────────────────────────

describe('Audit trail recording', () => {
  beforeEach(setup);

  it('DBA_AUDIT_TRAIL has OS_USERNAME and USERNAME columns', () => {
    const rs = exec("SELECT OS_USERNAME, USERNAME, ACTION_NAME FROM DBA_AUDIT_TRAIL");
    const names = (rs.columns ?? []).map(c => c.name.toUpperCase());
    expect(names).toContain('OS_USERNAME');
    expect(names).toContain('USERNAME');
    expect(names).toContain('ACTION_NAME');
  });

  it('DBA_AUDIT_SESSION records active sessions', () => {
    // sysdba session is already active
    const rs = exec("SELECT USERNAME FROM DBA_AUDIT_SESSION");
    const usernames = (rs.rows ?? []).map(r => r[0]);
    expect(usernames).toContain('SYS');
  });

  it('UNIFIED_AUDIT_TRAIL has DBUSERNAME column', () => {
    const rs = exec("SELECT DBUSERNAME FROM UNIFIED_AUDIT_TRAIL");
    expect((rs.columns ?? []).map(c => c.name.toUpperCase())).toContain('DBUSERNAME');
  });
});

// ── SecurityEngine.authenticate() integration ──────────────────────────────────

describe('SecurityEngine.authenticate() integration', () => {
  beforeEach(setup);

  it('authenticate() returns success for valid credentials', () => {
    exec("CREATE USER authtest IDENTIFIED BY mypass");
    const result = db.securityEngine.authenticate('AUTHTEST', 'mypass', db.catalog, 'mypass');
    expect(result.success).toBe(true);
    expect(result.errorCode).toBe(0);
  });

  it('authenticate() returns failure for wrong password', () => {
    exec("CREATE USER authtest2 IDENTIFIED BY mypass");
    const result = db.securityEngine.authenticate('AUTHTEST2', 'wrong', db.catalog, 'mypass');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(1017);
  });

  it('authenticate() returns ORA-28000 for locked account', () => {
    exec("CREATE USER lockedauth IDENTIFIED BY mypass");
    exec("ALTER USER lockedauth ACCOUNT LOCK");
    // The password stored in catalog
    const storedPwd = 'mypass';
    const result = db.securityEngine.authenticate('LOCKEDAUTH', 'mypass', db.catalog, storedPwd);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(28000);
  });

  it('authenticate() returns ORA-28001 for expired password', () => {
    exec("CREATE USER expiredauth IDENTIFIED BY mypass");
    exec("ALTER USER expiredauth PASSWORD EXPIRE");
    const result = db.securityEngine.authenticate('EXPIREDAUTH', 'mypass', db.catalog, 'mypass');
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe(28001);
  });
});
