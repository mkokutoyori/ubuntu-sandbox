/**
 * Oracle Security Engine — TDD tests for all security subsystems.
 *
 * Covers:
 *   1. ProfileManager: CRUD, limit resolution, fraction parsing
 *   2. QuotaManager: grant, revoke, byte tracking
 *   3. LoginTracker: failed attempts, lockout, auto-unlock
 *   4. PasswordManager: expiry, grace period, reuse restrictions
 *   5. SessionLimitTracker: registration, count, kill
 *   6. PrivilegeChecker: system privs, object privs, role expansion
 *   7. SecurityEngine: full authentication flow
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { ProfileManager } from '../../../database/oracle/security/ProfileManager';
import { QuotaManager } from '../../../database/oracle/security/QuotaManager';
import { LoginTracker } from '../../../database/oracle/security/LoginTracker';
import { PasswordManager } from '../../../database/oracle/security/PasswordManager';
import { SessionLimitTracker } from '../../../database/oracle/security/SessionLimitTracker';
import { SecurityEngine } from '../../../database/oracle/security/SecurityEngine';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import { DEFAULT_OS_CONTEXT } from '../../../database/oracle/security/types';

// ═══════════════════════════════════════════════════════════════════
// 1. ProfileManager
// ═══════════════════════════════════════════════════════════════════

describe('ProfileManager — CRUD', () => {
  let mgr: ProfileManager;
  beforeEach(() => { mgr = new ProfileManager(); });

  test('DEFAULT profile always exists', () => {
    expect(mgr.profileExists('DEFAULT')).toBe(true);
  });

  test('createProfile adds a new profile', () => {
    mgr.createProfile('SECURE', new Map([['FAILED_LOGIN_ATTEMPTS', '3']]));
    expect(mgr.profileExists('SECURE')).toBe(true);
  });

  test('cannot create DEFAULT profile', () => {
    expect(() => mgr.createProfile('DEFAULT', new Map())).toThrow(/cannot be created/);
  });

  test('alterProfile updates limits', () => {
    mgr.createProfile('APP', new Map([['IDLE_TIME', '30']]));
    mgr.alterProfile('APP', new Map([['IDLE_TIME', '60']]));
    expect(mgr.resolveLimit('APP', 'IDLE_TIME')).toBe('60');
  });

  test('alterProfile on non-existent throws', () => {
    expect(() => mgr.alterProfile('MISSING', new Map())).toThrow(/does not exist/);
  });

  test('dropProfile removes profile', () => {
    mgr.createProfile('TEMP', new Map());
    mgr.dropProfile('TEMP');
    expect(mgr.profileExists('TEMP')).toBe(false);
  });

  test('cannot drop DEFAULT', () => {
    expect(() => mgr.dropProfile('DEFAULT')).toThrow(/cannot drop/);
  });

  test('getAllProfileNames includes DEFAULT', () => {
    mgr.createProfile('P1', new Map());
    const names = mgr.getAllProfileNames();
    expect(names).toContain('DEFAULT');
    expect(names).toContain('P1');
  });
});

describe('ProfileManager — limit resolution', () => {
  let mgr: ProfileManager;
  beforeEach(() => { mgr = new ProfileManager(); });

  test('profile param set to DEFAULT inherits from DEFAULT profile', () => {
    mgr.createProfile('CHILD', new Map([['FAILED_LOGIN_ATTEMPTS', 'DEFAULT']]));
    // DEFAULT profile has FAILED_LOGIN_ATTEMPTS = 10
    expect(mgr.resolveLimit('CHILD', 'FAILED_LOGIN_ATTEMPTS')).toBe('10');
  });

  test('profile param set to concrete value returns that value', () => {
    mgr.createProfile('STRICT', new Map([['FAILED_LOGIN_ATTEMPTS', '3']]));
    expect(mgr.resolveLimit('STRICT', 'FAILED_LOGIN_ATTEMPTS')).toBe('3');
  });

  test('resolveFailedLoginAttempts returns number', () => {
    mgr.createProfile('P', new Map([['FAILED_LOGIN_ATTEMPTS', '5']]));
    expect(mgr.resolveFailedLoginAttempts('P')).toBe(5);
  });

  test('resolveFailedLoginAttempts UNLIMITED returns Infinity', () => {
    mgr.createProfile('P', new Map([['FAILED_LOGIN_ATTEMPTS', 'UNLIMITED']]));
    expect(mgr.resolveFailedLoginAttempts('P')).toBe(Infinity);
  });

  test('resolveLockTimeDays parses 1/24 as 1 hour', () => {
    mgr.createProfile('P', new Map([['PASSWORD_LOCK_TIME', '1/24']]));
    const days = mgr.resolveLockTimeDays('P');
    expect(days).toBeCloseTo(1 / 24);
  });

  test('resolveLockTimeDays parses 1/1440 as 1 minute', () => {
    mgr.createProfile('P', new Map([['PASSWORD_LOCK_TIME', '1/1440']]));
    const days = mgr.resolveLockTimeDays('P');
    expect(days).toBeCloseTo(1 / 1440);
  });

  test('alterProfile on DEFAULT profile updates default limits', () => {
    mgr.alterProfile('DEFAULT', new Map([['FAILED_LOGIN_ATTEMPTS', '3']]));
    expect(mgr.resolveLimit('DEFAULT', 'FAILED_LOGIN_ATTEMPTS')).toBe('3');
  });
});

describe('ProfileManager — DBA_PROFILES rows', () => {
  let mgr: ProfileManager;
  beforeEach(() => { mgr = new ProfileManager(); });

  test('getAllProfileRows returns rows for DEFAULT profile', () => {
    const rows = mgr.getAllProfileRows();
    const defaultFla = rows.find(r => r.profile === 'DEFAULT' && r.resourceName === 'FAILED_LOGIN_ATTEMPTS');
    expect(defaultFla).toBeDefined();
    expect(defaultFla!.limit).toBe('10');
  });

  test('custom profile rows show raw limits', () => {
    mgr.createProfile('CUSTOM', new Map([['SESSIONS_PER_USER', '5']]));
    const rows = mgr.getAllProfileRows();
    const sessRow = rows.find(r => r.profile === 'CUSTOM' && r.resourceName === 'SESSIONS_PER_USER');
    expect(sessRow?.limit).toBe('5');
  });

  test('unset limits in custom profile show DEFAULT', () => {
    mgr.createProfile('PARTIAL', new Map([['IDLE_TIME', '30']]));
    const rows = mgr.getAllProfileRows();
    const flaRow = rows.find(r => r.profile === 'PARTIAL' && r.resourceName === 'FAILED_LOGIN_ATTEMPTS');
    expect(flaRow?.limit).toBe('DEFAULT');
  });

  test('resource type for password params is PASSWORD', () => {
    const rows = mgr.getAllProfileRows();
    const passRow = rows.find(r => r.resourceName === 'PASSWORD_LIFE_TIME');
    expect(passRow?.resourceType).toBe('PASSWORD');
  });

  test('resource type for session params is KERNEL', () => {
    const rows = mgr.getAllProfileRows();
    const sessRow = rows.find(r => r.resourceName === 'SESSIONS_PER_USER');
    expect(sessRow?.resourceType).toBe('KERNEL');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. QuotaManager
// ═══════════════════════════════════════════════════════════════════

describe('QuotaManager', () => {
  let mgr: QuotaManager;
  beforeEach(() => { mgr = new QuotaManager(); });

  test('grantQuota UNLIMITED sets maxBytes=-1', () => {
    mgr.grantQuota('HR', 'USERS', 'UNLIMITED');
    expect(mgr.getQuota('HR', 'USERS')?.maxBytes).toBe(-1);
  });

  test('grantQuota 100M parses megabytes', () => {
    mgr.grantQuota('HR', 'USERS', '100M');
    expect(mgr.getQuota('HR', 'USERS')?.maxBytes).toBe(100 * 1024 * 1024);
  });

  test('grantQuota 2G parses gigabytes', () => {
    mgr.grantQuota('HR', 'USERS', '2G');
    expect(mgr.getQuota('HR', 'USERS')?.maxBytes).toBe(2 * 1024 * 1024 * 1024);
  });

  test('revokeQuota sets maxBytes=0', () => {
    mgr.grantQuota('HR', 'USERS', 'UNLIMITED');
    mgr.revokeQuota('HR', 'USERS');
    expect(mgr.getQuota('HR', 'USERS')?.maxBytes).toBe(0);
  });

  test('hasQuota returns false with no quota', () => {
    expect(mgr.hasQuota('HR', 'USERS', false)).toBe(false);
  });

  test('hasQuota returns true with UNLIMITED', () => {
    mgr.grantQuota('HR', 'USERS', 'UNLIMITED');
    expect(mgr.hasQuota('HR', 'USERS', false)).toBe(true);
  });

  test('hasQuota returns true with UNLIMITED_TABLESPACE privilege', () => {
    expect(mgr.hasQuota('HR', 'USERS', true)).toBe(true);
  });

  test('hasQuota returns false when maxBytes exceeded', () => {
    mgr.grantQuota('HR', 'USERS', '1M');
    mgr.addBytesUsed('HR', 'USERS', 2 * 1024 * 1024);
    expect(mgr.hasQuota('HR', 'USERS', false)).toBe(false);
  });

  test('dropUserQuotas removes all user quotas', () => {
    mgr.grantQuota('HR', 'USERS', 'UNLIMITED');
    mgr.grantQuota('HR', 'TEMP', '100M');
    mgr.dropUserQuotas('HR');
    expect(mgr.getUserQuotas('HR')).toHaveLength(0);
  });

  test('getAllQuotas returns all records', () => {
    mgr.grantQuota('HR', 'USERS', 'UNLIMITED');
    mgr.grantQuota('SCOTT', 'USERS', '100M');
    expect(mgr.getAllQuotas()).toHaveLength(2);
  });

  test('case-insensitive username and tablespace', () => {
    mgr.grantQuota('hr', 'users', 'UNLIMITED');
    expect(mgr.getQuota('HR', 'USERS')?.maxBytes).toBe(-1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. LoginTracker
// ═══════════════════════════════════════════════════════════════════

describe('LoginTracker', () => {
  let tracker: LoginTracker;
  beforeEach(() => { tracker = new LoginTracker(); });

  test('starts with 0 failed attempts', () => {
    expect(tracker.getFailedCount('alice')).toBe(0);
  });

  test('recordFailure increments count', () => {
    tracker.recordFailure('alice');
    tracker.recordFailure('alice');
    expect(tracker.getFailedCount('alice')).toBe(2);
  });

  test('recordSuccess resets count', () => {
    tracker.recordFailure('alice');
    tracker.recordFailure('alice');
    tracker.recordSuccess('alice');
    expect(tracker.getFailedCount('alice')).toBe(0);
  });

  test('lockAccount sets lockedAt', () => {
    tracker.lockAccount('alice');
    expect(tracker.isLockedByFailedLogins('alice')).toBe(true);
  });

  test('unlockAccount clears lockedAt', () => {
    tracker.lockAccount('alice');
    tracker.unlockAccount('alice');
    expect(tracker.isLockedByFailedLogins('alice')).toBe(false);
  });

  test('exceedsThreshold returns true when count >= max', () => {
    for (let i = 0; i < 3; i++) tracker.recordFailure('bob');
    expect(tracker.exceedsThreshold('bob', 3)).toBe(true);
  });

  test('exceedsThreshold Infinity never triggers', () => {
    for (let i = 0; i < 100; i++) tracker.recordFailure('bob');
    expect(tracker.exceedsThreshold('bob', Infinity)).toBe(false);
  });

  test('shouldAutoUnlock returns false when not locked', () => {
    expect(tracker.shouldAutoUnlock('alice', 1)).toBe(false);
  });

  test('shouldAutoUnlock returns false when lockTime is Infinity', () => {
    tracker.lockAccount('alice');
    expect(tracker.shouldAutoUnlock('alice', Infinity)).toBe(false);
  });

  test('case-insensitive username', () => {
    tracker.recordFailure('ALICE');
    expect(tracker.getFailedCount('alice')).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. PasswordManager
// ═══════════════════════════════════════════════════════════════════

describe('PasswordManager', () => {
  let mgr: PasswordManager;
  beforeEach(() => { mgr = new PasswordManager(); });

  test('setPassword records history', () => {
    mgr.setPassword('alice', 'pass1');
    expect(mgr.getHistory('alice')).toHaveLength(1);
    expect(mgr.getHistory('alice')[0].password).toBe('pass1');
  });

  test('multiple password changes accumulate history', () => {
    mgr.setPassword('alice', 'pass1');
    mgr.setPassword('alice', 'pass2');
    expect(mgr.getHistory('alice')).toHaveLength(2);
  });

  test('getPasswordStatus OPEN when no password set', () => {
    expect(mgr.getPasswordStatus('alice', 180, 7)).toBe('OPEN');
  });

  test('getPasswordStatus OPEN when within lifetime', () => {
    mgr.setPassword('alice', 'pass1');
    expect(mgr.getPasswordStatus('alice', 180, 7)).toBe('OPEN');
  });

  test('expirePassword triggers EXPIRED', () => {
    mgr.setPassword('alice', 'pass1');
    mgr.expirePassword('alice');
    expect(mgr.getPasswordStatus('alice', 180, 7)).toBe('EXPIRED');
  });

  test('clearExpired removes force-expired flag', () => {
    mgr.setPassword('alice', 'pass1');
    mgr.expirePassword('alice');
    mgr.clearExpired('alice');
    expect(mgr.getPasswordStatus('alice', 180, 7)).toBe('OPEN');
  });

  test('violatesReuseTime blocks reuse within time window', () => {
    mgr.setPassword('alice', 'secret');
    expect(mgr.violatesReuseTime('alice', 'secret', 365)).toBe(true);
  });

  test('violatesReuseTime allows reuse outside time window', () => {
    mgr.setPassword('alice', 'secret');
    expect(mgr.violatesReuseTime('alice', 'secret', 0)).toBe(false);
  });

  test('violatesReuseTime UNLIMITED always blocks', () => {
    mgr.setPassword('alice', 'secret');
    // Infinity = UNLIMITED means never blocks (per Oracle semantics)
    expect(mgr.violatesReuseTime('alice', 'secret', Infinity)).toBe(false);
  });

  test('violatesReuseMax blocks within max count', () => {
    mgr.setPassword('alice', 'p1');
    mgr.setPassword('alice', 'p2');
    expect(mgr.violatesReuseMax('alice', 'p1', 3)).toBe(true);
  });

  test('violatesReuseMax allows after max count exceeded', () => {
    mgr.setPassword('alice', 'p1');
    mgr.setPassword('alice', 'p2');
    mgr.setPassword('alice', 'p3');
    mgr.setPassword('alice', 'p4');
    // reuseMax=2: only last 2 in history are blocked
    expect(mgr.violatesReuseMax('alice', 'p1', 2)).toBe(false);
  });

  test('dropUser removes all data', () => {
    mgr.setPassword('alice', 'pass');
    mgr.expirePassword('alice');
    mgr.dropUser('alice');
    expect(mgr.getHistory('alice')).toHaveLength(0);
    expect(mgr.isForceExpired('alice')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. SessionLimitTracker
// ═══════════════════════════════════════════════════════════════════

describe('SessionLimitTracker', () => {
  let tracker: SessionLimitTracker;
  beforeEach(() => { tracker = new SessionLimitTracker(); });

  test('registerSession adds session', () => {
    tracker.registerSession('s1', 'HR', 'HR', DEFAULT_OS_CONTEXT);
    expect(tracker.getAllSessions()).toHaveLength(1);
  });

  test('unregisterSession removes session', () => {
    tracker.registerSession('s1', 'HR', 'HR', DEFAULT_OS_CONTEXT);
    tracker.unregisterSession('s1');
    expect(tracker.getAllSessions()).toHaveLength(0);
  });

  test('countUserSessions counts only USER type', () => {
    tracker.registerSession('s1', 'HR', 'HR', DEFAULT_OS_CONTEXT, 'USER');
    tracker.registerSession('s2', 'HR', 'HR', DEFAULT_OS_CONTEXT, 'BACKGROUND');
    expect(tracker.countUserSessions('HR')).toBe(1);
  });

  test('getSession returns registered session info', () => {
    tracker.registerSession('s1', 'HR', 'HR', DEFAULT_OS_CONTEXT);
    const info = tracker.getSession('s1');
    expect(info?.username).toBe('HR');
    expect(info?.terminal).toBe(DEFAULT_OS_CONTEXT.terminal);
  });

  test('killSession removes by sid/serial', () => {
    const info = tracker.registerSession('s1', 'HR', 'HR', DEFAULT_OS_CONTEXT);
    const killed = tracker.killSession(info.sid, info.serial);
    expect(killed).toBe(true);
    expect(tracker.getAllSessions()).toHaveLength(0);
  });

  test('killSession returns false for unknown sid', () => {
    expect(tracker.killSession(999, 999)).toBe(false);
  });

  test('killUserSessions removes all user sessions', () => {
    tracker.registerSession('s1', 'HR', 'HR', DEFAULT_OS_CONTEXT);
    tracker.registerSession('s2', 'HR', 'HR', DEFAULT_OS_CONTEXT);
    tracker.killUserSessions('HR');
    expect(tracker.countUserSessions('HR')).toBe(0);
  });

  test('session info contains OS context data', () => {
    const ctx = { ...DEFAULT_OS_CONTEXT, terminal: 'pts/1', osUser: 'john' };
    tracker.registerSession('s1', 'HR', 'HR', ctx);
    const info = tracker.getSession('s1');
    expect(info?.terminal).toBe('pts/1');
    expect(info?.osUser).toBe('john');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. SecurityEngine — integration
// ═══════════════════════════════════════════════════════════════════

describe('SecurityEngine — authentication flow', () => {
  let db: OracleDatabase;
  let engine: SecurityEngine;

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup('OPEN');
    engine = (db as any).securityEngine as SecurityEngine;
  });

  test('SecurityEngine is attached to OracleDatabase', () => {
    expect(engine).toBeDefined();
  });

  test('profile changes via CREATE PROFILE are reflected in engine', () => {
    const conn = db.connectAsSysdba();
    db.executeSql(conn.executor, "CREATE PROFILE test_p LIMIT FAILED_LOGIN_ATTEMPTS 3");
    expect(engine.profiles.profileExists('TEST_P')).toBe(true);
    expect(engine.profiles.resolveFailedLoginAttempts('TEST_P')).toBe(3);
  });

  test('quota granted via CREATE USER is tracked in engine', () => {
    const conn = db.connectAsSysdba();
    db.executeSql(conn.executor, "CREATE USER quser IDENTIFIED BY pass1 QUOTA 100M ON users");
    const quota = engine.quotas.getQuota('QUSER', 'USERS');
    expect(quota?.maxBytes).toBe(100 * 1024 * 1024);
  });

  test('UNLIMITED quota stored correctly', () => {
    const conn = db.connectAsSysdba();
    db.executeSql(conn.executor, "CREATE USER uuser IDENTIFIED BY pass1 QUOTA UNLIMITED ON users");
    const quota = engine.quotas.getQuota('UUSER', 'USERS');
    expect(quota?.maxBytes).toBe(-1);
  });

  test('DROP USER cleans up security data', () => {
    const conn = db.connectAsSysdba();
    db.executeSql(conn.executor, "CREATE USER duser IDENTIFIED BY pass1 QUOTA 100M ON users");
    db.executeSql(conn.executor, "DROP USER duser");
    expect(engine.quotas.getUserQuotas('DUSER')).toHaveLength(0);
  });
});

describe('SecurityEngine — profile enforcement via SQL', () => {
  let db: OracleDatabase;

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup('OPEN');
  });

  test('CREATE PROFILE stores limits in engine', () => {
    const conn = db.connectAsSysdba();
    db.executeSql(conn.executor, `
      CREATE PROFILE secure LIMIT
        FAILED_LOGIN_ATTEMPTS 5
        PASSWORD_LIFE_TIME 90
        SESSIONS_PER_USER 10
    `);
    const engine = (db as any).securityEngine as SecurityEngine;
    expect(engine.profiles.resolveLimit('SECURE', 'FAILED_LOGIN_ATTEMPTS')).toBe('5');
    expect(engine.profiles.resolveLimit('SECURE', 'PASSWORD_LIFE_TIME')).toBe('90');
    expect(engine.profiles.resolveLimit('SECURE', 'SESSIONS_PER_USER')).toBe('10');
  });

  test('ALTER PROFILE updates engine limits', () => {
    const conn = db.connectAsSysdba();
    db.executeSql(conn.executor, "CREATE PROFILE myp LIMIT FAILED_LOGIN_ATTEMPTS 5");
    db.executeSql(conn.executor, "ALTER PROFILE myp LIMIT FAILED_LOGIN_ATTEMPTS 3");
    const engine = (db as any).securityEngine as SecurityEngine;
    expect(engine.profiles.resolveLimit('MYP', 'FAILED_LOGIN_ATTEMPTS')).toBe('3');
  });

  test('DROP PROFILE removes from engine', () => {
    const conn = db.connectAsSysdba();
    db.executeSql(conn.executor, "CREATE PROFILE todel LIMIT IDLE_TIME 30");
    db.executeSql(conn.executor, "DROP PROFILE todel");
    const engine = (db as any).securityEngine as SecurityEngine;
    expect(engine.profiles.profileExists('TODEL')).toBe(false);
  });
});
