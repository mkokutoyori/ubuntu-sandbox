/**
 * Section 5 — Runtime privilege enforcement.
 *
 * Verifies that PrivilegeChecker is actually consulted when a session
 * tries to perform a privileged operation. Without these checks the
 * security catalog is decorative.
 *
 *  - CREATE SESSION required at connect()
 *  - CREATE TABLE / CREATE VIEW / CREATE SEQUENCE require the matching priv
 *  - DROP TABLE on another schema requires DROP ANY TABLE
 *  - SELECT on another schema's table requires SELECT (or SELECT ANY TABLE)
 *  - DDL on users requires CREATE USER / ALTER USER / DROP USER
 *  - SYSDBA bypasses every check
 *  - DBA role implies every privilege
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { OracleExecutor } from '@/database/oracle/OracleExecutor';

let db: OracleDatabase;
let sys: OracleExecutor;

function setup() {
  db = new OracleDatabase('test-device');
  db.instance.startup();
  sys = db.connectAsSysdba().executor;
}

function execSys(sql: string) {
  const rs = db.executeSql(sys, sql);
  if (rs.error) throw new Error(rs.error);
  return rs;
}

function connectAs(user: string, pwd: string): OracleExecutor {
  return db.connect(user, pwd).executor;
}

function execAs(executor: OracleExecutor, sql: string) {
  const rs = db.executeSql(executor, sql);
  if (rs.error) throw new Error(rs.error);
  return rs;
}

// ── CREATE SESSION enforcement ────────────────────────────────────────────────

describe('CREATE SESSION enforcement', () => {
  beforeEach(setup);

  it('connect fails without CREATE SESSION privilege', () => {
    execSys("CREATE USER nosession IDENTIFIED BY pass");
    expect(() => db.connect('NOSESSION', 'pass')).toThrow(/ORA-01045/);
  });

  it('connect succeeds after GRANT CREATE SESSION', () => {
    execSys("CREATE USER hassession IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION TO hassession");
    const { sid } = db.connect('HASSESSION', 'pass');
    expect(sid).toBeGreaterThan(0);
    db.disconnect(sid);
  });

  it('CREATE SESSION via CONNECT role is sufficient', () => {
    execSys("CREATE USER roleuser IDENTIFIED BY pass");
    execSys("GRANT CONNECT TO roleuser");
    // CONNECT role must include CREATE SESSION
    const { sid } = db.connect('ROLEUSER', 'pass');
    expect(sid).toBeGreaterThan(0);
    db.disconnect(sid);
  });

  it('SYSDBA bypasses CREATE SESSION check', () => {
    // SYS has no explicit CREATE SESSION needed via SYSDBA path
    const { sid } = db.connectAsSysdba();
    expect(sid).toBeGreaterThan(0);
    db.disconnect(sid);
  });
});

// ── CREATE TABLE enforcement ──────────────────────────────────────────────────

describe('CREATE TABLE enforcement', () => {
  beforeEach(setup);

  it('CREATE TABLE fails without CREATE TABLE priv', () => {
    execSys("CREATE USER noprivs IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION TO noprivs");
    const user = connectAs('NOPRIVS', 'pass');
    expect(() => execAs(user, "CREATE TABLE t1 (id NUMBER)")).toThrow(/ORA-01031/);
  });

  it('CREATE TABLE succeeds with explicit privilege', () => {
    execSys("CREATE USER tabuser IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION TO tabuser");
    execSys("GRANT CREATE TABLE TO tabuser");
    execSys("GRANT UNLIMITED TABLESPACE TO tabuser");
    const user = connectAs('TABUSER', 'pass');
    const rs = execAs(user, "CREATE TABLE t1 (id NUMBER)");
    expect(rs.error).toBeUndefined();
  });

  it('SYSDBA can CREATE TABLE without explicit grant', () => {
    execSys("CREATE TABLE sys_table (id NUMBER)");
    // No error
  });

  it('user with DBA role can CREATE TABLE', () => {
    execSys("CREATE USER dbau IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION TO dbau");
    execSys("GRANT DBA TO dbau");
    const user = connectAs('DBAU', 'pass');
    const rs = execAs(user, "CREATE TABLE dba_owned (id NUMBER)");
    expect(rs.error).toBeUndefined();
  });
});

// ── DROP TABLE enforcement ────────────────────────────────────────────────────

describe('DROP TABLE enforcement', () => {
  beforeEach(setup);

  it('user can DROP their own table', () => {
    execSys("CREATE USER owner1 IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO owner1");
    const user = connectAs('OWNER1', 'pass');
    execAs(user, "CREATE TABLE mine (id NUMBER)");
    const rs = execAs(user, "DROP TABLE mine");
    expect(rs.error).toBeUndefined();
  });

  it('user cannot DROP another schema\'s table without DROP ANY TABLE', () => {
    execSys("CREATE USER ownerA IDENTIFIED BY pass");
    execSys("CREATE USER ownerB IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO ownerA");
    execSys("GRANT CREATE SESSION TO ownerB");
    const a = connectAs('OWNERA', 'pass');
    execAs(a, "CREATE TABLE shared_t (id NUMBER)");

    const b = connectAs('OWNERB', 'pass');
    expect(() => execAs(b, "DROP TABLE ownerA.shared_t")).toThrow(/ORA-01031|ORA-00942/);
  });

  it('DROP ANY TABLE grants permission across schemas', () => {
    execSys("CREATE USER killerA IDENTIFIED BY pass");
    execSys("CREATE USER killerB IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO killerA");
    execSys("GRANT CREATE SESSION, DROP ANY TABLE TO killerB");
    const a = connectAs('KILLERA', 'pass');
    execAs(a, "CREATE TABLE droppable (id NUMBER)");

    const b = connectAs('KILLERB', 'pass');
    const rs = execAs(b, "DROP TABLE killerA.droppable");
    expect(rs.error).toBeUndefined();
  });
});

// ── CREATE/ALTER/DROP USER enforcement ────────────────────────────────────────

describe('User-management DDL enforcement', () => {
  beforeEach(setup);

  it('CREATE USER fails without CREATE USER priv', () => {
    execSys("CREATE USER nonadmin IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION TO nonadmin");
    const user = connectAs('NONADMIN', 'pass');
    expect(() => execAs(user, "CREATE USER newone IDENTIFIED BY pass")).toThrow(/ORA-01031/);
  });

  it('CREATE USER succeeds with CREATE USER priv', () => {
    execSys("CREATE USER admin1 IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION, CREATE USER TO admin1");
    const user = connectAs('ADMIN1', 'pass');
    const rs = execAs(user, "CREATE USER created_by_admin IDENTIFIED BY p");
    expect(rs.error).toBeUndefined();
  });

  it('DROP USER fails without DROP USER priv', () => {
    execSys("CREATE USER baduser IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION TO baduser");
    execSys("CREATE USER victim IDENTIFIED BY pass");
    const user = connectAs('BADUSER', 'pass');
    expect(() => execAs(user, "DROP USER victim")).toThrow(/ORA-01031/);
  });

  it('ALTER USER fails without ALTER USER priv (other user)', () => {
    execSys("CREATE USER changer IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION TO changer");
    execSys("CREATE USER target IDENTIFIED BY pass");
    const user = connectAs('CHANGER', 'pass');
    expect(() => execAs(user, "ALTER USER target IDENTIFIED BY newpass")).toThrow(/ORA-01031/);
  });

  it('user can ALTER their own password without ALTER USER priv', () => {
    execSys("CREATE USER selfchange IDENTIFIED BY oldpass");
    execSys("GRANT CREATE SESSION TO selfchange");
    const user = connectAs('SELFCHANGE', 'oldpass');
    const rs = execAs(user, "ALTER USER selfchange IDENTIFIED BY newpass");
    expect(rs.error).toBeUndefined();
  });
});

// ── GRANT enforcement ─────────────────────────────────────────────────────────

describe('GRANT enforcement', () => {
  beforeEach(setup);

  it('non-DBA cannot GRANT system privilege', () => {
    execSys("CREATE USER granter IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION TO granter");
    execSys("CREATE USER receiver IDENTIFIED BY pass");
    const user = connectAs('GRANTER', 'pass');
    expect(() => execAs(user, "GRANT CREATE TABLE TO receiver")).toThrow(/ORA-01031/);
  });

  it('user with GRANT ANY PRIVILEGE can GRANT', () => {
    execSys("CREATE USER grantor IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION, GRANT ANY PRIVILEGE TO grantor");
    execSys("CREATE USER target2 IDENTIFIED BY pass");
    const user = connectAs('GRANTOR', 'pass');
    const rs = execAs(user, "GRANT CREATE TABLE TO target2");
    expect(rs.error).toBeUndefined();
  });
});

// ── SELECT enforcement on cross-schema reads ──────────────────────────────────

describe('SELECT cross-schema enforcement', () => {
  beforeEach(setup);

  it('user cannot SELECT from another schema\'s table without grant', () => {
    execSys("CREATE USER schemaA IDENTIFIED BY pass");
    execSys("CREATE USER schemaB IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO schemaA");
    execSys("GRANT CREATE SESSION TO schemaB");
    const a = connectAs('SCHEMAA', 'pass');
    execAs(a, "CREATE TABLE secret (id NUMBER)");

    const b = connectAs('SCHEMAB', 'pass');
    expect(() => execAs(b, "SELECT * FROM schemaA.secret")).toThrow(/ORA-00942|ORA-01031/);
  });

  it('user can SELECT after GRANT SELECT', () => {
    execSys("CREATE USER ownerS IDENTIFIED BY pass");
    execSys("CREATE USER readerS IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO ownerS");
    execSys("GRANT CREATE SESSION TO readerS");
    const owner = connectAs('OWNERS', 'pass');
    execAs(owner, "CREATE TABLE shared_data (id NUMBER)");
    execAs(owner, "INSERT INTO shared_data VALUES (1)");
    execAs(owner, "COMMIT");
    execSys("GRANT SELECT ON ownerS.shared_data TO readerS");

    const reader = connectAs('READERS', 'pass');
    const rs = execAs(reader, "SELECT * FROM ownerS.shared_data");
    expect(rs.rows?.length).toBe(1);
  });

  it('SELECT ANY TABLE allows reading any schema', () => {
    execSys("CREATE USER ownerT IDENTIFIED BY pass");
    execSys("CREATE USER readanyT IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO ownerT");
    execSys("GRANT CREATE SESSION, SELECT ANY TABLE TO readanyT");
    const owner = connectAs('OWNERT', 'pass');
    execAs(owner, "CREATE TABLE any_data (id NUMBER)");
    execAs(owner, "INSERT INTO any_data VALUES (42)");
    execAs(owner, "COMMIT");

    const reader = connectAs('READANYT', 'pass');
    const rs = execAs(reader, "SELECT * FROM ownerT.any_data");
    expect(rs.rows?.length).toBe(1);
  });
});

// ── INSERT/UPDATE/DELETE enforcement ──────────────────────────────────────────

describe('DML cross-schema enforcement', () => {
  beforeEach(setup);

  it('INSERT into another schema requires INSERT priv', () => {
    execSys("CREATE USER tabowner IDENTIFIED BY pass");
    execSys("CREATE USER writer IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO tabowner");
    execSys("GRANT CREATE SESSION TO writer");
    const owner = connectAs('TABOWNER', 'pass');
    execAs(owner, "CREATE TABLE wtbl (id NUMBER)");

    const w = connectAs('WRITER', 'pass');
    expect(() => execAs(w, "INSERT INTO tabowner.wtbl VALUES (1)")).toThrow(/ORA-00942|ORA-01031/);
  });

  it('INSERT succeeds after GRANT INSERT', () => {
    execSys("CREATE USER tabowner2 IDENTIFIED BY pass");
    execSys("CREATE USER writer2 IDENTIFIED BY pass");
    execSys("GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO tabowner2");
    execSys("GRANT CREATE SESSION TO writer2");
    const owner = connectAs('TABOWNER2', 'pass');
    execAs(owner, "CREATE TABLE wtbl2 (id NUMBER)");
    execSys("GRANT INSERT ON tabowner2.wtbl2 TO writer2");

    const w = connectAs('WRITER2', 'pass');
    const rs = execAs(w, "INSERT INTO tabowner2.wtbl2 VALUES (1)");
    expect(rs.error).toBeUndefined();
  });
});
