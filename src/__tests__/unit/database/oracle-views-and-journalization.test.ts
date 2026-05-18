/**
 * Oracle object management for VIEWS + journalization (audit/log) tests.
 *
 * Mirrors the depth of the existing oracle-security-audit and
 * oracle-access-management suites for two new feature areas:
 *
 *   A. Object management for views
 *      1.  DBA_VIEWS lists built-in dictionary views (SYS-owned)
 *      2.  DBA_VIEWS lists user-defined views
 *      3.  USER_VIEWS filters to the current user's schema
 *      4.  ALL_VIEWS exposes SYS catalog views + user's own
 *      5.  DBA_OBJECTS / ALL_OBJECTS / USER_OBJECTS include views
 *      6.  DESC works on dictionary views (DESC ALL_VIEWS, etc.)
 *      7.  DESC works on user-defined views
 *      8.  TEXT column contains a definition string
 *
 *   B. Journalization (audit / alert log / unified trail)
 *      9.  LOGON/LOGOFF entries recorded for connect/disconnect
 *     10.  Failed logon recorded with non-zero RETURNCODE
 *     11.  DDL/DCL actions populate DBA_AUDIT_TRAIL with SQL_TEXT
 *     12.  AUDIT SELECT TABLE causes SELECT to be recorded
 *     13.  DBA_AUDIT_SESSION pairs LOGON with LOGOFF
 *     14.  DBA_AUDIT_OBJECT filters to object-targeted events
 *     15.  DBA_AUDIT_STATEMENT filters to statement-level events
 *     16.  UNIFIED_AUDIT_TRAIL surfaces every audit event
 *     17.  DBA_FGA_AUDIT_TRAIL populated by FGA hits
 *     18.  DBA_AUDIT_POLICIES reflects registered FGA policies
 *     19.  Alert log captures logon/logoff and archive log events
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import { OracleExecutor } from '../../../database/oracle/OracleExecutor';
import { SQLPlusSession } from '../../../database/oracle/commands/SQLPlusSession';

let db: OracleDatabase;
let executor: OracleExecutor;
let sysSid: number;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  const conn = db.connectAsSysdba();
  executor = conn.executor;
  sysSid = conn.sid;
});

function exec(sql: string) {
  return db.executeSql(executor, sql);
}

function createSQLPlus(): { session: SQLPlusSession; cmd: (line: string) => string } {
  const session = new SQLPlusSession(db);
  session.processLine('CONNECT / AS SYSDBA');
  return {
    session,
    cmd(line: string): string {
      const result = session.processLine(line);
      return result.output.join('\n');
    },
  };
}

// ═══════════════════════════════════════════════════════════════════
// A. Object management for VIEWS
// ═══════════════════════════════════════════════════════════════════

describe('DBA_VIEWS — built-in dictionary views', () => {
  test('reports DBA_USERS / V$SESSION / UNIFIED_AUDIT_TRAIL as SYS-owned views', () => {
    const result = exec("SELECT OWNER, VIEW_NAME FROM DBA_VIEWS WHERE VIEW_NAME IN ('DBA_USERS','V$SESSION','UNIFIED_AUDIT_TRAIL')");
    const names = result.rows.map(r => r[1]);
    expect(names).toContain('DBA_USERS');
    expect(names).toContain('V$SESSION');
    expect(names).toContain('UNIFIED_AUDIT_TRAIL');
    for (const r of result.rows) expect(r[0]).toBe('SYS');
  });

  test('full Oracle 19c column set is present', () => {
    const result = exec('SELECT * FROM DBA_VIEWS WHERE VIEW_NAME = \'DBA_USERS\'');
    const colNames = result.columns.map(c => c.name);
    expect(colNames).toEqual([
      'OWNER', 'VIEW_NAME', 'TEXT_LENGTH', 'TEXT',
      'TYPE_TEXT_LENGTH', 'TYPE_TEXT', 'OID_TEXT_LENGTH', 'OID_TEXT',
      'VIEW_TYPE_OWNER', 'VIEW_TYPE', 'SUPERVIEW_NAME',
      'EDITIONING_VIEW', 'READ_ONLY', 'BEQUEATH',
      'ORIGIN_CON_ID', 'DEFAULT_COLLATION', 'CONTAINER_DATA',
    ]);
  });

  test('TEXT and TEXT_LENGTH are populated', () => {
    const result = exec("SELECT VIEW_NAME, TEXT_LENGTH, TEXT FROM DBA_VIEWS WHERE VIEW_NAME = 'DBA_USERS'");
    expect(result.rows.length).toBe(1);
    const text = String(result.rows[0][2]);
    expect(text.length).toBeGreaterThan(0);
    expect(result.rows[0][1]).toBe(text.length);
  });

  test('user-created views appear alongside dictionary views', () => {
    exec('CREATE TABLE views_test (id NUMBER, val VARCHAR2(50))');
    exec('CREATE VIEW v_views_test AS SELECT id, val FROM views_test');
    const result = exec("SELECT OWNER, VIEW_NAME FROM DBA_VIEWS WHERE VIEW_NAME = 'V_VIEWS_TEST'");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toBe('SYS');
  });

  test('view counts grow as built-ins increase', () => {
    const result = exec('SELECT VIEW_NAME FROM DBA_VIEWS');
    expect(result.rows.length).toBeGreaterThan(50);
  });

  test('COUNT(*) aggregates correctly on DBA_VIEWS', () => {
    const all = exec('SELECT VIEW_NAME FROM DBA_VIEWS').rows.length;
    const result = exec('SELECT COUNT(*) FROM DBA_VIEWS');
    expect(result.rows.length).toBe(1);
    expect(Number(result.rows[0][0])).toBe(all);
  });

  test('GROUP BY works on DBA_VIEWS', () => {
    const result = exec('SELECT OWNER, COUNT(*) AS N FROM DBA_VIEWS GROUP BY OWNER');
    expect(result.rows.length).toBeGreaterThan(0);
    const sysRow = result.rows.find(r => r[0] === 'SYS');
    expect(sysRow).toBeDefined();
    expect(Number(sysRow![1])).toBeGreaterThan(50);
  });

  test('COUNT(*) on V$LOG returns redo group count', () => {
    const groups = exec('SELECT GROUP# FROM V$LOG').rows.length;
    const result = exec('SELECT COUNT(*) FROM V$LOG');
    expect(result.rows.length).toBe(1);
    expect(Number(result.rows[0][0])).toBe(groups);
  });

  test('aggregate functions over catalog views (SUM/MAX)', () => {
    const result = exec('SELECT MAX(GROUP#) AS MAX_GRP FROM V$LOG');
    expect(result.rows.length).toBe(1);
    expect(Number(result.rows[0][0])).toBeGreaterThan(0);
  });
});

describe('USER_VIEWS', () => {
  test('omits OWNER and filters to the current schema', () => {
    exec('CREATE TABLE my_tbl (id NUMBER)');
    exec('CREATE VIEW my_v AS SELECT id FROM my_tbl');
    const result = exec('SELECT * FROM USER_VIEWS');
    expect(result.columns.map(c => c.name)).not.toContain('OWNER');
    expect(result.columns[0].name).toBe('VIEW_NAME');
    // SYS sees its own views + every SYS-owned dictionary view
    const names = result.rows.map(r => r[0]);
    expect(names).toContain('MY_V');
  });

  test('non-SYS user sees only their own views', () => {
    exec('CREATE USER alice IDENTIFIED BY pass1');
    exec('GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, UNLIMITED TABLESPACE TO alice');
    exec('CREATE TABLE alice.atbl (id NUMBER)');
    exec('CREATE VIEW alice.av AS SELECT id FROM alice.atbl');

    const aliceConn = db.connect('alice', 'pass1');
    const result = db.executeSql(aliceConn.executor, 'SELECT VIEW_NAME FROM USER_VIEWS');
    const names = result.rows.map(r => r[0]);
    expect(names).toContain('AV');
    // DBA_USERS is SYS-owned, must not appear in alice's USER_VIEWS
    expect(names).not.toContain('DBA_USERS');
  });
});

describe('ALL_VIEWS', () => {
  test('SYS sees the SYS-owned dictionary catalog', () => {
    const result = exec("SELECT VIEW_NAME FROM ALL_VIEWS WHERE VIEW_NAME = 'DBA_USERS'");
    expect(result.rows.length).toBe(1);
  });

  test('non-SYS user sees catalog views + own views', () => {
    exec('CREATE USER bob IDENTIFIED BY pass2');
    exec('GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, UNLIMITED TABLESPACE TO bob');
    exec('CREATE TABLE bob.btbl (id NUMBER)');
    exec('CREATE VIEW bob.bv AS SELECT id FROM bob.btbl');

    const bobConn = db.connect('bob', 'pass2');
    const result = db.executeSql(bobConn.executor, "SELECT OWNER, VIEW_NAME FROM ALL_VIEWS WHERE VIEW_NAME IN ('BV','DBA_USERS','V$SESSION')");
    const tuples = result.rows.map(r => `${r[0]}.${r[1]}`);
    expect(tuples).toContain('BOB.BV');
    expect(tuples).toContain('SYS.DBA_USERS');
    expect(tuples).toContain('SYS.V$SESSION');
  });
});

describe('DBA_OBJECTS / ALL_OBJECTS / USER_OBJECTS', () => {
  test('DBA_OBJECTS lists VIEW objects', () => {
    const result = exec("SELECT OBJECT_NAME FROM DBA_OBJECTS WHERE OBJECT_TYPE = 'VIEW'");
    expect(result.rows.length).toBeGreaterThan(50);
  });

  test('DBA_OBJECTS has Oracle 19c column set', () => {
    const result = exec('SELECT * FROM DBA_OBJECTS WHERE OBJECT_NAME = \'DBA_USERS\'');
    const cols = result.columns.map(c => c.name);
    expect(cols).toContain('OBJECT_ID');
    expect(cols).toContain('CREATED');
    expect(cols).toContain('LAST_DDL_TIME');
    expect(cols).toContain('NAMESPACE');
    expect(cols).toContain('ORACLE_MAINTAINED');
  });

  test('USER_OBJECTS omits OWNER', () => {
    const result = exec('SELECT * FROM USER_OBJECTS');
    expect(result.columns.map(c => c.name)).not.toContain('OWNER');
  });

  test('OBJECT_ID values are unique', () => {
    const result = exec('SELECT OBJECT_ID FROM DBA_OBJECTS');
    const ids = result.rows.map(r => r[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('SYS-owned built-in views are ORACLE_MAINTAINED=Y', () => {
    const result = exec("SELECT ORACLE_MAINTAINED FROM DBA_OBJECTS WHERE OBJECT_NAME = 'V$SESSION'");
    expect(result.rows[0][0]).toBe('Y');
  });

  test('user tables are ORACLE_MAINTAINED=N', () => {
    exec('CREATE USER bobbobb IDENTIFIED BY p');
    exec('CREATE TABLE bobbobb.t1 (id NUMBER)');
    const result = exec("SELECT ORACLE_MAINTAINED FROM DBA_OBJECTS WHERE OBJECT_NAME = 'T1' AND OWNER = 'BOBBOBB'");
    expect(result.rows[0][0]).toBe('N');
  });
});

describe('DESC for views', () => {
  test('DESC ALL_VIEWS works', () => {
    const sp = createSQLPlus();
    const output = sp.cmd('DESC ALL_VIEWS');
    expect(output).not.toContain('ERROR');
    expect(output).toContain('OWNER');
    expect(output).toContain('VIEW_NAME');
    expect(output).toContain('TEXT_LENGTH');
    expect(output).toContain('TEXT');
  });

  test('DESC USER_VIEWS works', () => {
    const sp = createSQLPlus();
    const output = sp.cmd('DESC USER_VIEWS');
    expect(output).not.toContain('ERROR');
    expect(output).toContain('VIEW_NAME');
  });

  test('DESC DBA_VIEWS works', () => {
    const sp = createSQLPlus();
    const output = sp.cmd('DESC DBA_VIEWS');
    expect(output).not.toContain('ERROR');
    expect(output).toContain('OWNER');
    expect(output).toContain('VIEW_NAME');
  });

  test('DESC V$SESSION works', () => {
    const sp = createSQLPlus();
    const output = sp.cmd('DESC V$SESSION');
    expect(output).not.toContain('ERROR');
    expect(output).toContain('SID');
    expect(output).toContain('USERNAME');
  });

  test('DESC DBA_OBJECTS works', () => {
    const sp = createSQLPlus();
    const output = sp.cmd('DESC DBA_OBJECTS');
    expect(output).not.toContain('ERROR');
    expect(output).toContain('OBJECT_NAME');
    expect(output).toContain('OBJECT_TYPE');
  });

  test('DESC of a user-defined view introspects its columns', () => {
    exec('CREATE TABLE udv_base (id NUMBER NOT NULL, name VARCHAR2(50))');
    exec('CREATE VIEW udv_view AS SELECT id, name FROM udv_base');
    const sp = createSQLPlus();
    const output = sp.cmd('DESC udv_view');
    expect(output).not.toContain('ERROR');
    expect(output).toContain('ID');
    expect(output).toContain('NAME');
  });

  test('DESC of unknown object reports ORA-04043', () => {
    const sp = createSQLPlus();
    const output = sp.cmd('DESC no_such_object');
    expect(output).toContain('ERROR');
    expect(output).toContain('04043');
  });
});

// ═══════════════════════════════════════════════════════════════════
// B. Journalization
// ═══════════════════════════════════════════════════════════════════

describe('LOGON / LOGOFF auditing', () => {
  test('SYSDBA logon recorded in DBA_AUDIT_TRAIL', () => {
    const result = exec("SELECT ACTION_NAME, USERNAME, PRIV_USED FROM DBA_AUDIT_TRAIL WHERE ACTION_NAME = 'LOGON'");
    expect(result.rows.length).toBeGreaterThan(0);
    const sysLogon = result.rows.find(r => r[1] === 'SYS');
    expect(sysLogon).toBeDefined();
    expect(sysLogon![2]).toBe('SYSDBA');
  });

  test('successful user logon recorded with RETURNCODE=0', () => {
    exec('CREATE USER carol IDENTIFIED BY pwd');
    exec('GRANT CREATE SESSION TO carol');
    db.connect('carol', 'pwd');
    const result = exec("SELECT RETURNCODE FROM DBA_AUDIT_TRAIL WHERE ACTION_NAME = 'LOGON' AND USERNAME = 'CAROL'");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0][0]).toBe(0);
  });

  test('failed logon recorded with non-zero RETURNCODE', () => {
    exec('CREATE USER dan IDENTIFIED BY good');
    expect(() => db.connect('dan', 'wrong')).toThrow();
    const result = exec("SELECT RETURNCODE FROM DBA_AUDIT_TRAIL WHERE ACTION_NAME = 'LOGON' AND USERNAME = 'DAN'");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(Number(result.rows[0][0])).toBeGreaterThan(0);
  });

  test('logoff recorded on disconnect', () => {
    exec('CREATE USER eve IDENTIFIED BY pwd');
    exec('GRANT CREATE SESSION TO eve');
    const conn = db.connect('eve', 'pwd');
    db.disconnect(conn.sid);
    const result = exec("SELECT ACTION_NAME FROM DBA_AUDIT_TRAIL WHERE USERNAME = 'EVE' ORDER BY TIMESTAMP");
    const actions = result.rows.map(r => r[0]);
    expect(actions).toContain('LOGON');
    expect(actions).toContain('LOGOFF');
  });
});

describe('DBA_AUDIT_SESSION', () => {
  test('pairs LOGON with LOGOFF for closed sessions', () => {
    exec('CREATE USER fay IDENTIFIED BY pwd');
    exec('GRANT CREATE SESSION TO fay');
    const conn = db.connect('fay', 'pwd');
    db.disconnect(conn.sid);
    const result = exec("SELECT ACTION_NAME, LOGOFF_TIME FROM DBA_AUDIT_SESSION WHERE USERNAME = 'FAY'");
    const logon = result.rows.find(r => r[0] === 'LOGON');
    expect(logon).toBeDefined();
    expect(logon![1]).not.toBeNull();
  });

  test('active sessions have NULL LOGOFF_TIME', () => {
    const result = exec("SELECT LOGOFF_TIME FROM DBA_AUDIT_SESSION WHERE USERNAME = 'SYS' AND SESSIONID = " + sysSid);
    const logon = result.rows[0];
    expect(logon[0]).toBeNull();
  });
});

describe('DBA_AUDIT_TRAIL — SQL_TEXT capture', () => {
  test('DDL statements record their SQL_TEXT', () => {
    exec('CREATE TABLE txt_test (id NUMBER)');
    const result = exec("SELECT SQL_TEXT FROM DBA_AUDIT_TRAIL WHERE ACTION_NAME = 'CREATE TABLE' AND OBJ_NAME = 'TXT_TEST'");
    expect(result.rows.length).toBeGreaterThan(0);
    const sql = String(result.rows[0][0] ?? '');
    expect(sql.toUpperCase()).toContain('CREATE TABLE');
  });

  test('TERMINAL column exposed by DBA_AUDIT_SESSION', () => {
    const session = exec("SELECT TERMINAL FROM DBA_AUDIT_SESSION WHERE USERNAME = 'SYS'");
    expect(session.rows[0][0]).toBeDefined();
  });
});

describe('AUDIT SELECT propagates to DBA_AUDIT_TRAIL', () => {
  test('after AUDIT SELECT TABLE, SELECT is recorded with SQL_TEXT', () => {
    exec('CREATE TABLE sel_aud (id NUMBER, val VARCHAR2(20))');
    exec("INSERT INTO sel_aud VALUES (1, 'a')");
    exec('AUDIT SELECT');
    exec('SELECT id FROM sel_aud');
    const result = exec("SELECT ACTION_NAME, OBJ_NAME, SQL_TEXT FROM DBA_AUDIT_TRAIL WHERE ACTION_NAME = 'SELECT'");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.some(r => String(r[2] ?? '').toUpperCase().includes('SELECT'))).toBe(true);
  });
});

describe('DBA_AUDIT_OBJECT', () => {
  test('contains DDL events targeting an object', () => {
    exec('CREATE TABLE obj_aud (id NUMBER)');
    const result = exec("SELECT ACTION_NAME, OBJ_NAME FROM DBA_AUDIT_OBJECT WHERE OBJ_NAME = 'OBJ_AUD'");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.some(r => r[0] === 'CREATE TABLE')).toBe(true);
  });

  test('excludes LOGON/LOGOFF (those are session events)', () => {
    const result = exec("SELECT ACTION_NAME FROM DBA_AUDIT_OBJECT WHERE ACTION_NAME IN ('LOGON', 'LOGOFF')");
    expect(result.rows.length).toBe(0);
  });
});

describe('DBA_AUDIT_STATEMENT', () => {
  test('contains user / role / grant events', () => {
    exec('CREATE USER stmt_user IDENTIFIED BY pass');
    exec('GRANT CREATE SESSION TO stmt_user');
    const result = exec("SELECT ACTION_NAME FROM DBA_AUDIT_STATEMENT WHERE ACTION_NAME IN ('CREATE USER','GRANT')");
    const actions = result.rows.map(r => r[0]);
    expect(actions).toContain('CREATE USER');
    expect(actions).toContain('GRANT');
  });
});

describe('UNIFIED_AUDIT_TRAIL', () => {
  test('contains the full mix of audit events', () => {
    exec('CREATE USER uaud IDENTIFIED BY pwd');
    const result = exec("SELECT DBUSERNAME, ACTION_NAME FROM UNIFIED_AUDIT_TRAIL");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.some(r => r[1] === 'LOGON')).toBe(true);
    expect(result.rows.some(r => r[1] === 'CREATE USER')).toBe(true);
  });

  test('has Oracle 19c column set', () => {
    const result = exec('SELECT * FROM UNIFIED_AUDIT_TRAIL');
    const cols = result.columns.map(c => c.name);
    expect(cols).toContain('EVENT_TIMESTAMP');
    expect(cols).toContain('AUDIT_TYPE');
    expect(cols).toContain('SESSIONID');
    expect(cols).toContain('DBUSERNAME');
    expect(cols).toContain('ACTION_NAME');
    expect(cols).toContain('RETURN_CODE');
    expect(cols).toContain('SQL_TEXT');
    expect(cols).toContain('OBJECT_SCHEMA');
    expect(cols).toContain('OBJECT_NAME');
    expect(cols).toContain('ENTRY_ID');
  });

  test('ENTRY_ID is unique', () => {
    exec('CREATE TABLE entry_ids (id NUMBER)');
    exec('CREATE TABLE entry_ids2 (id NUMBER)');
    const result = exec('SELECT ENTRY_ID FROM UNIFIED_AUDIT_TRAIL');
    const ids = result.rows.map(r => r[0]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('Fine-grained auditing', () => {
  test('FGA policy registered through catalog appears in DBA_AUDIT_POLICIES', () => {
    db.catalog.addFgaPolicy({
      objectSchema: 'SYS', objectName: 'EMP',
      policyOwner: 'SYS', policyName: 'EMP_SALARY_AUDIT',
      policyText: 'salary > 100000', enabled: true,
      select: true, insert: false, update: true, delete: false,
    });
    const result = exec("SELECT POLICY_NAME, ENABLED, SEL, UPD FROM DBA_AUDIT_POLICIES WHERE POLICY_NAME = 'EMP_SALARY_AUDIT'");
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][1]).toBe('YES');
    expect(result.rows[0][2]).toBe('YES');
    expect(result.rows[0][3]).toBe('YES');
  });

  test('SELECT against an FGA-protected table records to DBA_FGA_AUDIT_TRAIL', () => {
    exec('CREATE TABLE fga_target (id NUMBER, ssn VARCHAR2(11))');
    exec("INSERT INTO fga_target VALUES (1, '111-22-3333')");
    db.catalog.addFgaPolicy({
      objectSchema: 'SYS', objectName: 'FGA_TARGET',
      policyOwner: 'SYS', policyName: 'FGA_SSN',
      policyText: '1=1', enabled: true,
      select: true, insert: false, update: false, delete: false,
    });
    exec('SELECT id, ssn FROM fga_target');
    const result = exec("SELECT POLICY_NAME, OBJECT_NAME, STATEMENT_TYPE FROM DBA_FGA_AUDIT_TRAIL WHERE POLICY_NAME = 'FGA_SSN'");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0][1]).toBe('FGA_TARGET');
    expect(result.rows[0][2]).toBe('SELECT');
  });

  test('UPDATE on FGA-protected table records to trail when policy enables UPD', () => {
    exec('CREATE TABLE fga_upd (id NUMBER, val VARCHAR2(20))');
    exec("INSERT INTO fga_upd VALUES (1, 'a')");
    db.catalog.addFgaPolicy({
      objectSchema: 'SYS', objectName: 'FGA_UPD',
      policyOwner: 'SYS', policyName: 'FGA_UPD_POL',
      policyText: '1=1', enabled: true,
      select: false, insert: false, update: true, delete: false,
    });
    exec("UPDATE fga_upd SET val = 'b' WHERE id = 1");
    const result = exec("SELECT STATEMENT_TYPE FROM DBA_FGA_AUDIT_TRAIL WHERE POLICY_NAME = 'FGA_UPD_POL'");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0][0]).toBe('UPDATE');
  });

  test('disabled FGA policy does not record', () => {
    exec('CREATE TABLE fga_disabled (id NUMBER)');
    db.catalog.addFgaPolicy({
      objectSchema: 'SYS', objectName: 'FGA_DISABLED',
      policyOwner: 'SYS', policyName: 'FGA_OFF',
      policyText: '1=1', enabled: false,
      select: true, insert: true, update: true, delete: true,
    });
    exec('SELECT * FROM fga_disabled');
    const result = exec("SELECT * FROM DBA_FGA_AUDIT_TRAIL WHERE POLICY_NAME = 'FGA_OFF'");
    expect(result.rows.length).toBe(0);
  });

  test('FGA appears in UNIFIED_AUDIT_TRAIL with AUDIT_TYPE=FineGrainedAudit', () => {
    exec('CREATE TABLE fga_uni (id NUMBER)');
    db.catalog.addFgaPolicy({
      objectSchema: 'SYS', objectName: 'FGA_UNI',
      policyOwner: 'SYS', policyName: 'FGA_UNI_POL',
      policyText: '1=1', enabled: true,
      select: true, insert: false, update: false, delete: false,
    });
    exec('SELECT * FROM fga_uni');
    const result = exec("SELECT AUDIT_TYPE FROM UNIFIED_AUDIT_TRAIL WHERE OBJECT_NAME = 'FGA_UNI'");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.some(r => r[0] === 'FineGrainedAudit')).toBe(true);
  });
});

describe('Alert log integration', () => {
  test('SYSDBA logon appears in alert log', () => {
    const log = db.instance.getAlertLog().join('\n');
    expect(log).toContain('Logon: user=SYS');
    expect(log).toContain('as SYSDBA');
  });

  test('disconnect logs LOGOFF event', () => {
    exec('CREATE USER tracer IDENTIFIED BY pwd');
    exec('GRANT CREATE SESSION TO tracer');
    const conn = db.connect('tracer', 'pwd');
    db.disconnect(conn.sid);
    const log = db.instance.getAlertLog().join('\n');
    expect(log).toContain('Logoff: user=TRACER');
  });

  test('archive log switch appears in alert log', () => {
    db.instance.setArchiveLogMode(false); // ensure clean start
    db.instance.switchLogfile();
    const log = db.instance.getAlertLog().join('\n');
    expect(log).toMatch(/Thread 1 advanced to log sequence/);
  });
});
