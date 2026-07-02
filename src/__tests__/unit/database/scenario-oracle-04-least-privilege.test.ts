/**
 * Scenario 4 — privilege and role management: three profiles (read-only
 * application user, schema-limited DBA, full DBA), each tried against
 * SELECT / INSERT / DDL / DBA-view access, plus an immediate mid-session
 * revoke while the session stays open.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { OracleExecutor } from '@/database/oracle/OracleExecutor';

let db: OracleDatabase;
let sys: OracleExecutor;

function setup() {
  db = new OracleDatabase('scenario4-device');
  db.instance.startup();
  sys = db.connectAsSysdba().executor;
}

function execSys(sqlText: string) {
  const rs = db.executeSql(sys, sqlText);
  if (rs.error) throw new Error(rs.error);
  return rs;
}

function connectAs(user: string, pwd: string) {
  return db.connect(user, pwd);
}

function execAs(executor: OracleExecutor, sqlText: string) {
  return db.executeSql(executor, sqlText);
}

function expectFails(executor: OracleExecutor, sqlText: string, code: string) {
  expect(() => execAs(executor, sqlText)).toThrow(new RegExp(code));
}

function expectOk(executor: OracleExecutor, sqlText: string) {
  const rs = execAs(executor, sqlText);
  expect(rs.error).toBeUndefined();
  return rs;
}

beforeEach(setup);

describe('read-only application user', () => {
  function makeReadOnlyUser() {
    execSys("CREATE USER appuser IDENTIFIED BY pass1");
    execSys('GRANT CREATE SESSION TO appuser');
    execSys('CREATE USER appschema IDENTIFIED BY pass2');
    execSys('GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO appschema');
    const owner = connectAs('APPSCHEMA', 'pass2').executor;
    execAs(owner, 'CREATE TABLE customers (id NUMBER, name VARCHAR2(30))');
    execAs(owner, "INSERT INTO customers VALUES (1, 'ALICE')");
    execAs(owner, 'COMMIT');
    execSys('GRANT SELECT ON appschema.customers TO appuser');
    return connectAs('APPUSER', 'pass1');
  }

  it('SELECT on the granted table succeeds', () => {
    const { executor } = makeReadOnlyUser();
    const rs = expectOk(executor, 'SELECT name FROM appschema.customers');
    expect(rs.rows.flat().join(',')).toContain('ALICE');
  });

  it('INSERT is refused with ORA-01031 (privilege known to exist but not granted)', () => {
    const { executor } = makeReadOnlyUser();
    expectFails(executor, "INSERT INTO appschema.customers VALUES (2, 'BOB')", 'ORA-01031');
  });

  it('CREATE TABLE (DDL) is refused with ORA-01031', () => {
    const { executor } = makeReadOnlyUser();
    expectFails(executor, 'CREATE TABLE rogue (x NUMBER)', 'ORA-01031');
  });

  it('DBA_USERS / DBA_TABLES are inaccessible to a non-DBA user', () => {
    const { executor } = makeReadOnlyUser();
    expectFails(executor, 'SELECT username FROM dba_users', 'ORA-00942');
    expectFails(executor, 'SELECT table_name FROM dba_tables', 'ORA-00942');
  });

  it('an unrelated table the user was never granted anything on hides behind ORA-00942', () => {
    const { executor } = makeReadOnlyUser();
    execSys('CREATE USER other IDENTIFIED BY pass3');
    execSys('GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO other');
    const other = connectAs('OTHER', 'pass3').executor;
    execAs(other, 'CREATE TABLE secrets (x NUMBER)');
    expectFails(executor, 'SELECT * FROM other.secrets', 'ORA-00942');
  });
});

describe('schema-limited DBA (DDL on own schema only)', () => {
  function makeLimitedDba() {
    execSys('CREATE USER teamlead IDENTIFIED BY pass1');
    execSys('GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, UNLIMITED TABLESPACE TO teamlead');
    return connectAs('TEAMLEAD', 'pass1');
  }

  it('CREATE TABLE in the own schema succeeds', () => {
    const { executor } = makeLimitedDba();
    expectOk(executor, 'CREATE TABLE projects (id NUMBER)');
  });

  it('CREATE TABLE in another schema is refused with ORA-01031', () => {
    const { executor } = makeLimitedDba();
    execSys('CREATE USER otherschema IDENTIFIED BY pass2');
    expectFails(executor, 'CREATE TABLE otherschema.intruder (id NUMBER)', 'ORA-01031');
  });

  it('SELECT against DBA_USERS is refused: no DBA-view access without the DBA role', () => {
    const { executor } = makeLimitedDba();
    expectFails(executor, 'SELECT username FROM dba_users', 'ORA-00942');
  });

  it('DROP TABLE on another schema needs DROP ANY TABLE, not merely CREATE TABLE', () => {
    const { executor } = makeLimitedDba();
    execSys('CREATE USER victim IDENTIFIED BY pass3');
    execSys('GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO victim');
    const victim = connectAs('VICTIM', 'pass3').executor;
    execAs(victim, 'CREATE TABLE assets (x NUMBER)');
    expectFails(executor, 'DROP TABLE victim.assets', 'ORA-01031');
  });
});

describe('full DBA', () => {
  function makeFullDba() {
    execSys('CREATE USER opsroot IDENTIFIED BY pass1');
    execSys('GRANT DBA TO opsroot');
    return connectAs('OPSROOT', 'pass1');
  }

  it('SELECT/INSERT/DDL and DBA views all succeed', () => {
    const { executor } = makeFullDba();
    expectOk(executor, 'CREATE TABLE anything (id NUMBER)');
    expectOk(executor, 'INSERT INTO anything VALUES (1)');
    const users = expectOk(executor, 'SELECT username FROM dba_users');
    expect(users.rows.length).toBeGreaterThan(0);
    const tables = expectOk(executor, 'SELECT table_name FROM dba_tables');
    expect(tables.rows.length).toBeGreaterThan(0);
  });

  it('the DBA role implies privileges granted through it, per DBA_ROLE_PRIVS', () => {
    const rs = execSys("SELECT granted_role FROM dba_role_privs WHERE grantee = 'OPSROOT'");
    expect(rs.rows.flat().join(',')).toBe('');
    makeFullDba();
    const after = execSys("SELECT granted_role FROM dba_role_privs WHERE grantee = 'OPSROOT'");
    expect(after.rows.flat().join(',')).toContain('DBA');
  });
});

describe('DBA_SYS_PRIVS / DBA_TAB_PRIVS reflect the effective privileges of each profile', () => {
  it('the read-only user shows exactly the SELECT object privilege it was granted', () => {
    execSys('CREATE USER viewer IDENTIFIED BY pass1');
    execSys('GRANT CREATE SESSION TO viewer');
    execSys('CREATE USER owner1 IDENTIFIED BY pass2');
    execSys('GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO owner1');
    const owner = connectAs('OWNER1', 'pass2').executor;
    execAs(owner, 'CREATE TABLE reports (id NUMBER)');
    execSys('GRANT SELECT ON owner1.reports TO viewer');

    const tabPrivs = execSys("SELECT privilege FROM dba_tab_privs WHERE grantee = 'VIEWER'");
    expect(tabPrivs.rows.flat().join(',')).toContain('SELECT');

    const sysPrivs = execSys("SELECT privilege FROM dba_sys_privs WHERE grantee = 'VIEWER'");
    expect(sysPrivs.rows.flat().join(',')).toContain('CREATE SESSION');
    expect(sysPrivs.rows.flat().join(',')).not.toContain('CREATE TABLE');
  });
});

describe('revoking a privilege mid-session takes effect immediately without a disconnect', () => {
  it('an active session loses SELECT on its very next statement after REVOKE, and stays connected', () => {
    execSys('CREATE USER owner2 IDENTIFIED BY pass1');
    execSys('GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO owner2');
    const owner = connectAs('OWNER2', 'pass1').executor;
    execAs(owner, 'CREATE TABLE ledger (amount NUMBER)');
    execAs(owner, 'INSERT INTO ledger VALUES (100)');
    execAs(owner, 'COMMIT');

    execSys('CREATE USER analyst IDENTIFIED BY pass2');
    execSys('GRANT CREATE SESSION TO analyst');
    execSys('GRANT SELECT ON owner2.ledger TO analyst');

    const { sid, executor } = connectAs('ANALYST', 'pass2');
    expectOk(executor, 'SELECT amount FROM owner2.ledger');

    execSys('REVOKE SELECT ON owner2.ledger FROM analyst');

    expectFails(executor, 'SELECT amount FROM owner2.ledger', 'ORA-00942');

    const sessions = execSys(
      "SELECT username, status FROM v$session WHERE sid = " + sid
    );
    expect(sessions.rows.length).toBe(1);
    expect(sessions.rows[0][0]).toBe('ANALYST');
    expect(['ACTIVE', 'INACTIVE']).toContain(sessions.rows[0][1]);

    db.disconnect(sid);
  });

  it('DBA_TAB_PRIVS no longer lists the revoked grant, in the same live session', () => {
    execSys('CREATE USER owner3 IDENTIFIED BY pass1');
    execSys('GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO owner3');
    const owner = connectAs('OWNER3', 'pass1').executor;
    execAs(owner, 'CREATE TABLE invoices (id NUMBER)');

    execSys('CREATE USER clerk IDENTIFIED BY pass2');
    execSys('GRANT CREATE SESSION TO clerk');
    execSys('GRANT SELECT ON owner3.invoices TO clerk');
    connectAs('CLERK', 'pass2');

    let privs = execSys("SELECT privilege FROM dba_tab_privs WHERE grantee = 'CLERK'");
    expect(privs.rows.flat().join(',')).toContain('SELECT');

    execSys('REVOKE SELECT ON owner3.invoices FROM clerk');

    privs = execSys("SELECT privilege FROM dba_tab_privs WHERE grantee = 'CLERK'");
    expect(privs.rows.length).toBe(0);
  });
});
