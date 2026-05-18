/**
 * Section 6 — Additional authentication methods.
 *
 *  - IDENTIFIED EXTERNALLY: OS auth (no password; user's OS identity must match)
 *  - IDENTIFIED GLOBALLY AS '<dn>': directory-server auth (LDAP/Kerberos placeholder)
 *  - AS SYSOPER: limited admin role
 *  - SYSDBA / SYSOPER honour the OS group membership (`isDbaGroup`)
 *  - DBA_USERS.AUTHENTICATION_TYPE reflects the chosen method
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import type { OracleExecutor } from '@/database/oracle/OracleExecutor';
import type { OsSecurityContext } from '@/database/oracle/security/types';

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

// ── IDENTIFIED EXTERNALLY ─────────────────────────────────────────────────────

describe('IDENTIFIED EXTERNALLY (OS authentication)', () => {
  beforeEach(setup);

  it('CREATE USER ... IDENTIFIED EXTERNALLY parses and stores EXTERNAL type', () => {
    execSys("CREATE USER ops$alice IDENTIFIED EXTERNALLY");
    execSys("GRANT CREATE SESSION TO ops$alice");

    const rs = execSys("SELECT USERNAME, AUTHENTICATION_TYPE FROM DBA_USERS WHERE USERNAME='OPS$ALICE'");
    expect(rs.rows?.length).toBe(1);
    expect(rs.rows![0][1]).toBe('EXTERNAL');
  });

  it('EXTERNAL user connects when OS identity matches (prefix OPS$ + osUser)', () => {
    execSys("CREATE USER ops$bob IDENTIFIED EXTERNALLY");
    execSys("GRANT CREATE SESSION TO ops$bob");

    const osCtx: OsSecurityContext = {
      osUser: 'bob', osGroup: 'oracle', isDbaGroup: false,
      hostname: 'h', terminal: 'pts/0', program: 'sqlplus',
    };
    const { sid } = db.connect('OPS$BOB', '', osCtx);
    expect(sid).toBeGreaterThan(0);
    db.disconnect(sid);
  });

  it('EXTERNAL user connect fails when OS user does not match', () => {
    execSys("CREATE USER ops$carol IDENTIFIED EXTERNALLY");
    execSys("GRANT CREATE SESSION TO ops$carol");

    const osCtx: OsSecurityContext = {
      osUser: 'mallory', osGroup: 'oracle', isDbaGroup: false,
      hostname: 'h', terminal: 'pts/0', program: 'sqlplus',
    };
    expect(() => db.connect('OPS$CAROL', '', osCtx)).toThrow(/ORA-01017/);
  });

  it('EXTERNAL user with any password is rejected (no password stored)', () => {
    execSys("CREATE USER ops$dan IDENTIFIED EXTERNALLY");
    execSys("GRANT CREATE SESSION TO ops$dan");
    // Connecting with a wrong OS user — password ignored either way
    const wrongOs: OsSecurityContext = {
      osUser: 'wrong', osGroup: 'oracle', isDbaGroup: false,
      hostname: 'h', terminal: 'pts/0', program: 'sqlplus',
    };
    expect(() => db.connect('OPS$DAN', 'anyPassword', wrongOs)).toThrow(/ORA-01017/);
  });
});

// ── IDENTIFIED GLOBALLY ───────────────────────────────────────────────────────

describe('IDENTIFIED GLOBALLY (directory authentication)', () => {
  beforeEach(setup);

  it("CREATE USER ... IDENTIFIED GLOBALLY AS '<dn>' parses and stores GLOBAL type", () => {
    execSys("CREATE USER global_alice IDENTIFIED GLOBALLY AS 'CN=alice,OU=people,DC=example,DC=com'");

    const rs = execSys("SELECT AUTHENTICATION_TYPE FROM DBA_USERS WHERE USERNAME='GLOBAL_ALICE'");
    expect(rs.rows?.[0]?.[0]).toBe('GLOBAL');
  });

  it('GLOBAL user without DN bound still cannot password-login', () => {
    execSys("CREATE USER global_bob IDENTIFIED GLOBALLY AS 'CN=bob,DC=example,DC=com'");
    execSys("GRANT CREATE SESSION TO global_bob");
    expect(() => db.connect('GLOBAL_BOB', 'anything')).toThrow(/ORA-01017/);
  });
});

// ── AS SYSOPER ────────────────────────────────────────────────────────────────

describe('AS SYSOPER', () => {
  beforeEach(setup);

  it('connectAsSysoper returns a sid and an executor', () => {
    const result = db.connectAsSysoper();
    expect(result.sid).toBeGreaterThan(0);
    expect(result.executor).toBeDefined();
    db.disconnect(result.sid);
  });

  it('SYSOPER session shows username PUBLIC in V$SESSION', () => {
    const { sid, executor } = db.connectAsSysoper();
    const rs = db.executeSql(executor, "SELECT SID, USERNAME FROM V$SESSION WHERE SID = " + sid);
    const u = rs.rows?.[0]?.[1];
    expect(u).toBe('PUBLIC');
    db.disconnect(sid);
  });

  it('SYSOPER can STARTUP/SHUTDOWN-style ALTER SYSTEM but cannot SELECT user data', () => {
    // Create a normal user table
    execSys("CREATE TABLE secret_data (id NUMBER)");
    execSys("INSERT INTO secret_data VALUES (1)");
    execSys("COMMIT");

    const { sid, executor } = db.connectAsSysoper();
    // SYSOPER can do ALTER SYSTEM (allowed)
    expect(() => db.executeSql(executor, "ALTER SYSTEM ARCHIVE LOG CURRENT")).not.toThrow();
    // SYSOPER cannot read application data in another schema
    expect(() => db.executeSql(executor, "SELECT * FROM SYS.secret_data")).toThrow(/ORA-00942|ORA-01031/);
    db.disconnect(sid);
  });
});

// ── OS group membership for SYSDBA ────────────────────────────────────────────

describe('SYSDBA requires OS dba group membership', () => {
  beforeEach(setup);

  it('connectAsSysdba succeeds when isDbaGroup=true', () => {
    const ctx: OsSecurityContext = {
      osUser: 'oracle', osGroup: 'dba', isDbaGroup: true,
      hostname: 'h', terminal: 'pts/0', program: 'sqlplus',
    };
    const { sid } = db.connectAsSysdba(ctx);
    expect(sid).toBeGreaterThan(0);
    db.disconnect(sid);
  });

  it('connectAsSysdba fails when isDbaGroup=false', () => {
    const ctx: OsSecurityContext = {
      osUser: 'webuser', osGroup: 'www-data', isDbaGroup: false,
      hostname: 'h', terminal: 'pts/0', program: 'sqlplus',
    };
    expect(() => db.connectAsSysdba(ctx)).toThrow(/ORA-01031/);
  });

  it('SYSOPER also requires dba group membership', () => {
    const ctx: OsSecurityContext = {
      osUser: 'webuser', osGroup: 'www-data', isDbaGroup: false,
      hostname: 'h', terminal: 'pts/0', program: 'sqlplus',
    };
    expect(() => db.connectAsSysoper(ctx)).toThrow(/ORA-01031/);
  });
});
