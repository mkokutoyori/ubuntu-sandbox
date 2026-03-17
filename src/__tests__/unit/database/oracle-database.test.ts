/**
 * Integration tests for the Oracle database engine.
 * Tests the full pipeline: SQL string → Lexer → Parser → Executor → ResultSet.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { installHRSchema, installSCOTTSchema } from '@/database/oracle/demo/DemoSchemas';

let db: OracleDatabase;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
});

function exec(sql: string) {
  const { executor } = db.connectAsSysdba();
  return db.executeSql(executor, sql);
}

describe('OracleDatabase — Instance management', () => {
  it('starts up and shuts down', () => {
    expect(db.instance.isOpen).toBe(true);
    expect(db.instance.state).toBe('OPEN');
  });

  it('provides SID', () => {
    expect(db.getSid()).toBe('ORCL');
  });
});

describe('OracleDatabase — SELECT from DUAL', () => {
  it('SELECT 1 FROM DUAL', () => {
    const result = exec('SELECT 1 FROM DUAL');
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][0]).toBe(1);
  });

  it('SELECT SYSDATE FROM DUAL', () => {
    const result = exec('SELECT SYSDATE FROM DUAL');
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBe(1);
    // SYSDATE returns a date string like '2026-03-17 04:25:27'
    expect(typeof result.rows[0][0]).toBe('string');
    expect(String(result.rows[0][0])).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('SELECT string expression', () => {
    const result = exec("SELECT 'Hello' FROM DUAL");
    expect(result.rows[0][0]).toBe('Hello');
  });

  it('SELECT arithmetic', () => {
    const result = exec('SELECT 2 + 3 FROM DUAL');
    expect(result.rows[0][0]).toBe(5);
  });
});

describe('OracleDatabase — DDL', () => {
  it('CREATE and DROP TABLE', () => {
    exec('CREATE TABLE test_tbl (id NUMBER(10), name VARCHAR2(50))');
    const exists = db.storage.tableExists('SYS', 'TEST_TBL');
    expect(exists).toBe(true);

    exec('DROP TABLE test_tbl');
    expect(db.storage.tableExists('SYS', 'TEST_TBL')).toBe(false);
  });

  it('CREATE TABLE with NOT NULL constraint', () => {
    exec('CREATE TABLE constrained (id NUMBER NOT NULL, name VARCHAR2(30))');
    const meta = db.storage.getTableMeta('SYS', 'CONSTRAINED');
    expect(meta).toBeDefined();
    expect(meta!.columns[0].dataType.nullable).toBe(false);
  });

  it('CREATE and DROP SEQUENCE', () => {
    exec('CREATE SEQUENCE test_seq START WITH 100 INCREMENT BY 5');
    const val = db.storage.nextVal('SYS', 'TEST_SEQ');
    expect(val).toBe(100);
    const val2 = db.storage.nextVal('SYS', 'TEST_SEQ');
    expect(val2).toBe(105);

    exec('DROP SEQUENCE test_seq');
  });

  it('TRUNCATE TABLE', () => {
    exec('CREATE TABLE trunc_test (id NUMBER)');
    exec('INSERT INTO trunc_test VALUES (1)');
    exec('INSERT INTO trunc_test VALUES (2)');

    let rows = exec('SELECT * FROM trunc_test');
    expect(rows.rows.length).toBe(2);

    exec('TRUNCATE TABLE trunc_test');
    rows = exec('SELECT * FROM trunc_test');
    expect(rows.rows.length).toBe(0);
  });
});

describe('OracleDatabase — DML', () => {
  beforeEach(() => {
    exec('CREATE TABLE emp (id NUMBER NOT NULL, name VARCHAR2(30), salary NUMBER)');
  });

  it('INSERT and SELECT', () => {
    exec("INSERT INTO emp VALUES (1, 'Alice', 50000)");
    exec("INSERT INTO emp VALUES (2, 'Bob', 60000)");

    const result = exec('SELECT * FROM emp');
    expect(result.rows.length).toBe(2);
    expect(result.rows[0][1]).toBe('Alice');
    expect(result.rows[1][1]).toBe('Bob');
  });

  it('UPDATE', () => {
    exec("INSERT INTO emp VALUES (1, 'Alice', 50000)");
    exec('UPDATE emp SET salary = 55000 WHERE id = 1');

    const result = exec('SELECT salary FROM emp WHERE id = 1');
    expect(result.rows[0][0]).toBe(55000);
  });

  it('DELETE', () => {
    exec("INSERT INTO emp VALUES (1, 'Alice', 50000)");
    exec("INSERT INTO emp VALUES (2, 'Bob', 60000)");
    exec('DELETE FROM emp WHERE id = 1');

    const result = exec('SELECT * FROM emp');
    expect(result.rows.length).toBe(1);
    expect(result.rows[0][1]).toBe('Bob');
  });

  it('INSERT with column list', () => {
    exec("INSERT INTO emp (id, name) VALUES (1, 'Charlie')");
    const result = exec('SELECT * FROM emp');
    expect(result.rows[0][0]).toBe(1);
    expect(result.rows[0][1]).toBe('Charlie');
    expect(result.rows[0][2]).toBeNull();
  });

  it('rejects NOT NULL violation', () => {
    expect(() => exec("INSERT INTO emp (name) VALUES ('NoId')")).toThrow();
  });
});

describe('OracleDatabase — WHERE conditions', () => {
  beforeEach(() => {
    exec('CREATE TABLE data (id NUMBER, val VARCHAR2(20), num NUMBER)');
    exec("INSERT INTO data VALUES (1, 'alpha', 10)");
    exec("INSERT INTO data VALUES (2, 'beta', 20)");
    exec("INSERT INTO data VALUES (3, 'gamma', 30)");
    exec("INSERT INTO data VALUES (4, NULL, NULL)");
  });

  it('comparison operators', () => {
    expect(exec('SELECT * FROM data WHERE num > 15').rows.length).toBe(2);
    expect(exec('SELECT * FROM data WHERE num <= 20').rows.length).toBe(2);
  });

  it('AND / OR', () => {
    expect(exec('SELECT * FROM data WHERE num > 10 AND num < 30').rows.length).toBe(1);
    expect(exec('SELECT * FROM data WHERE id = 1 OR id = 3').rows.length).toBe(2);
  });

  it('IS NULL / IS NOT NULL', () => {
    expect(exec('SELECT * FROM data WHERE val IS NULL').rows.length).toBe(1);
    expect(exec('SELECT * FROM data WHERE val IS NOT NULL').rows.length).toBe(3);
  });

  it('BETWEEN', () => {
    expect(exec('SELECT * FROM data WHERE num BETWEEN 10 AND 20').rows.length).toBe(2);
  });

  it('IN list', () => {
    expect(exec('SELECT * FROM data WHERE id IN (1, 3)').rows.length).toBe(2);
  });

  it('LIKE', () => {
    expect(exec("SELECT * FROM data WHERE val LIKE 'a%'").rows.length).toBe(1); // alpha
    expect(exec("SELECT * FROM data WHERE val LIKE '%a'").rows.length).toBe(3); // alpha, beta, gamma
  });
});

describe('OracleDatabase — ORDER BY', () => {
  beforeEach(() => {
    exec('CREATE TABLE sorted (id NUMBER, name VARCHAR2(20))');
    exec("INSERT INTO sorted VALUES (3, 'Charlie')");
    exec("INSERT INTO sorted VALUES (1, 'Alice')");
    exec("INSERT INTO sorted VALUES (2, 'Bob')");
  });

  it('ORDER BY ASC', () => {
    const result = exec('SELECT * FROM sorted ORDER BY id');
    expect(result.rows.map(r => r[0])).toEqual([1, 2, 3]);
  });

  it('ORDER BY DESC', () => {
    const result = exec('SELECT * FROM sorted ORDER BY id DESC');
    expect(result.rows.map(r => r[0])).toEqual([3, 2, 1]);
  });
});

describe('OracleDatabase — Functions', () => {
  it('UPPER / LOWER', () => {
    expect(exec("SELECT UPPER('hello') FROM DUAL").rows[0][0]).toBe('HELLO');
    expect(exec("SELECT LOWER('HELLO') FROM DUAL").rows[0][0]).toBe('hello');
  });

  it('LENGTH', () => {
    expect(exec("SELECT LENGTH('hello') FROM DUAL").rows[0][0]).toBe(5);
  });

  it('SUBSTR', () => {
    expect(exec("SELECT SUBSTR('hello', 2, 3) FROM DUAL").rows[0][0]).toBe('ell');
  });

  it('NVL', () => {
    expect(exec("SELECT NVL(NULL, 'default') FROM DUAL").rows[0][0]).toBe('default');
    expect(exec("SELECT NVL('value', 'default') FROM DUAL").rows[0][0]).toBe('value');
  });

  it('TRIM', () => {
    expect(exec("SELECT TRIM('  hello  ') FROM DUAL").rows[0][0]).toBe('hello');
  });

  it('ROUND', () => {
    expect(exec('SELECT ROUND(3.14159, 2) FROM DUAL').rows[0][0]).toBe(3.14);
  });

  it('TO_CHAR with number', () => {
    const result = exec('SELECT TO_CHAR(123) FROM DUAL');
    expect(result.rows[0][0]).toBe('123');
  });

  it('COALESCE', () => {
    expect(exec("SELECT COALESCE(NULL, NULL, 'third') FROM DUAL").rows[0][0]).toBe('third');
  });
});

describe('OracleDatabase — Catalog views', () => {
  it('V$VERSION', () => {
    const result = exec('SELECT * FROM V$VERSION');
    expect(result.isQuery).toBe(true);
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('V$INSTANCE', () => {
    const result = exec('SELECT * FROM V$INSTANCE');
    expect(result.rows.length).toBe(1);
  });

  it('DBA_USERS', () => {
    const result = exec('SELECT * FROM DBA_USERS');
    expect(result.rows.length).toBeGreaterThanOrEqual(4); // SYS, SYSTEM, HR, SCOTT, DBSNMP
  });

  it('DBA_TABLESPACES', () => {
    const result = exec('SELECT * FROM DBA_TABLESPACES');
    expect(result.rows.length).toBeGreaterThanOrEqual(4); // SYSTEM, SYSAUX, USERS, TEMP
  });
});

describe('OracleDatabase — User management', () => {
  it('CREATE USER and authenticate', () => {
    exec("CREATE USER testuser IDENTIFIED BY testpass");
    const auth = db.catalog.authenticate('testuser', 'testpass');
    expect(auth).toBe(true);
  });

  it('ALTER USER password', () => {
    exec("CREATE USER testuser IDENTIFIED BY oldpass");
    exec("ALTER USER testuser IDENTIFIED BY newpass");
    expect(db.catalog.authenticate('testuser', 'newpass')).toBe(true);
    expect(db.catalog.authenticate('testuser', 'oldpass')).toBe(false);
  });

  it('DROP USER', () => {
    exec("CREATE USER tempuser IDENTIFIED BY pass");
    exec("DROP USER tempuser");
    expect(db.catalog.authenticate('tempuser', 'pass')).toBe(false);
  });

  it('GRANT and REVOKE system privilege', () => {
    exec("CREATE USER grantee IDENTIFIED BY pass");
    exec("GRANT CREATE SESSION TO grantee");
    expect(db.catalog.hasSystemPrivilege('GRANTEE', 'CREATE SESSION')).toBe(true);
    exec("REVOKE CREATE SESSION FROM grantee");
    expect(db.catalog.hasSystemPrivilege('GRANTEE', 'CREATE SESSION')).toBe(false);
  });
});

describe('OracleDatabase — Connection', () => {
  it('connects with valid credentials', () => {
    const { sid, executor } = db.connect('SYS', 'oracle');
    expect(sid).toBeGreaterThan(0);
    expect(executor).toBeDefined();
  });

  it('rejects invalid credentials', () => {
    expect(() => db.connect('SYS', 'wrongpass')).toThrow('ORA-01017');
  });

  it('connects as SYSDBA', () => {
    const { sid } = db.connectAsSysdba();
    expect(sid).toBeGreaterThan(0);
  });
});

describe('OracleDatabase — Demo schemas', () => {
  it('installs HR schema with tables and data', () => {
    installHRSchema(db);

    const { executor } = db.connectAsSysdba();
    const depts = db.executeSql(executor, 'SELECT * FROM HR.DEPARTMENTS');
    expect(depts.rows.length).toBeGreaterThan(5);

    const emps = db.executeSql(executor, 'SELECT * FROM HR.EMPLOYEES');
    expect(emps.rows.length).toBe(20);

    const jobs = db.executeSql(executor, 'SELECT * FROM HR.JOBS');
    expect(jobs.rows.length).toBe(19);
  });

  it('installs SCOTT schema with EMP and DEPT', () => {
    installSCOTTSchema(db);

    const { executor } = db.connectAsSysdba();
    const emp = db.executeSql(executor, 'SELECT * FROM SCOTT.EMP');
    expect(emp.rows.length).toBe(14);

    const dept = db.executeSql(executor, 'SELECT * FROM SCOTT.DEPT');
    expect(dept.rows.length).toBe(4);

    const salgrade = db.executeSql(executor, 'SELECT * FROM SCOTT.SALGRADE');
    expect(salgrade.rows.length).toBe(5);
  });
});

describe('OracleDatabase — SQLPlusSession', () => {
  it('creates SQLPlus session and executes queries', async () => {
    const { SQLPlusSession } = await import('@/database/oracle/commands/SQLPlusSession');

    const session = new SQLPlusSession(db);
    const loginOutput = session.login('SYS', 'oracle', true);
    expect(loginOutput).toContain('Connected.');

    const result = session.processLine('SELECT 1 FROM DUAL;');
    expect(result.exit).toBe(false);
    expect(result.output.some(l => l.includes('1'))).toBe(true);
  });

  it('handles EXIT command', async () => {
    const { SQLPlusSession } = await import('@/database/oracle/commands/SQLPlusSession');

    const session = new SQLPlusSession(db);
    session.login('SYS', 'oracle', true);

    const result = session.processLine('EXIT');
    expect(result.exit).toBe(true);
  });

  it('handles SET/SHOW commands', async () => {
    const { SQLPlusSession } = await import('@/database/oracle/commands/SQLPlusSession');

    const session = new SQLPlusSession(db);
    session.login('SYS', 'oracle', true);

    session.processLine('SET LINESIZE 120');
    const result = session.processLine('SHOW LINESIZE');
    expect(result.output.some(l => l.includes('120'))).toBe(true);
  });

  it('handles SHOW USER', async () => {
    const { SQLPlusSession } = await import('@/database/oracle/commands/SQLPlusSession');

    const session = new SQLPlusSession(db);
    session.login('SYS', 'oracle', true);

    const result = session.processLine('SHOW USER');
    expect(result.output.some(l => l.includes('SYS'))).toBe(true);
  });

  it('handles multi-line SQL input', async () => {
    const { SQLPlusSession } = await import('@/database/oracle/commands/SQLPlusSession');

    const session = new SQLPlusSession(db);
    session.login('SYS', 'oracle', true);

    // First line without semicolon — should ask for more input
    const r1 = session.processLine('SELECT 1');
    expect(r1.needsMoreInput).toBe(true);

    // Complete with semicolon
    const r2 = session.processLine('FROM DUAL;');
    expect(r2.needsMoreInput).toBe(false);
    expect(r2.output.some(l => l.includes('1'))).toBe(true);
  });
});
