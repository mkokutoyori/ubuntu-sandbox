/**
 * Section 3 — OS-level security, password expiry in DBA_USERS, audit trail.
 *
 * Tests:
 *  - OS context (osUser, hostname, terminal, program) flows into V$SESSION
 *  - DBA_USERS.EXPIRY_DATE is computed from PasswordManager
 *  - DBA_USERS.ACCOUNT_STATUS reflects real password expiry state
 *  - DBA_AUDIT_SESSION records real OS username / terminal from session
 *  - V$SESSION_CONNECT_INFO has required columns
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { OracleExecutor } from '@/database/oracle/OracleExecutor';
import type { OsSecurityContext } from '@/database/oracle/security/types';

// ── Test harness ──────────────────────────────────────────────────────────────

let db: OracleDatabase;
let sysdbaExecutor: OracleExecutor;
let sysdbaSid: number;

function setup() {
  db = new OracleDatabase('test-device');
  db.instance.startup();
  const conn = db.connectAsSysdba();
  sysdbaExecutor = conn.executor;
  sysdbaSid = conn.sid;
}

function exec(sql: string, executor: OracleExecutor = sysdbaExecutor) {
  const rs = db.executeSql(executor, sql);
  if (rs.error) throw new Error(rs.error);
  return rs;
}

function colIdx(rs: ReturnType<typeof exec>, colName: string): number {
  const idx = (rs.columns ?? []).findIndex(c => c.name.toUpperCase() === colName.toUpperCase());
  if (idx === -1) throw new Error(`Column ${colName} not found in: ${(rs.columns ?? []).map(c => c.name).join(', ')}`);
  return idx;
}

function queryCol(sql: string, colName: string, executor = sysdbaExecutor): unknown[] {
  const rs = exec(sql, executor);
  const idx = colIdx(rs, colName);
  return (rs.rows ?? []).map(r => r[idx]);
}

// ── OS context in V$SESSION ───────────────────────────────────────────────────

describe('OS context in V$SESSION', () => {
  beforeEach(setup);

  it('custom osUser appears in V$SESSION.OSUSER', () => {
    const ctx: OsSecurityContext = {
      osUser: 'deployer',
      osGroup: 'dba',
      isDbaGroup: true,
      hostname: 'dbserver01',
      terminal: 'pts/3',
      program: 'sqlplus@dbserver01',
    };
    const { sid, executor } = db.connectAsSysdba(ctx);
    try {
      const rs = exec('SELECT SID, OSUSER, MACHINE, TERMINAL, PROGRAM FROM V$SESSION', executor);
      const sidI = colIdx(rs, 'SID');
      const osuserI = colIdx(rs, 'OSUSER');
      const machineI = colIdx(rs, 'MACHINE');
      const terminalI = colIdx(rs, 'TERMINAL');
      const programI = colIdx(rs, 'PROGRAM');

      const myRow = (rs.rows ?? []).find(r => r[sidI] === sid);
      expect(myRow).toBeDefined();
      expect(myRow![osuserI]).toBe('deployer');
      expect(myRow![machineI]).toBe('dbserver01');
      expect(myRow![terminalI]).toBe('pts/3');
      expect(myRow![programI]).toBe('sqlplus@dbserver01');
    } finally {
      db.disconnect(sid);
    }
  });

  it('default OS context uses localhost defaults', () => {
    const { sid, executor } = db.connectAsSysdba();
    try {
      const rs = exec('SELECT SID, OSUSER FROM V$SESSION', executor);
      const sidI = colIdx(rs, 'SID');
      const osuserI = colIdx(rs, 'OSUSER');
      const myRow = (rs.rows ?? []).find(r => r[sidI] === sid);
      expect(myRow).toBeDefined();
      expect(myRow![osuserI]).toBe('oracle');
    } finally {
      db.disconnect(sid);
    }
  });

  it('regular user connect stores correct machine in V$SESSION', () => {
    exec("CREATE USER testuser IDENTIFIED BY pass123");
    exec("GRANT CREATE SESSION TO testuser");
    const ctx: OsSecurityContext = {
      osUser: 'appuser',
      osGroup: 'oracle',
      isDbaGroup: false,
      hostname: 'appserver02',
      terminal: 'pts/1',
      program: 'jdbc@appserver02',
    };
    const { sid, executor } = db.connect('TESTUSER', 'pass123', ctx);
    try {
      const rs = exec('SELECT SID, MACHINE, OSUSER FROM V$SESSION', executor);
      const sidI = colIdx(rs, 'SID');
      const machineI = colIdx(rs, 'MACHINE');
      const myRow = (rs.rows ?? []).find(r => r[sidI] === sid);
      expect(myRow).toBeDefined();
      expect(myRow![machineI]).toBe('appserver02');
    } finally {
      db.disconnect(sid);
    }
  });

  it('program field is stored from OS context', () => {
    const ctx: OsSecurityContext = {
      osUser: 'oracle',
      osGroup: 'dba',
      isDbaGroup: true,
      hostname: 'myhost',
      terminal: 'pts/0',
      program: 'customapp@myhost',
    };
    const { sid, executor } = db.connectAsSysdba(ctx);
    try {
      const rs = exec('SELECT SID, PROGRAM FROM V$SESSION', executor);
      const sidI = colIdx(rs, 'SID');
      const progI = colIdx(rs, 'PROGRAM');
      const myRow = (rs.rows ?? []).find(r => r[sidI] === sid);
      expect(myRow).toBeDefined();
      expect(myRow![progI]).toBe('customapp@myhost');
    } finally {
      db.disconnect(sid);
    }
  });
});

// ── DBA_USERS expiry date from PasswordManager ────────────────────────────────

describe('DBA_USERS expiry from PasswordManager', () => {
  beforeEach(setup);

  it('EXPIRY_DATE is null for users with UNLIMITED password lifetime', () => {
    exec("CREATE PROFILE nolimit_prof LIMIT PASSWORD_LIFE_TIME UNLIMITED");
    exec("CREATE USER noexp IDENTIFIED BY pass123 PROFILE nolimit_prof");

    const rs = exec('SELECT USERNAME, EXPIRY_DATE FROM DBA_USERS');
    const unameI = colIdx(rs, 'USERNAME');
    const expiryI = colIdx(rs, 'EXPIRY_DATE');
    const row = (rs.rows ?? []).find(r => r[unameI] === 'NOEXP');
    expect(row).toBeDefined();
    expect(row![expiryI]).toBeNull();
  });

  it('EXPIRY_DATE is set when profile has finite PASSWORD_LIFE_TIME', () => {
    exec("CREATE PROFILE shortlife LIMIT PASSWORD_LIFE_TIME 90");
    exec("CREATE USER expuser IDENTIFIED BY pass123 PROFILE shortlife");

    const rs = exec('SELECT USERNAME, EXPIRY_DATE FROM DBA_USERS');
    const unameI = colIdx(rs, 'USERNAME');
    const expiryI = colIdx(rs, 'EXPIRY_DATE');
    const row = (rs.rows ?? []).find(r => r[unameI] === 'EXPUSER');
    expect(row).toBeDefined();
    expect(row![expiryI]).not.toBeNull();
    const expiry = new Date(row![expiryI] as string);
    const daysFromNow = (expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysFromNow).toBeGreaterThan(88);
    expect(daysFromNow).toBeLessThan(92);
  });

  it('ACCOUNT_STATUS shows EXPIRED when PASSWORD EXPIRE is set', () => {
    exec("CREATE USER expireduser IDENTIFIED BY pass123");
    exec("ALTER USER expireduser PASSWORD EXPIRE");

    const rs = exec('SELECT USERNAME, ACCOUNT_STATUS FROM DBA_USERS');
    const unameI = colIdx(rs, 'USERNAME');
    const statusI = colIdx(rs, 'ACCOUNT_STATUS');
    const row = (rs.rows ?? []).find(r => r[unameI] === 'EXPIREDUSER');
    expect(row).toBeDefined();
    expect(row![statusI]).toBe('EXPIRED');
  });

  it('ACCOUNT_STATUS shows LOCKED when account is locked', () => {
    exec("CREATE USER lockeduser IDENTIFIED BY pass123");
    exec("ALTER USER lockeduser ACCOUNT LOCK");

    const rs = exec('SELECT USERNAME, ACCOUNT_STATUS FROM DBA_USERS');
    const unameI = colIdx(rs, 'USERNAME');
    const statusI = colIdx(rs, 'ACCOUNT_STATUS');
    const row = (rs.rows ?? []).find(r => r[unameI] === 'LOCKEDUSER');
    expect(row).toBeDefined();
    expect(row![statusI]).toBe('LOCKED');
  });

  it('ACCOUNT_STATUS shows EXPIRED & LOCKED when both conditions apply', () => {
    exec("CREATE USER deaduser IDENTIFIED BY pass123");
    exec("ALTER USER deaduser ACCOUNT LOCK");
    exec("ALTER USER deaduser PASSWORD EXPIRE");

    const rs = exec('SELECT USERNAME, ACCOUNT_STATUS FROM DBA_USERS');
    const unameI = colIdx(rs, 'USERNAME');
    const statusI = colIdx(rs, 'ACCOUNT_STATUS');
    const row = (rs.rows ?? []).find(r => r[unameI] === 'DEADUSER');
    expect(row).toBeDefined();
    expect(row![statusI]).toBe('EXPIRED & LOCKED');
  });

  it('password change resets expiry based on new timestamp', () => {
    exec("CREATE PROFILE life30 LIMIT PASSWORD_LIFE_TIME 30");
    exec("CREATE USER freshuser IDENTIFIED BY oldpass PROFILE life30");
    exec("ALTER USER freshuser IDENTIFIED BY newpass");

    const rs = exec('SELECT USERNAME, EXPIRY_DATE FROM DBA_USERS');
    const unameI = colIdx(rs, 'USERNAME');
    const expiryI = colIdx(rs, 'EXPIRY_DATE');
    const row = (rs.rows ?? []).find(r => r[unameI] === 'FRESHUSER');
    expect(row).toBeDefined();
    const expiry = new Date(row![expiryI] as string);
    const daysFromNow = (expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysFromNow).toBeGreaterThan(28);
    expect(daysFromNow).toBeLessThan(32);
  });
});

// ── DBA_AUDIT_SESSION with OS context ────────────────────────────────────────

describe('DBA_AUDIT_SESSION OS context', () => {
  beforeEach(setup);

  it('DBA_AUDIT_SESSION shows real OS_USERNAME from connect context', () => {
    const ctx: OsSecurityContext = {
      osUser: 'auditoperator',
      osGroup: 'dba',
      isDbaGroup: true,
      hostname: 'audithost',
      terminal: 'pts/7',
      program: 'sqlplus@audithost',
    };
    const { sid, executor } = db.connectAsSysdba(ctx);
    try {
      const rs = exec('SELECT OS_USERNAME, USERHOST FROM DBA_AUDIT_SESSION', executor);
      const osUserI = colIdx(rs, 'OS_USERNAME');
      const userhostI = colIdx(rs, 'USERHOST');
      const rows = rs.rows ?? [];
      expect(rows.some(r => r[osUserI] === 'auditoperator')).toBe(true);
      expect(rows.some(r => r[userhostI] === 'audithost')).toBe(true);
    } finally {
      db.disconnect(sid);
    }
  });

  it('DBA_AUDIT_SESSION TERMINAL reflects connection terminal', () => {
    const ctx: OsSecurityContext = {
      osUser: 'oracle',
      osGroup: 'dba',
      isDbaGroup: true,
      hostname: 'localhost',
      terminal: 'pts/99',
      program: 'sqlplus@localhost',
    };
    const { sid, executor } = db.connectAsSysdba(ctx);
    try {
      const rs = exec('SELECT TERMINAL FROM DBA_AUDIT_SESSION', executor);
      const termI = colIdx(rs, 'TERMINAL');
      const rows = rs.rows ?? [];
      expect(rows.some(r => r[termI] === 'pts/99')).toBe(true);
    } finally {
      db.disconnect(sid);
    }
  });
});

// ── V$SESSION_CONNECT_INFO ────────────────────────────────────────────────────

describe('V$SESSION_CONNECT_INFO', () => {
  beforeEach(setup);

  it('has SID, AUTHENTICATION_TYPE columns', () => {
    const rs = exec('SELECT * FROM V$SESSION_CONNECT_INFO');
    const names = (rs.columns ?? []).map(c => c.name.toUpperCase());
    expect(names).toContain('SID');
    expect(names).toContain('AUTHENTICATION_TYPE');
  });

  it('shows a row for each active session', () => {
    const rows = exec('SELECT SID FROM V$SESSION_CONNECT_INFO').rows ?? [];
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ── SecurityEngine expiry awareness ──────────────────────────────────────────

describe('SecurityEngine — password expiry enforcement', () => {
  beforeEach(setup);

  it('PasswordManager tracks password change on CREATE USER', () => {
    exec("CREATE USER pwtrack IDENTIFIED BY mypassword");
    const expiry = db.securityEngine.passwords.computeExpiryDate('PWTRACK', 180);
    expect(expiry).not.toBeNull();
  });

  it('PasswordManager tracks password change on ALTER USER IDENTIFIED BY', () => {
    exec("CREATE USER pwtrack2 IDENTIFIED BY oldpass");
    exec("ALTER USER pwtrack2 IDENTIFIED BY newpass");
    const status = db.securityEngine.passwords.getPasswordStatus('PWTRACK2', 180, 7);
    expect(status).toBe('OPEN');
  });

  it('forced expiry shows EXPIRED in DBA_USERS and PasswordManager', () => {
    exec("CREATE USER forceexp IDENTIFIED BY pass");
    exec("ALTER USER forceexp PASSWORD EXPIRE");
    const status = db.securityEngine.passwords.getPasswordStatus('FORCEEXP', 180, 7);
    expect(status).toBe('EXPIRED');
  });

  it('DBA_USERS EXPIRY_DATE uses DEFAULT profile lifetime of 180 days by default', () => {
    exec("CREATE USER defaultprofuser IDENTIFIED BY pass");
    const rs = exec('SELECT USERNAME, EXPIRY_DATE FROM DBA_USERS');
    const unameI = colIdx(rs, 'USERNAME');
    const expiryI = colIdx(rs, 'EXPIRY_DATE');
    const row = (rs.rows ?? []).find(r => r[unameI] === 'DEFAULTPROFUSER');
    expect(row).toBeDefined();
    // DEFAULT profile has PASSWORD_LIFE_TIME=180, so expiry should be set
    expect(row![expiryI]).not.toBeNull();
    const expiry = new Date(row![expiryI] as string);
    const daysFromNow = (expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(daysFromNow).toBeGreaterThan(178);
    expect(daysFromNow).toBeLessThan(182);
  });
});
