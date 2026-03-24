/**
 * Tests for BRD Section 3.1 — SQL*Plus Commands.
 *
 * Covers every command listed in section 3.1 of BRD-Oracle-DBMS.md,
 * tested at the SQLPlusSession (terminal) level via processLine().
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import { SQLPlusSession } from '../../../database/oracle/commands/SQLPlusSession';

let db: OracleDatabase;
let session: SQLPlusSession;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  session = new SQLPlusSession(db);
  session.login('SYS', 'oracle', true);
});

/** Helper: process a line and return the result */
function cmd(line: string) {
  return session.processLine(line);
}

/** Helper: get joined output text */
function output(line: string): string {
  return cmd(line).output.join('\n');
}

// ═══════════════════════════════════════════════════════════════════
// 1. CONNECTION COMMANDS
// ═══════════════════════════════════════════════════════════════════

describe('sqlplus / as sysdba — SYSDBA login', () => {
  test('session starts connected as SYS via login()', () => {
    expect(session.isConnected()).toBe(true);
    expect(session.getCurrentUser()).toBe('SYS');
    expect(session.isSysdba()).toBe(true);
  });

  test('getBanner() returns SQL*Plus banner', () => {
    const banner = session.getBanner();
    expect(banner.some(l => l.includes('SQL*Plus'))).toBe(true);
    expect(banner.some(l => l.includes('19.0.0.0.0'))).toBe(true);
    expect(banner.some(l => l.includes('Oracle'))).toBe(true);
  });
});

describe('sqlplus user/password — standard connection', () => {
  test('login as regular user', () => {
    // Create a test user and grant privileges via the engine
    const { executor: sysExec } = db.connectAsSysdba();
    db.executeSql(sysExec, "CREATE USER TESTLOGIN IDENTIFIED BY test123");
    db.executeSql(sysExec, "GRANT CREATE SESSION TO TESTLOGIN");

    const freshSession = new SQLPlusSession(db);
    const loginOutput = freshSession.login('TESTLOGIN', 'test123', false);
    expect(loginOutput).toContain('Connected.');
    expect(freshSession.isConnected()).toBe(true);
    expect(freshSession.getCurrentUser()).toBe('TESTLOGIN');
    expect(freshSession.isSysdba()).toBe(false);
  });

  test('login with wrong password fails', () => {
    const { executor: sysExec } = db.connectAsSysdba();
    db.executeSql(sysExec, "CREATE USER TESTUSER IDENTIFIED BY secret");
    const freshSession = new SQLPlusSession(db);
    const loginOutput = freshSession.login('TESTUSER', 'wrongpass', false);
    expect(loginOutput.some(l => l.includes('ORA-01017'))).toBe(true);
    expect(freshSession.isConnected()).toBe(false);
  });
});

describe('sqlplus user/password@tns_alias — TNS connection', () => {
  test('CONNECT user/pass@ORCL strips TNS alias and connects', () => {
    cmd('CREATE USER TNSUSER IDENTIFIED BY tns123;');
    cmd('GRANT CREATE SESSION TO TNSUSER;');

    const result = cmd('CONNECT TNSUSER/tns123@ORCL');
    expect(result.output).toContain('Connected.');
    expect(session.getCurrentUser()).toBe('TNSUSER');
  });
});

describe('CONNECT user/password — session change', () => {
  test('CONNECT / AS SYSDBA reconnects as SYS', () => {
    const result = cmd('CONNECT / AS SYSDBA');
    expect(result.output).toContain('Connected.');
    expect(session.getCurrentUser()).toBe('SYS');
    expect(session.isSysdba()).toBe(true);
  });

  test('CONN is alias for CONNECT', () => {
    const result = cmd('CONN / AS SYSDBA');
    expect(result.output).toContain('Connected.');
  });

  test('CONNECT without password returns error', () => {
    const result = cmd('CONNECT someuser');
    expect(result.output.some(l => l.includes('SP2-0306'))).toBe(true);
  });
});

