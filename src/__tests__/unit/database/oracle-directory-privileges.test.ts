import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import type { OracleExecutor } from '../../../database/oracle/OracleExecutor';

let db: OracleDatabase;
let sys: OracleExecutor;

function exec(sql: string, on: OracleExecutor = sys) {
  return db.executeSql(on, sql);
}

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  sys = db.connectAsSysdba().executor;
  exec("CREATE DIRECTORY ext_dir AS '/home/oracle/files'");
  exec('CREATE USER alice IDENTIFIED BY pw');
  exec('GRANT CREATE SESSION TO alice');
  exec('CREATE USER bob IDENTIFIED BY pw');
  exec('GRANT CREATE SESSION TO bob');
});

describe('GRANT/REVOKE on directory objects', () => {
  test('GRANT READ ON DIRECTORY shows up in DBA_TAB_PRIVS as a DIRECTORY grant', () => {
    exec('GRANT READ ON DIRECTORY ext_dir TO alice');
    const rows = exec("SELECT GRANTEE, OWNER, TABLE_NAME, PRIVILEGE, TYPE FROM DBA_TAB_PRIVS WHERE TABLE_NAME = 'EXT_DIR'").rows;
    const row = rows.find(r => r[0] === 'ALICE');
    expect(row).toBeDefined();
    expect(row).toEqual(['ALICE', 'SYS', 'EXT_DIR', 'READ', 'DIRECTORY']);
  });

  test('GRANT READ, WRITE records both privileges', () => {
    exec('GRANT READ, WRITE ON DIRECTORY ext_dir TO alice');
    const privs = exec("SELECT PRIVILEGE FROM DBA_TAB_PRIVS WHERE TABLE_NAME = 'EXT_DIR' AND GRANTEE = 'ALICE'")
      .rows.map(r => r[0]).sort();
    expect(privs).toEqual(['READ', 'WRITE']);
  });

  test('WITH GRANT OPTION is reflected in GRANTABLE', () => {
    exec('GRANT WRITE ON DIRECTORY ext_dir TO alice WITH GRANT OPTION');
    const row = exec("SELECT GRANTABLE FROM DBA_TAB_PRIVS WHERE TABLE_NAME = 'EXT_DIR' AND GRANTEE = 'ALICE'").rows[0];
    expect(row[0]).toBe('YES');
  });

  test('REVOKE removes the directory grant', () => {
    exec('GRANT READ ON DIRECTORY ext_dir TO alice');
    exec('REVOKE READ ON DIRECTORY ext_dir FROM alice');
    const rows = exec("SELECT * FROM DBA_TAB_PRIVS WHERE TABLE_NAME = 'EXT_DIR' AND GRANTEE = 'ALICE'").rows;
    expect(rows.length).toBe(0);
  });

  test('granting on an unknown directory raises ORA-04043', () => {
    expect(() => exec('GRANT READ ON DIRECTORY no_such_dir TO alice')).toThrow(/4043|does not exist/i);
  });
});

describe('Directory grant authorization', () => {
  test('a user without WITH GRANT OPTION cannot grant the directory privilege', () => {
    const alice = db.connect('alice', 'pw').executor;
    expect(() => exec('GRANT READ ON DIRECTORY ext_dir TO bob', alice))
      .toThrow(/1031|insufficient privileges/i);
  });

  test('a grantee WITH GRANT OPTION can pass the directory privilege on', () => {
    exec('GRANT READ ON DIRECTORY ext_dir TO alice WITH GRANT OPTION');
    const alice = db.connect('alice', 'pw').executor;
    expect(() => exec('GRANT READ ON DIRECTORY ext_dir TO bob', alice)).not.toThrow();
    const rows = exec("SELECT GRANTEE FROM DBA_TAB_PRIVS WHERE TABLE_NAME = 'EXT_DIR'").rows.map(r => r[0]);
    expect(rows).toContain('BOB');
  });
});
