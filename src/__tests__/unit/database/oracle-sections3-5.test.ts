/**
 * Tests for BRD Sections 3 and 5 — SQL*Plus commands, OS commands,
 * V$ views, DBA_ views, and SYS internal tables.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import { SQLPlusSession } from '../../../database/oracle/commands/SQLPlusSession';

let db: OracleDatabase;
let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];
let session: SQLPlusSession;

function exec(sql: string) {
  return db.executeSql(executor, sql);
}

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  const conn = db.connectAsSysdba();
  executor = conn.executor;
  session = new SQLPlusSession(db);
  session.login('SYS', 'oracle', true);
});

// ── Section 3.1 — SQL*Plus Commands ──────────────────────────────

describe('SQL*Plus Commands', () => {

  describe('DEFINE — substitution variables', () => {
    test('DEFINE var = value stores and retrieves variable', () => {
      const setResult = session.processLine("DEFINE myvar = 'hello'");
      expect(setResult.output).toEqual([]);

      const getResult = session.processLine('DEFINE myvar');
      expect(getResult.output[0]).toContain('MYVAR');
      expect(getResult.output[0]).toContain('hello');
    });

    test('DEFINE without args lists all defines', () => {
      session.processLine("DEFINE x = 42");
      const result = session.processLine('DEFINE');
      expect(result.output.length).toBeGreaterThan(0);
      expect(result.output.some(l => l.includes('X'))).toBe(true);
    });

    test('DEFINE undefined variable returns SP2-0135 error', () => {
      const result = session.processLine('DEFINE nonexistent');
      expect(result.output[0]).toContain('SP2-0135');
    });
  });

  describe('VARIABLE / PRINT — bind variables', () => {
    test('VARIABLE declares a bind variable', () => {
      const result = session.processLine('VARIABLE mynum NUMBER');
      expect(result.output).toEqual([]);
    });

    test('PRINT undeclared variable returns SP2-0552', () => {
      const result = session.processLine('PRINT undeclared');
      expect(result.output[0]).toContain('SP2-0552');
    });

    test('PRINT declared variable shows its value', () => {
      session.processLine('VARIABLE myvar VARCHAR2(100)');
      const result = session.processLine('PRINT myvar');
      expect(result.output.some(l => l.includes('MYVAR'))).toBe(true);
    });

    test('VARIABLE with no args lists all bind variables', () => {
      session.processLine('VARIABLE a NUMBER');
      session.processLine('VARIABLE b VARCHAR2(50)');
      const result = session.processLine('VARIABLE');
      expect(result.output.length).toBeGreaterThan(0);
    });

    test('VAR abbreviation works', () => {
      const result = session.processLine('VAR x NUMBER');
      expect(result.output).toEqual([]);
    });
  });

  describe('COLUMN FORMAT', () => {
    test('COLUMN col FORMAT A30 stores format', () => {
      const result = session.processLine("COLUMN ename FORMAT A30");
      expect(result.output).toEqual([]);

      const list = session.processLine('COLUMN');
      expect(list.output.some(l => l.includes('ENAME') && l.includes('A30'))).toBe(true);
    });

    test('COLUMN col CLEAR removes format', () => {
      session.processLine("COLUMN ename FORMAT A20");
      session.processLine("COLUMN ename CLEAR");
      const list = session.processLine('COLUMN');
      expect(list.output.some(l => l.includes('ENAME'))).toBe(false);
    });

    test('COLUMN col HEADING sets heading', () => {
      session.processLine("COLUMN ename HEADING 'Employee Name'");
      const list = session.processLine('COLUMN');
      expect(list.output.some(l => l.includes('Employee Name'))).toBe(true);
    });
  });

  describe('@ / START — script execution', () => {
    test('@ returns SP2-0310 unable to open file', () => {
      const result = session.processLine('@myscript.sql');
      expect(result.output[0]).toContain('SP2-0310');
      expect(result.output[0]).toContain('myscript.sql');
    });

    test('START returns SP2-0310 unable to open file', () => {
      const result = session.processLine('START setup.sql');
      expect(result.output[0]).toContain('SP2-0310');
      expect(result.output[0]).toContain('setup.sql');
    });
  });

  describe('PROMPT — display text', () => {
    test('PROMPT text displays the text', () => {
      const result = session.processLine('PROMPT Hello World');
      expect(result.output).toEqual(['Hello World']);
    });

    test('PROMPT with no text displays empty line', () => {
      const result = session.processLine('PROMPT');
      expect(result.output).toEqual(['']);
    });
  });

  describe('/ — re-execute last statement', () => {
    test('/ re-executes the last SQL statement', () => {
      exec(`CREATE TABLE test_slash (id NUMBER)`);
      exec(`INSERT INTO test_slash VALUES (1)`);
      session.processLine('SELECT * FROM test_slash;');
      const result = session.processLine('/');
      expect(result.output.some(l => l.includes('1'))).toBe(true);
    });

    test('/ with no previous statement returns SP2-0103', () => {
      const freshSession = new SQLPlusSession(db);
      freshSession.login('SYS', 'oracle', true);
      const result = freshSession.processLine('/');
      expect(result.output[0]).toContain('SP2-0103');
    });
  });

  describe('SPOOL', () => {
    test('SPOOL filename and SPOOL OFF work without error', () => {
      const result1 = session.processLine('SPOOL output.log');
      expect(result1.output).toEqual([]);
      const result2 = session.processLine('SPOOL OFF');
      expect(result2.output).toEqual([]);
    });
  });

  describe('HOST — shell command', () => {
    test('HOST returns not available message', () => {
      const result = session.processLine('HOST ls');
      expect(result.output[0]).toContain('SP2-0734');
    });

    test('! shortcut returns not available message', () => {
      const result = session.processLine('!ls');
      expect(result.output[0]).toContain('SP2-0734');
    });
  });

  describe('EDIT', () => {
    test('EDIT returns SP2-0107', () => {
      const result = session.processLine('EDIT');
      expect(result.output[0]).toContain('SP2-0107');
    });
  });
});

// ── Section 5.1 — V$ Dynamic Performance Views ──────────────────

describe('V$ Dynamic Performance Views', () => {

  test('V$ASM_DISKGROUP returns disk group data', () => {
    const result = exec('SELECT * FROM V$ASM_DISKGROUP');
    expect(result.isQuery).toBe(true);
    expect(result.columns.some(c => c.name === 'NAME')).toBe(true);
    expect(result.columns.some(c => c.name === 'TOTAL_MB')).toBe(true);
    expect(result.rows.length).toBe(2);
    expect(result.rows[0][1]).toBe('DATA');
    expect(result.rows[1][1]).toBe('FRA');
  });

  test('V$DIAG_INFO returns diagnostic info', () => {
    const result = exec('SELECT * FROM V$DIAG_INFO');
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.some(r => String(r[0]).includes('ADR'))).toBe(true);
  });
});

// ── Section 5.2 — DBA_ Dictionary Views ─────────────────────────

describe('DBA_ Dictionary Views', () => {

  test('DBA_SYNONYMS returns synonym data', () => {
    const result = exec('SELECT * FROM DBA_SYNONYMS');
    expect(result.isQuery).toBe(true);
    expect(result.columns.some(c => c.name === 'SYNONYM_NAME')).toBe(true);
    expect(result.columns.some(c => c.name === 'TABLE_OWNER')).toBe(true);
  });

  test('DBA_SYNONYMS reflects created synonyms', () => {
    // Create a synonym via storage
    db.storage.createSynonym({
      owner: 'SYS',
      name: 'EMP',
      tableOwner: 'HR',
      tableName: 'EMPLOYEES',
      isPublic: true,
    });
    const result = exec('SELECT * FROM DBA_SYNONYMS');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][1]).toBe('EMP');
    expect(result.rows[0][3]).toBe('EMPLOYEES');
  });

  test('ALL_SYNONYMS works (delegates to DBA_SYNONYMS)', () => {
    const result = exec('SELECT * FROM ALL_SYNONYMS');
    expect(result.isQuery).toBe(true);
    expect(result.columns.some(c => c.name === 'SYNONYM_NAME')).toBe(true);
  });
});

// ── Section 5.3 — SYS Internal Tables ───────────────────────────

describe('SYS Internal Tables', () => {

  beforeEach(() => {
    exec(`CREATE TABLE hr_test (id NUMBER, name VARCHAR2(50))`);
    exec(`CREATE INDEX idx_hr_test ON hr_test (id)`);
  });

  test('SYS.OBJ$ returns objects with tables and indexes', () => {
    const result = exec('SELECT * FROM SYS.OBJ$');
    expect(result.isQuery).toBe(true);
    expect(result.columns.some(c => c.name === 'NAME')).toBe(true);
    expect(result.columns.some(c => c.name === 'TYPE#')).toBe(true);
    expect(result.rows.some(r => r[2] === 'HR_TEST')).toBe(true);
    expect(result.rows.some(r => r[2] === 'IDX_HR_TEST')).toBe(true);
  });

  test('SYS.TAB$ returns table metadata', () => {
    const result = exec('SELECT * FROM SYS.TAB$');
    expect(result.isQuery).toBe(true);
    expect(result.columns.some(c => c.name === 'COLS')).toBe(true);
    // HR_TEST has 2 columns
    expect(result.rows.some(r => r[2] === 2)).toBe(true);
  });

  test('SYS.COL$ returns column metadata', () => {
    const result = exec('SELECT * FROM SYS.COL$');
    expect(result.isQuery).toBe(true);
    expect(result.columns.some(c => c.name === 'NAME')).toBe(true);
    expect(result.rows.some(r => r[1] === 'ID')).toBe(true);
    expect(result.rows.some(r => r[1] === 'NAME')).toBe(true);
  });

  test('SYS.IND$ returns index metadata', () => {
    const result = exec('SELECT * FROM SYS.IND$');
    expect(result.isQuery).toBe(true);
    expect(result.columns.some(c => c.name === 'UNIQUENESS')).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  test('SYS.USER$ returns user metadata', () => {
    const result = exec('SELECT * FROM SYS.USER$');
    expect(result.isQuery).toBe(true);
    expect(result.columns.some(c => c.name === 'NAME')).toBe(true);
    expect(result.rows.some(r => r[1] === 'SYS')).toBe(true);
    expect(result.rows.some(r => r[1] === 'HR')).toBe(true);
  });

  test('SYS.TS$ returns tablespace metadata', () => {
    const result = exec('SELECT * FROM SYS.TS$');
    expect(result.isQuery).toBe(true);
    expect(result.columns.some(c => c.name === 'NAME')).toBe(true);
    expect(result.rows.some(r => r[1] === 'SYSTEM')).toBe(true);
  });

  test('SYS.AUD$ returns audit data with expected columns', () => {
    const result = exec('SELECT * FROM SYS.AUD$');
    expect(result.isQuery).toBe(true);
    expect(result.columns.some(c => c.name === 'USERID')).toBe(true);
    expect(result.columns.some(c => c.name === 'SESSIONID')).toBe(true);
    expect(result.columns.some(c => c.name === 'ACTION#')).toBe(true);
  });
});

// ── TAB / CAT ────────────────────────────────────────────────────

describe('TAB / CAT', () => {
  test('TAB returns current user tables', () => {
    exec(`CREATE TABLE my_table (id NUMBER)`);
    const result = exec('SELECT * FROM TAB');
    expect(result.isQuery).toBe(true);
    expect(result.columns.some(c => c.name === 'TNAME')).toBe(true);
    expect(result.rows.some(r => r[0] === 'MY_TABLE')).toBe(true);
  });
});
