/**
 * Tests for Oracle Session Management — ALTER SESSION SET CURRENT_SCHEMA
 * and related session-level operations at the terminal (SQL*Plus) level.
 *
 * Scenarios covered:
 *   1. ALTER SESSION SET CURRENT_SCHEMA = <schema>
 *   2. Schema resolution after switching (SELECT, INSERT, DESC)
 *   3. Cross-schema access with explicit prefix after switching
 *   4. Error handling (non-existent schema, not connected)
 *   5. Session isolation (schema change doesn't affect other sessions)
 *   6. SHOW USER vs current_schema distinction
 *   7. Interaction with CONNECT command (resets schema)
 *   8. Case insensitivity
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import { SQLPlusSession } from '../../../database/oracle/commands/SQLPlusSession';
import { installHRSchema, installSCOTTSchema } from '../../../database/oracle/demo/DemoSchemas';

let db: OracleDatabase;
let session: SQLPlusSession;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  session = new SQLPlusSession(db);
  session.login('SYS', 'oracle', true);
});

function cmd(line: string) {
  return session.processLine(line);
}

function output(line: string): string {
  return cmd(line).output.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// 1. ALTER SESSION SET CURRENT_SCHEMA — basic
// ═══════════════════════════════════════════════════════════════════

describe('ALTER SESSION SET CURRENT_SCHEMA — basic', () => {
  test('switching to an existing schema returns "Session altered."', () => {
    installHRSchema(db);
    const result = output('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    expect(result).toContain('Session altered');
  });

  test('switching to a non-existent schema returns ORA-02248', () => {
    const result = output('ALTER SESSION SET CURRENT_SCHEMA = NONEXISTENT;');
    expect(result).toMatch(/ORA-02248/);
  });

  test('current_schema defaults to the connected user', () => {
    // SYS is the connected user, so default schema is SYS
    const result = output('SELECT SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\') FROM DUAL;');
    expect(result).toContain('SYS');
  });

  test('current_schema changes after ALTER SESSION', () => {
    installHRSchema(db);
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    const result = output('SELECT SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\') FROM DUAL;');
    expect(result).toContain('HR');
  });

  test('case insensitivity — lowercase schema name works', () => {
    installHRSchema(db);
    const result = output('alter session set current_schema = hr;');
    expect(result).toContain('Session altered');
  });

  test('schema name with quotes is accepted', () => {
    installHRSchema(db);
    const result = output("ALTER SESSION SET CURRENT_SCHEMA = \"HR\";");
    expect(result).toContain('Session altered');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. Schema resolution after switching
// ═══════════════════════════════════════════════════════════════════

describe('Schema resolution after ALTER SESSION SET CURRENT_SCHEMA', () => {
  beforeEach(() => {
    installHRSchema(db);
  });

  test('SELECT resolves unqualified table to the new schema', () => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    const result = output('SELECT COUNT(*) FROM EMPLOYEES;');
    // HR.EMPLOYEES exists and has data — count should be > 0
    expect(result).not.toContain('ORA-');
    expect(result).toMatch(/\d+/);
  });

  test('DESC resolves unqualified table to the new schema', () => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    const result = output('DESC EMPLOYEES');
    expect(result).toContain('EMPLOYEE_ID');
    expect(result).toContain('FIRST_NAME');
  });

  test('unqualified table not in new schema returns error', () => {
    // DUAL is in SYS schema, not HR
    // But DUAL is special — create a table in SYS, switch to HR, try to access it
    cmd('CREATE TABLE SYS_ONLY_TABLE (id NUMBER);');
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    const result = output('SELECT * FROM SYS_ONLY_TABLE;');
    expect(result).toMatch(/ORA-00942|does not exist|no rows/i);
  });

  test('explicit schema prefix still works after switching', () => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    // SYS.DUAL should still be accessible via explicit prefix
    const result = output('SELECT 1 FROM SYS.DUAL;');
    expect(result).not.toContain('ORA-');
  });

  test('INSERT resolves to the new schema', () => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    // Create a table in HR schema first
    cmd('CREATE TABLE HR.TEST_INSERT (id NUMBER, name VARCHAR2(50));');
    const result = output("INSERT INTO TEST_INSERT VALUES (1, 'Test');");
    expect(result).toContain('1 row');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. USER vs CURRENT_SCHEMA distinction
// ═══════════════════════════════════════════════════════════════════

describe('USER vs CURRENT_SCHEMA distinction', () => {
  beforeEach(() => {
    installHRSchema(db);
  });

  test('USER stays the same after schema switch', () => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    // USER should still be SYS (the connected user), not HR
    const result = output('SELECT USER FROM DUAL;');
    expect(result).toContain('SYS');
  });

  test('SHOW USER still shows the connected user', () => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    const result = output('SHOW USER');
    expect(result).toContain('SYS');
  });

  test('current_schema != currentUser after switch', () => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    // USER should be SYS, CURRENT_SCHEMA should be HR
    const userResult = output('SELECT USER FROM DUAL;');
    expect(userResult).toContain('SYS');

    const schemaResult = output('SELECT SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\') FROM DUAL;');
    expect(schemaResult).toContain('HR');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. Session isolation
// ═══════════════════════════════════════════════════════════════════

describe('Session isolation — schema change does not leak', () => {
  test('two sessions have independent schemas', () => {
    installHRSchema(db);

    // Session 1 switches to HR
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');

    // Session 2 should still default to its own schema
    const session2 = new SQLPlusSession(db);
    session2.login('SYS', 'oracle', true);
    const result2 = session2.processLine('SELECT SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\') FROM DUAL;');
    const output2 = result2.output.join('\n');
    expect(output2).toContain('SYS');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. Interaction with CONNECT command
// ═══════════════════════════════════════════════════════════════════

describe('CONNECT resets current_schema', () => {
  test('reconnecting as same user resets schema to user default', () => {
    installHRSchema(db);
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');

    // Reconnect as SYS
    cmd('CONN SYS/oracle AS SYSDBA');

    const result = output('SELECT SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\') FROM DUAL;');
    expect(result).toContain('SYS');
  });

  test('connecting as different user sets schema to that user', () => {
    installHRSchema(db);
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');

    // Connect as SCOTT (create SCOTT user first)
    installSCOTTSchema(db);
    cmd('CONN SCOTT/tiger');

    const result = output('SELECT SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\') FROM DUAL;');
    expect(result).toContain('SCOTT');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. Regular user switches schema
// ═══════════════════════════════════════════════════════════════════

describe('Regular user (non-SYS) switching schema', () => {
  beforeEach(() => {
    installHRSchema(db);
    installSCOTTSchema(db);
  });

  test('HR user can switch to SCOTT schema', () => {
    const hrSession = new SQLPlusSession(db);
    hrSession.login('HR', 'hr', false);
    const result = hrSession.processLine('ALTER SESSION SET CURRENT_SCHEMA = SCOTT;');
    expect(result.output.join('\n')).toContain('Session altered');
  });

  test('after switching, HR user can query SCOTT tables', () => {
    const hrSession = new SQLPlusSession(db);
    hrSession.login('HR', 'hr', false);
    hrSession.processLine('ALTER SESSION SET CURRENT_SCHEMA = SCOTT;');
    const result = hrSession.processLine('SELECT COUNT(*) FROM EMP;');
    const text = result.output.join('\n');
    // Should resolve EMP to SCOTT.EMP
    expect(text).not.toContain('ORA-00942');
  });

  test('SCOTT user can switch to HR schema and query EMPLOYEES', () => {
    const scottSession = new SQLPlusSession(db);
    scottSession.login('SCOTT', 'tiger', false);
    scottSession.processLine('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    const result = scottSession.processLine('SELECT COUNT(*) FROM EMPLOYEES;');
    const text = result.output.join('\n');
    expect(text).not.toContain('ORA-00942');
    expect(text).toMatch(/\d+/);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. Switching back to own schema
// ═══════════════════════════════════════════════════════════════════

describe('Switching back to own schema', () => {
  test('user can switch away and switch back', () => {
    installHRSchema(db);

    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    let result = output('SELECT SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\') FROM DUAL;');
    expect(result).toContain('HR');

    cmd('ALTER SESSION SET CURRENT_SCHEMA = SYS;');
    result = output('SELECT SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\') FROM DUAL;');
    expect(result).toContain('SYS');
  });

  test('multiple schema switches in succession', () => {
    installHRSchema(db);
    installSCOTTSchema(db);

    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    expect(output('SELECT SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\') FROM DUAL;')).toContain('HR');

    cmd('ALTER SESSION SET CURRENT_SCHEMA = SCOTT;');
    expect(output('SELECT SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\') FROM DUAL;')).toContain('SCOTT');

    cmd('ALTER SESSION SET CURRENT_SCHEMA = SYS;');
    expect(output('SELECT SYS_CONTEXT(\'USERENV\', \'CURRENT_SCHEMA\') FROM DUAL;')).toContain('SYS');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. ALTER SESSION — other parameters
// ═══════════════════════════════════════════════════════════════════

describe('ALTER SESSION — other parameters still work', () => {
  test('SET SERVEROUTPUT ON works alongside schema switching', () => {
    installHRSchema(db);
    const result1 = output('ALTER SESSION SET SERVEROUTPUT = ON;');
    expect(result1).toContain('Session altered');

    const result2 = output('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    expect(result2).toContain('Session altered');

    // SERVEROUTPUT should still be ON — PL/SQL blocks are entered line by line
    cmd('BEGIN');
    cmd("DBMS_OUTPUT.PUT_LINE('Hello');");
    cmd('END;');
    const plResult = cmd('/');
    expect(plResult.output.join('\n')).toContain('Hello');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. DDL in switched schema
// ═══════════════════════════════════════════════════════════════════

describe('DDL after schema switch', () => {
  beforeEach(() => {
    installHRSchema(db);
  });

  test('CREATE TABLE resolves to current_schema', () => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    cmd('CREATE TABLE SESSION_TEST (id NUMBER, val VARCHAR2(100));');

    // Table should be accessible without schema prefix
    const insertResult = output("INSERT INTO SESSION_TEST VALUES (1, 'hello');");
    expect(insertResult).toContain('1 row');

    const selectResult = output('SELECT * FROM SESSION_TEST;');
    expect(selectResult).toContain('hello');
  });

  test('DROP TABLE resolves to current_schema', () => {
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    cmd('CREATE TABLE DROP_ME (x NUMBER);');
    const dropResult = output('DROP TABLE DROP_ME;');
    expect(dropResult).toContain('Table dropped');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 10. SYS_CONTEXT function
// ═══════════════════════════════════════════════════════════════════

describe('SYS_CONTEXT reflects session state', () => {
  test('CURRENT_SCHEMA returns correct value after switch', () => {
    installHRSchema(db);
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    const result = output("SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM DUAL;");
    expect(result).toContain('HR');
  });

  test('CURRENT_USER still returns the authenticated user', () => {
    installHRSchema(db);
    cmd('ALTER SESSION SET CURRENT_SCHEMA = HR;');
    const result = output("SELECT SYS_CONTEXT('USERENV', 'CURRENT_USER') FROM DUAL;");
    expect(result).toContain('SYS');
  });
});