describe('DISCONNECT', () => {
  test('DISCONNECT disconnects the session', () => {
    expect(session.isConnected()).toBe(true);
    const result = cmd('DISCONNECT');
    expect(result.exit).toBe(false); // DISCONNECT does not exit SQL*Plus
    expect(result.output.some(l => l.includes('Disconnected'))).toBe(true);
    expect(session.isConnected()).toBe(false);
  });

  test('DISC is alias for DISCONNECT', () => {
    const result = cmd('DISC');
    expect(result.output.some(l => l.includes('Disconnected'))).toBe(true);
    expect(session.isConnected()).toBe(false);
  });

  test('DISCONNECT when not connected returns message', () => {
    cmd('DISCONNECT');
    const result = cmd('DISCONNECT');
    expect(result.output.some(l => l.includes('Not connected'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 2. SET COMMANDS
// ═══════════════════════════════════════════════════════════════════

describe('SET LINESIZE n', () => {
  test('SET LINESIZE 200 changes linesize', () => {
    cmd('SET LINESIZE 200');
    const show = output('SHOW LINESIZE');
    expect(show).toContain('200');
  });

  test('SET LIN 120 uses abbreviation', () => {
    cmd('SET LIN 120');
    expect(output('SHOW LIN')).toContain('120');
  });
});

describe('SET PAGESIZE n', () => {
  test('SET PAGESIZE 50 changes pagesize', () => {
    cmd('SET PAGESIZE 50');
    expect(output('SHOW PAGESIZE')).toContain('50');
  });

  test('SET PAGES 25 changes pagesize', () => {
    cmd('SET PAGES 25');
    expect(output('SHOW PAGES')).toContain('25');
  });
});

describe('SET SERVEROUTPUT ON/OFF', () => {
  test('SET SERVEROUTPUT ON enables server output', () => {
    cmd('SET SERVEROUTPUT ON');
    expect(output('SHOW SERVEROUTPUT')).toContain('ON');
  });

  test('SET SERVEROUTPUT OFF disables server output', () => {
    cmd('SET SERVEROUTPUT ON');
    cmd('SET SERVEROUTPUT OFF');
    expect(output('SHOW SERVEROUTPUT')).toContain('OFF');
  });

  test('SET SERVEROUT ON uses abbreviation', () => {
    cmd('SET SERVEROUT ON');
    expect(output('SHOW SERVEROUT')).toContain('ON');
  });
});

describe('SET TIMING ON/OFF', () => {
  test('SET TIMING ON enables timing', () => {
    cmd('SET TIMING ON');
    expect(output('SHOW TIMING')).toContain('ON');
  });

  test('SET TIMING OFF disables timing', () => {
    cmd('SET TIMING ON');
    cmd('SET TIMING OFF');
    expect(output('SHOW TIMING')).toContain('OFF');
  });

  test('with timing ON, SQL output includes Elapsed', () => {
    cmd('SET TIMING ON');
    const result = cmd('SELECT 1 FROM DUAL;');
    expect(result.output.some(l => l.includes('Elapsed'))).toBe(true);
  });
});

describe('SET FEEDBACK ON/OFF', () => {
  test('SET FEEDBACK OFF disables row count feedback', () => {
    cmd('SET FEEDBACK OFF');
    const result = cmd('SELECT 1 FROM DUAL;');
    expect(result.output.every(l => !l.includes('row selected'))).toBe(true);
  });

  test('SET FEEDBACK ON enables row count feedback', () => {
    cmd('SET FEEDBACK ON');
    const result = cmd('SELECT 1 FROM DUAL;');
    expect(result.output.some(l => l.includes('1 row selected'))).toBe(true);
  });

  test('SET FEED OFF uses abbreviation', () => {
    cmd('SET FEED OFF');
    expect(output('SHOW FEED')).toContain('0');
  });
});

describe('SET ECHO ON/OFF', () => {
  test('SET ECHO ON enables echo', () => {
    cmd('SET ECHO ON');
    const show = output('SHOW ALL');
    expect(show).toContain('echo ON');
  });

  test('SET ECHO OFF disables echo', () => {
    cmd('SET ECHO OFF');
    const show = output('SHOW ALL');
    expect(show).toContain('echo OFF');
  });
});

describe('SET AUTOCOMMIT ON/OFF', () => {
  test('SET AUTOCOMMIT ON enables autocommit', () => {
    cmd('SET AUTOCOMMIT ON');
    expect(output('SHOW AUTOCOMMIT')).toContain('ON');
  });

  test('SET AUTO OFF uses abbreviation', () => {
    cmd('SET AUTO OFF');
    expect(output('SHOW AUTO')).toContain('OFF');
  });
});

describe('SET — unknown option', () => {
  test('SET UNKNOWN_OPT returns SP2-0158 error', () => {
    const result = cmd('SET FOOBAR 123');
    expect(result.output.some(l => l.includes('SP2-0158'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 3. SHOW COMMANDS
// ═══════════════════════════════════════════════════════════════════

describe('SHOW USER', () => {
  test('displays current user', () => {
    const out = output('SHOW USER');
    expect(out).toContain('USER is "SYS"');
  });
});

describe('SHOW PARAMETER', () => {
  test('SHOW PARAMETER lists all parameters with header', () => {
    const out = output('SHOW PARAMETER');
    expect(out).toContain('NAME');
    expect(out).toContain('TYPE');
    expect(out).toContain('VALUE');
    expect(out).toContain('db_name');
  });

  test('SHOW PARAMETER db_name filters by name', () => {
    const result = cmd('SHOW PARAMETER db_name');
    const lines = result.output.filter(l => l.includes('db_name'));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some(l => l.includes('ORCL'))).toBe(true);
  });

  test('SHOW PARAMETER sga shows matching parameters', () => {
    const result = cmd('SHOW PARAMETER sga');
    const lines = result.output.filter(l => l.includes('sga'));
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe('SHOW SGA', () => {
  test('displays SGA information', () => {
    const out = output('SHOW SGA');
    expect(out).toContain('Total System Global Area');
    expect(out).toContain('Fixed Size');
    expect(out).toContain('Variable Size');
    expect(out).toContain('Database Buffers');
    expect(out).toContain('Redo Buffers');
  });
});

describe('SHOW ERRORS', () => {
  test('displays "No errors." when no PL/SQL errors', () => {
    expect(output('SHOW ERRORS')).toContain('No errors.');
  });
});

describe('SHOW ALL', () => {
  test('displays all SQL*Plus settings', () => {
    const out = output('SHOW ALL');
    expect(out).toContain('autocommit');
    expect(out).toContain('feedback');
    expect(out).toContain('linesize');
    expect(out).toContain('pagesize');
    expect(out).toContain('serveroutput');
    expect(out).toContain('timing');
    expect(out).toContain('heading');
    expect(out).toContain('verify');
    expect(out).toContain('wrap');
  });
});

describe('SHOW — unknown option', () => {
  test('SHOW FOOBAR returns SP2-0158 error', () => {
    const result = cmd('SHOW FOOBAR');
    expect(result.output.some(l => l.includes('SP2-0158'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. DESC / DESCRIBE
// ═══════════════════════════════════════════════════════════════════

describe('DESC table_name / DESCRIBE table_name', () => {
  beforeEach(() => {
    cmd('CREATE TABLE TEST_DESC (ID NUMBER(10) NOT NULL, NAME VARCHAR2(50), SALARY NUMBER(8,2));');
  });

  test('DESC shows column names, nullable, and types', () => {
    const result = cmd('DESC TEST_DESC');
    const out = result.output.join('\n');
    expect(out).toContain('Name');
    expect(out).toContain('Null?');
    expect(out).toContain('Type');
    expect(out).toContain('ID');
    expect(out).toContain('NOT NULL');
    expect(out).toContain('NUMBER');
    expect(out).toContain('NAME');
    expect(out).toContain('VARCHAR2');
  });

  test('DESCRIBE is alias for DESC', () => {
    const result = cmd('DESCRIBE TEST_DESC');
    const out = result.output.join('\n');
    expect(out).toContain('ID');
    expect(out).toContain('NAME');
    expect(out).toContain('SALARY');
  });

  test('DESC nonexistent table returns ORA-04043', () => {
    const result = cmd('DESC NONEXISTENT_TABLE');
    expect(result.output.some(l => l.includes('ORA-04043'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5. SCRIPT EXECUTION: @ and START
// ═══════════════════════════════════════════════════════════════════

describe('@script.sql — execute script (stub)', () => {
  test('@script.sql returns SP2-0310 unable to open file', () => {
    const result = cmd('@myscript.sql');
    expect(result.output.some(l => l.includes('SP2-0310'))).toBe(true);
    expect(result.output.some(l => l.includes('myscript.sql'))).toBe(true);
  });

  test('START script.sql returns SP2-0310', () => {
    const result = cmd('START myscript.sql');
    expect(result.output.some(l => l.includes('SP2-0310'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 6. SPOOL
// ═══════════════════════════════════════════════════════════════════

describe('SPOOL filename / SPOOL OFF', () => {
  test('SPOOL output.txt starts spooling (no error)', () => {
    const result = cmd('SPOOL output.txt');
    expect(result.output.length).toBe(0);
    expect(result.exit).toBe(false);
  });

  test('SPOOL OFF stops spooling (no error)', () => {
    cmd('SPOOL output.txt');
    const result = cmd('SPOOL OFF');
    expect(result.output.length).toBe(0);
    expect(result.exit).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. EXIT / QUIT
// ═══════════════════════════════════════════════════════════════════

describe('EXIT / QUIT', () => {
  test('EXIT disconnects and sets exit flag', () => {
    const result = cmd('EXIT');
    expect(result.exit).toBe(true);
    expect(result.output.some(l => l.includes('Disconnected'))).toBe(true);
    expect(session.isConnected()).toBe(false);
  });

  test('QUIT behaves like EXIT', () => {
    const result = cmd('QUIT');
    expect(result.exit).toBe(true);
    expect(result.output.some(l => l.includes('Disconnected'))).toBe(true);
  });

  test('EXIT with extra text still exits', () => {
    const result = cmd('EXIT COMMIT');
    expect(result.exit).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. CLEAR SCREEN
// ═══════════════════════════════════════════════════════════════════

describe('CLEAR SCREEN', () => {
  test('CLEAR SCREEN returns empty output (no error)', () => {
    const result = cmd('CLEAR SCREEN');
    expect(result.output.length).toBe(0);
    expect(result.exit).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. COLUMN FORMAT
// ═══════════════════════════════════════════════════════════════════

describe('COLUMN col FORMAT fmt', () => {
  test('COLUMN ENAME FORMAT A30 sets format', () => {
    const result = cmd('COLUMN ENAME FORMAT A30');
    expect(result.output.length).toBe(0); // silent success

    // Verify by listing all column formats
    const listResult = cmd('COLUMN');
    const out = listResult.output.join('\n');
    expect(out).toContain('ENAME');
    expect(out).toContain('A30');
  });

  test('COLUMN with HEADING sets custom heading', () => {
    cmd("COLUMN SAL FORMAT 9999 HEADING 'Salary'");
    const listResult = cmd('COLUMN');
    const out = listResult.output.join('\n');
    expect(out).toContain('SAL');
    expect(out).toContain('Salary');
  });

  test('COL is alias for COLUMN', () => {
    const result = cmd('COL DEPTNO FORMAT 999');
    expect(result.output.length).toBe(0);
  });

  test('COLUMN col CLEAR removes format', () => {
    cmd('COLUMN ENAME FORMAT A30');
    cmd('COLUMN ENAME CLEAR');
    const listResult = cmd('COLUMN');
    const out = listResult.output.join('\n');
    expect(out).not.toContain('ENAME');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 10. PROMPT
// ═══════════════════════════════════════════════════════════════════

describe('PROMPT text', () => {
  test('PROMPT displays text', () => {
    const result = cmd('PROMPT Hello World');
    expect(result.output).toContain('Hello World');
  });

  test('PROMPT with no text displays empty line', () => {
    const result = cmd('PROMPT');
    expect(result.output).toContain('');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 11. DEFINE
// ═══════════════════════════════════════════════════════════════════

describe('DEFINE var = value', () => {
  test('DEFINE sets a substitution variable', () => {
    cmd('DEFINE MYVAR = hello');
    const result = cmd('DEFINE MYVAR');
    const out = result.output.join('\n');
    expect(out).toContain('MYVAR');
    expect(out).toContain('hello');
  });

  test('DEFINE with quoted value strips quotes', () => {
    cmd("DEFINE GREETING = 'Bonjour'");
    const result = cmd('DEFINE GREETING');
    expect(result.output.join('\n')).toContain('Bonjour');
  });

  test('DEFINE with no args lists all variables', () => {
    cmd('DEFINE X = 42');
    const result = cmd('DEFINE');
    const out = result.output.join('\n');
    expect(out).toContain('X');
    expect(out).toContain('42');
  });

  test('DEFINE undefined variable returns SP2-0135', () => {
    const result = cmd('DEFINE NOEXIST');
    expect(result.output.some(l => l.includes('SP2-0135'))).toBe(true);
    expect(result.output.some(l => l.includes('UNDEFINED'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 12. VARIABLE / PRINT (bind variables)
// ═══════════════════════════════════════════════════════════════════

describe('VARIABLE var TYPE', () => {
  test('VARIABLE declares a bind variable', () => {
    const result = cmd('VARIABLE MYNUM NUMBER');
    expect(result.output.length).toBe(0); // silent success

    // Verify it exists via VARIABLE (list all)
    const listResult = cmd('VARIABLE');
    const out = listResult.output.join('\n');
    expect(out).toContain('MYNUM');
    expect(out).toContain('NUMBER');
  });

  test('VAR is alias for VARIABLE', () => {
    const result = cmd('VAR MYSTR VARCHAR2(100)');
    expect(result.output.length).toBe(0);
  });

  test('VARIABLE with no args lists all bind variables', () => {
    cmd('VARIABLE A NUMBER');
    cmd('VARIABLE B VARCHAR2(50)');
    const result = cmd('VARIABLE');
    const out = result.output.join('\n');
    expect(out).toContain('A');
    expect(out).toContain('B');
  });
});

describe('PRINT var', () => {
  test('PRINT displays bind variable value (null initially)', () => {
    cmd('VARIABLE RESULT NUMBER');
    const result = cmd('PRINT RESULT');
    const out = result.output.join('\n');
    expect(out).toContain('RESULT');
    // Separator line
    expect(result.output.some(l => l.includes('-'))).toBe(true);
  });

  test('PRINT undeclared variable returns SP2-0552', () => {
    const result = cmd('PRINT NOSUCHVAR');
    expect(result.output.some(l => l.includes('SP2-0552'))).toBe(true);
  });

  test('PRINT with no args lists all bind variables', () => {
    cmd('VARIABLE V1 NUMBER');
    cmd('VARIABLE V2 VARCHAR2(20)');
    const result = cmd('PRINT');
    const out = result.output.join('\n');
    expect(out).toContain('V1');
    expect(out).toContain('V2');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 13. HOST command (stub)
// ═══════════════════════════════════════════════════════════════════

describe('HOST command', () => {
  test('HOST returns SP2-0734 not available', () => {
    const result = cmd('HOST ls -la');
    expect(result.output.some(l => l.includes('SP2-0734'))).toBe(true);
  });

  test('HOST without args returns SP2-0734', () => {
    const result = cmd('HOST');
    expect(result.output.some(l => l.includes('SP2-0734'))).toBe(true);
  });

  test('! shortcut returns SP2-0734', () => {
    const result = cmd('!ls');
    expect(result.output.some(l => l.includes('SP2-0734'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 14. EDIT (stub)
// ═══════════════════════════════════════════════════════════════════

describe('EDIT', () => {
  test('EDIT returns SP2-0107 stub message', () => {
    const result = cmd('EDIT');
    expect(result.output.some(l => l.includes('SP2-0107'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 15. / — Re-execute last SQL statement
// ═══════════════════════════════════════════════════════════════════

describe('/ — re-execute last SQL', () => {
  test('/ re-executes the last SQL statement', () => {
    const first = cmd('SELECT 1 + 1 FROM DUAL;');
    expect(first.output.some(l => l.includes('2'))).toBe(true);

    const second = cmd('/');
    expect(second.output.some(l => l.includes('2'))).toBe(true);
  });

  test('/ with no previous statement returns SP2-0103', () => {
    const freshSession = new SQLPlusSession(db);
    freshSession.login('SYS', 'oracle', true);
    const result = freshSession.processLine('/');
    expect(result.output.some(l => l.includes('SP2-0103'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 16. SQL EXECUTION — multi-line and basic queries
// ═══════════════════════════════════════════════════════════════════

describe('SQL statement execution', () => {
  test('single-line SELECT with semicolon executes immediately', () => {
    const result = cmd('SELECT 42 FROM DUAL;');
    expect(result.exit).toBe(false);
    expect(result.needsMoreInput).toBe(false);
    expect(result.output.some(l => l.includes('42'))).toBe(true);
  });

  test('multi-line SQL accumulates until semicolon', () => {
    const line1 = cmd('SELECT');
    expect(line1.needsMoreInput).toBe(true);
    expect(line1.output.length).toBe(0);

    const line2 = session.processLine('1 + 1');
    expect(line2.needsMoreInput).toBe(true);

    const line3 = session.processLine('FROM DUAL;');
    expect(line3.needsMoreInput).toBe(false);
    expect(line3.output.some(l => l.includes('2'))).toBe(true);
  });

  test('SQL without connection returns ORA-01012', () => {
    cmd('DISCONNECT');
    const result = cmd('SELECT 1 FROM DUAL;');
    expect(result.output.some(l => l.includes('ORA-01012'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 17. PROMPT — getPrompt() behavior
// ═══════════════════════════════════════════════════════════════════

describe('SQL> prompt behavior', () => {
  test('default prompt is SQL> ', () => {
    expect(session.getPrompt()).toBe('SQL> ');
  });

  test('SET SQLPROMPT changes the prompt', () => {
    cmd('SET SQLPROMPT "ORCL> "');
    expect(session.getPrompt()).toBe('ORCL> ');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 18. HELP
// ═══════════════════════════════════════════════════════════════════

describe('HELP', () => {
  test('HELP displays available commands', () => {
    const result = cmd('HELP');
    const out = result.output.join('\n');
    expect(out).toContain('CONNECT');
    expect(out).toContain('DESCRIBE');
    expect(out).toContain('EXIT');
    expect(out).toContain('SET');
    expect(out).toContain('SHOW');
    expect(out).toContain('SPOOL');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 19. SHOW SPPARAMETER
// ═══════════════════════════════════════════════════════════════════

describe('SHOW SPPARAMETER', () => {
  test('SHOW SPPARAMETER lists spfile parameters with SID column', () => {
    const result = cmd('SHOW SPPARAMETER');
    const out = result.output.join('\n');
    expect(out).toContain('SID');
    expect(out).toContain('NAME');
    expect(out).toContain('TYPE');
    expect(out).toContain('VALUE');
  });

  test('SHOW SPPARAMETER db_name filters by name', () => {
    const result = cmd('SHOW SPPARAMETER db_name');
    const lines = result.output.filter(l => l.includes('db_name'));
    expect(lines.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 20. SHOW RELEASE
// ═══════════════════════════════════════════════════════════════════

describe('SHOW RELEASE', () => {
  test('displays release number', () => {
    expect(output('SHOW RELEASE')).toContain('1903000000');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 21. Additional SET options
// ═══════════════════════════════════════════════════════════════════

describe('SET HEADING ON/OFF', () => {
  test('SET HEADING OFF suppresses column headers', () => {
    cmd('SET HEADING OFF');
    const result = cmd('SELECT 1 FROM DUAL;');
    // Should not contain separator line
    const hasSeparator = result.output.some(l => /^-+$/.test(l.trim()));
    expect(hasSeparator).toBe(false);
  });

  test('SET HEADING ON shows column headers', () => {
    cmd('SET HEADING ON');
    const result = cmd("SELECT 'ABCDEF' AS TESTCOL FROM DUAL;");
    // Should contain a separator with dashes
    const hasSeparator = result.output.some(l => l.includes('---'));
    expect(hasSeparator).toBe(true);
    // Should contain the column name
    expect(result.output.some(l => l.includes('TESTCOL'))).toBe(true);
  });
});

describe('SET COLSEP', () => {
  test('SET COLSEP changes column separator', () => {
    cmd('SET COLSEP "|"');
    const show = output('SHOW ALL');
    expect(show).toContain('colsep "|"');
  });
});

describe('SET NULL', () => {
  test('SET NULL changes null display', () => {
    cmd('SET NULL "(null)"');
    const show = output('SHOW ALL');
    expect(show).toContain('null "(null)"');
  });
});

describe('SET WRAP ON/OFF', () => {
  test('SET WRAP OFF disables wrapping', () => {
    cmd('SET WRAP OFF');
    const show = output('SHOW ALL');
    expect(show).toContain('wrap OFF');
  });
});

describe('SET VERIFY ON/OFF', () => {
  test('SET VERIFY OFF disables verify', () => {
    cmd('SET VERIFY OFF');
    const show = output('SHOW ALL');
    expect(show).toContain('verify OFF');
  });
});

describe('SET UNDERLINE', () => {
  test('SET UNDERLINE = changes separator character', () => {
    cmd('SET UNDERLINE =');
    cmd('SET HEADING ON');
    const result = cmd("SELECT 'ABCDEF' AS TESTCOL FROM DUAL;");
    const hasEquals = result.output.some(l => l.includes('==='));
    expect(hasEquals).toBe(true);
  });

  test('SET UNDERLINE OFF removes separators', () => {
    cmd('SET UNDERLINE OFF');
    const result = cmd('SELECT 1 FROM DUAL;');
    // No separator with dashes
    const hasDash = result.output.some(l => /^-+$/.test(l.trim()));
    expect(hasDash).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 22. PL/SQL block execution
// ═══════════════════════════════════════════════════════════════════

describe('PL/SQL block execution', () => {
  test('BEGIN...END; block executes', () => {
    cmd('SET SERVEROUTPUT ON');
    const line1 = cmd('BEGIN');
    expect(line1.needsMoreInput).toBe(true);

    const line2 = session.processLine("DBMS_OUTPUT.PUT_LINE('Hello');");
    expect(line2.needsMoreInput).toBe(true);

    const line3 = session.processLine('END;');
    expect(line3.needsMoreInput).toBe(false);
    // Should have executed (may have output if DBMS_OUTPUT works)
  });
});

// ═══════════════════════════════════════════════════════════════════
// 23. Unknown command
// ═══════════════════════════════════════════════════════════════════

describe('Unknown commands', () => {
  test('unknown command returns SP2-0734', () => {
    const result = cmd('FOOBAR');
    expect(result.output.some(l => l.includes('SP2-0734'))).toBe(true);
    expect(result.output.some(l => l.includes('unknown command'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 24. STARTUP / SHUTDOWN (admin commands, no semicolon needed)
// ═══════════════════════════════════════════════════════════════════

describe('STARTUP / SHUTDOWN admin commands', () => {
  test('SHUTDOWN IMMEDIATE executes without semicolon', () => {
    const result = cmd('SHUTDOWN IMMEDIATE');
    // Should not need more input
    expect(result.needsMoreInput).toBe(false);
  });

  test('STARTUP executes without semicolon', () => {
    cmd('SHUTDOWN IMMEDIATE');
    const result = cmd('STARTUP');
    expect(result.needsMoreInput).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 25. SET TERMOUT / SET TRIMSPOOL
// ═══════════════════════════════════════════════════════════════════

describe('SET TERMOUT / SET TRIMSPOOL', () => {
  test('SET TERMOUT OFF is accepted', () => {
    const result = cmd('SET TERMOUT OFF');
    expect(result.output.length).toBe(0); // no error
  });

  test('SET TRIMSPOOL ON is accepted', () => {
    const result = cmd('SET TRIMSPOOL ON');
    expect(result.output.length).toBe(0); // no error
  });

  test('SET TRIMS ON uses abbreviation', () => {
    const result = cmd('SET TRIMS ON');
    expect(result.output.length).toBe(0);
  });

  test('SET TERM OFF uses abbreviation', () => {
    const result = cmd('SET TERM OFF');
    expect(result.output.length).toBe(0);
  });
});
