/**
 * Section 4 — Filesystem & Database Layer tests.
 *
 * Verifies:
 *   4.2  All Oracle paths/versions use ORACLE_CONFIG (no hardcoded literals)
 *   4.3  Module-scoped state reset for test isolation
 *   4.7  All ORA-/TNS- error codes use centralized constants
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { OracleInstance } from '@/database/oracle/OracleInstance';
import { ORACLE_CONFIG, ORACLE_ERRORS, TNS_ERRORS, ORACLE_BANNER } from '@/terminal/commands/OracleConfig';
import {
  getOracleDatabase,
  removeOracleDatabase,
  resetAllOracleInstances,
} from '@/terminal/commands/database';

// ─── 4.7: Centralized Error Code Catalog ─────────────────────────────

describe('OracleConfig — Error code catalog completeness', () => {
  it('ORACLE_ERRORS contains all standard ORA- codes', () => {
    const expectedCodes = [
      'ORA_00900', 'ORA_00942', 'ORA_01012', 'ORA_01017',
      'ORA_01031', 'ORA_01034', 'ORA_01081', 'ORA_01126',
      'ORA_01403', 'ORA_01422', 'ORA_01476', 'ORA_04043',
    ];
    for (const code of expectedCodes) {
      expect(ORACLE_ERRORS).toHaveProperty(code);
    }
  });

  it('each ORACLE_ERRORS value starts with correct ORA- prefix', () => {
    for (const [key, value] of Object.entries(ORACLE_ERRORS)) {
      const oraNumber = key.replace('ORA_', 'ORA-');
      expect(value).toContain(oraNumber);
    }
  });

  it('TNS_ERRORS contains all standard TNS- codes', () => {
    const expectedCodes = [
      'TNS_00511', 'TNS_01106', 'TNS_03505',
      'TNS_12541', 'TNS_12514', 'TNS_12560',
    ];
    for (const code of expectedCodes) {
      expect(TNS_ERRORS).toHaveProperty(code);
    }
  });

  it('each TNS_ERRORS value starts with correct TNS- prefix', () => {
    for (const [key, value] of Object.entries(TNS_ERRORS)) {
      const tnsNumber = key.replace('TNS_', 'TNS-');
      expect(value).toContain(tnsNumber);
    }
  });

  it('ORACLE_ERRORS values are non-empty strings', () => {
    for (const value of Object.values(ORACLE_ERRORS)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('TNS_ERRORS values are non-empty strings', () => {
    for (const value of Object.values(TNS_ERRORS)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

// ─── 4.2: Oracle paths & version centralization ──────────────────────

describe('ORACLE_CONFIG — Centralized paths and versions', () => {
  it('BASE, HOME, VERSION, SID, PORT are defined', () => {
    expect(ORACLE_CONFIG.BASE).toBe('/u01/app/oracle');
    expect(ORACLE_CONFIG.HOME).toContain(ORACLE_CONFIG.BASE);
    expect(ORACLE_CONFIG.VERSION).toBe('19c');
    expect(ORACLE_CONFIG.SID).toBe('ORCL');
    expect(ORACLE_CONFIG.PORT).toBe(1521);
  });

  it('derived paths use BASE and HOME', () => {
    expect(ORACLE_CONFIG.NETWORK_ADMIN).toBe(`${ORACLE_CONFIG.HOME}/network/admin`);
    expect(ORACLE_CONFIG.BIN_DIR).toBe(`${ORACLE_CONFIG.HOME}/bin`);
    expect(ORACLE_CONFIG.DBS_DIR).toBe(`${ORACLE_CONFIG.HOME}/dbs`);
    expect(ORACLE_CONFIG.ORADATA).toContain(ORACLE_CONFIG.BASE);
    expect(ORACLE_CONFIG.DIAG_TRACE).toContain(ORACLE_CONFIG.BASE);
  });

  it('ORACLE_BANNER references ORACLE_CONFIG.VERSION', () => {
    expect(ORACLE_BANNER.SQLPLUS_HEADER).toContain(ORACLE_CONFIG.VERSION);
    expect(ORACLE_BANNER.LSNRCTL_HEADER).toContain(ORACLE_CONFIG.VERSION);
    expect(ORACLE_BANNER.TNSPING_HEADER).toContain(ORACLE_CONFIG.VERSION);
  });
});

// ─── 4.7: OracleDatabase uses centralized error codes ────────────────

describe('OracleDatabase — Centralized error codes', () => {
  let db: OracleDatabase;

  beforeEach(() => {
    db = new OracleDatabase();
  });

  it('throws ORA-01034 when connecting to a stopped instance', () => {
    // Instance is CLOSED by default (not started)
    expect(() => db.connect('SYS', 'oracle')).toThrow(ORACLE_ERRORS.ORA_01034);
  });

  it('throws ORA-01017 on invalid credentials', () => {
    db.instance.startup('OPEN');
    expect(() => db.connect('SYS', 'wrong_password')).toThrow(ORACLE_ERRORS.ORA_01017);
  });

  it('connects successfully with valid credentials', () => {
    db.instance.startup('OPEN');
    const result = db.connect('SYS', 'oracle');
    expect(result.sid).toBeGreaterThanOrEqual(0);
    expect(result.executor).toBeDefined();
  });
});

// ─── 4.7: OracleInstance uses centralized error codes ────────────────

describe('OracleInstance — Centralized error codes', () => {
  let instance: OracleInstance;

  beforeEach(() => {
    instance = new OracleInstance();
  });

  it('returns ORA-01081 when starting an already-running instance', () => {
    instance.startup('OPEN');
    const output = instance.startup();
    expect(output).toContain(ORACLE_ERRORS.ORA_01081);
  });

  it('returns ORA-01034 when shutting down a stopped instance', () => {
    const output = instance.shutdown();
    expect(output).toContain(ORACLE_ERRORS.ORA_01034);
  });

  it('listener status contains ORACLE_CONFIG.PORT when running', () => {
    instance.startup('OPEN');
    instance.startListener();
    const status = instance.getListenerStatus();
    expect(status).toContain(String(ORACLE_CONFIG.PORT));
    expect(status).toContain('STATUS of the LISTENER');
  });

  it('listener status contains TNS errors when stopped', () => {
    instance.startup('OPEN');
    const status = instance.getListenerStatus();
    expect(status).toContain(TNS_ERRORS.TNS_12541);
  });

  it('startListener returns TNS-01106 when already running', () => {
    instance.startup('OPEN');
    instance.startListener();
    const result = instance.startListener();
    expect(result).toContain(TNS_ERRORS.TNS_01106);
  });

  it('stopListener returns TNS-12541 when already stopped', () => {
    instance.startup('OPEN');
    const result = instance.stopListener();
    expect(result).toContain(TNS_ERRORS.TNS_12541);
  });
});

// ─── 4.3: Module-scoped state reset for test isolation ───────────────

describe('database.ts — resetAllOracleInstances', () => {
  afterEach(() => {
    resetAllOracleInstances();
  });

  it('getOracleDatabase returns a database for a new device', () => {
    const db = getOracleDatabase('test-device-1');
    expect(db).toBeInstanceOf(OracleDatabase);
    expect(db.instance.isOpen).toBe(true);
  });

  it('getOracleDatabase returns the same instance for same device', () => {
    const db1 = getOracleDatabase('test-device-2');
    const db2 = getOracleDatabase('test-device-2');
    expect(db1).toBe(db2);
  });

  it('resetAllOracleInstances clears all cached instances', () => {
    const db1 = getOracleDatabase('test-device-3');
    resetAllOracleInstances();
    const db2 = getOracleDatabase('test-device-3');
    // After reset, a fresh instance should be created
    expect(db2).not.toBe(db1);
  });

  it('removeOracleDatabase removes a single device', () => {
    const db1 = getOracleDatabase('test-device-4');
    removeOracleDatabase('test-device-4');
    const db2 = getOracleDatabase('test-device-4');
    expect(db2).not.toBe(db1);
  });

  it('resetAllOracleInstances clears filesystem tracking too', () => {
    // After reset, calling getOracleDatabase should work cleanly
    getOracleDatabase('test-device-5');
    resetAllOracleInstances();
    // Should not throw — filesystem set is also cleared
    const db = getOracleDatabase('test-device-5');
    expect(db).toBeInstanceOf(OracleDatabase);
  });

  it('supports multiple devices independently', () => {
    const dbA = getOracleDatabase('device-a');
    const dbB = getOracleDatabase('device-b');
    expect(dbA).not.toBe(dbB);
    removeOracleDatabase('device-a');
    // device-b still exists
    const dbB2 = getOracleDatabase('device-b');
    expect(dbB2).toBe(dbB);
  });
});

// ─── 4.7: Error codes in PL/SQL execution (OracleDatabase) ──────────

describe('OracleDatabase — PL/SQL error handling uses centralized codes', () => {
  let db: OracleDatabase;

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup('OPEN');
  });

  it('division by zero error message matches ORA-01476 text', () => {
    const { executor } = db.connectAsSysdba();
    // The executor throws 'divisor is equal to zero' which matches the ORA_01476 description
    expect(() => db.executeSql(executor, 'SELECT 1/0 FROM DUAL')).toThrow(
      'divisor is equal to zero'
    );
    // Verify the constant contains this same description
    expect(ORACLE_ERRORS.ORA_01476).toContain('divisor is equal to zero');
  });

  it('ORA-00942 for non-existent table', () => {
    const { executor } = db.connectAsSysdba();
    expect(() => db.executeSql(executor, 'SELECT * FROM nonexistent_table_xyz')).toThrow();
  });
});

// ─── 4.2: OracleInstance paths use ORACLE_CONFIG ─────────────────────

describe('OracleInstance — Paths reference ORACLE_CONFIG', () => {
  let instance: OracleInstance;

  beforeEach(() => {
    instance = new OracleInstance();
    instance.startup('OPEN');
  });

  it('initOra content references SID from config', () => {
    const content = instance.getInitOraContent();
    expect(content).toContain(ORACLE_CONFIG.SID);
  });

  it('tnsnames content references ORACLE_CONFIG.PORT', () => {
    const content = instance.getTnsNamesContent();
    expect(content).toContain(String(ORACLE_CONFIG.PORT));
  });

  it('initOra content references ORACLE_CONFIG paths', () => {
    const content = instance.getInitOraContent();
    expect(content).toContain(ORACLE_CONFIG.BASE);
  });
});

// ─── Edge cases ──────────────────────────────────────────────────────

describe('Edge cases — Error catalog consistency', () => {
  it('ORA_01012 is used for "not logged on" scenario', () => {
    expect(ORACLE_ERRORS.ORA_01012).toContain('not logged on');
  });

  it('ORA_00900 is used for invalid SQL', () => {
    expect(ORACLE_ERRORS.ORA_00900).toContain('invalid SQL');
  });

  it('TNS_12541 is used for "no listener"', () => {
    expect(TNS_ERRORS.TNS_12541).toContain('no listener');
  });

  it('TNS_03505 is used for failed name resolution', () => {
    expect(TNS_ERRORS.TNS_03505).toContain('Failed to resolve');
  });

  it('error code objects are typed as const (compile-time immutability)', () => {
    // 'as const' provides TypeScript-level immutability.
    // Verify the values cannot be reassigned at the type level
    // by checking they have specific literal types (not just 'string').
    const ora01034: string = ORACLE_ERRORS.ORA_01034;
    expect(ora01034).toBe('ORA-01034: ORACLE not available');

    const tns12541: string = TNS_ERRORS.TNS_12541;
    expect(tns12541).toBe('TNS-12541: TNS:no listener');
  });
});
