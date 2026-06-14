/**
 * Directory objects — CREATE [OR REPLACE] / DROP DIRECTORY and their
 * projection into the live DBA_DIRECTORIES / ALL_DIRECTORIES dictionary
 * views. Replaces the former canned DBA_DIRECTORIES (a single hardcoded
 * DATA_PUMP_DIR row) with a real catalog-backed object — the foundation
 * UTL_FILE, external tables, and Data Pump resolve their paths against.
 */

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
});

describe('CREATE DIRECTORY', () => {
  test('registers a SYS-owned directory visible in DBA_DIRECTORIES', () => {
    exec("CREATE DIRECTORY ext_dir AS '/home/oracle/files'");
    const rows = exec('SELECT OWNER, DIRECTORY_NAME, DIRECTORY_PATH FROM DBA_DIRECTORIES').rows;
    const row = rows.find(r => r[1] === 'EXT_DIR');
    expect(row).toBeDefined();
    expect(row![0]).toBe('SYS');
    expect(row![2]).toBe('/home/oracle/files');
  });

  test('the default DATA_PUMP_DIR is still present', () => {
    const rows = exec('SELECT DIRECTORY_NAME FROM DBA_DIRECTORIES').rows;
    expect(rows.some(r => r[0] === 'DATA_PUMP_DIR')).toBe(true);
  });

  test('directory name is stored uppercase', () => {
    exec("CREATE DIRECTORY mixedCase AS '/tmp/x'");
    const rows = exec('SELECT DIRECTORY_NAME FROM DBA_DIRECTORIES').rows;
    expect(rows.some(r => r[0] === 'MIXEDCASE')).toBe(true);
  });

  test('CREATE without OR REPLACE on an existing name raises ORA-00955', () => {
    exec("CREATE DIRECTORY dup_dir AS '/a'");
    expect(() => exec("CREATE DIRECTORY dup_dir AS '/b'")).toThrow(/955|already used/i);
  });

  test('CREATE OR REPLACE rebinds the path in place', () => {
    exec("CREATE DIRECTORY rep_dir AS '/old/path'");
    exec("CREATE OR REPLACE DIRECTORY rep_dir AS '/new/path'");
    const rows = exec('SELECT DIRECTORY_PATH FROM DBA_DIRECTORIES').rows;
    const paths = rows.map(r => r[0]);
    expect(paths).toContain('/new/path');
    expect(paths).not.toContain('/old/path');
  });
});

describe('DROP DIRECTORY', () => {
  test('removes the directory from the dictionary', () => {
    exec("CREATE DIRECTORY gone_dir AS '/tmp/gone'");
    exec('DROP DIRECTORY gone_dir');
    const rows = exec('SELECT DIRECTORY_NAME FROM DBA_DIRECTORIES').rows;
    expect(rows.some(r => r[0] === 'GONE_DIR')).toBe(false);
  });

  test('dropping an unknown directory raises ORA-04043', () => {
    expect(() => exec('DROP DIRECTORY nope_dir')).toThrow(/4043|does not exist/i);
  });
});

describe('ALL_DIRECTORIES', () => {
  test('exposes the same directories as DBA_DIRECTORIES', () => {
    exec("CREATE DIRECTORY all_dir AS '/srv/all'");
    const rows = exec('SELECT DIRECTORY_NAME, DIRECTORY_PATH FROM ALL_DIRECTORIES').rows;
    const row = rows.find(r => r[0] === 'ALL_DIR');
    expect(row).toBeDefined();
    expect(row![1]).toBe('/srv/all');
  });
});

describe('Directory objects in DBA_OBJECTS', () => {
  test('a created directory appears as a SYS-owned DIRECTORY object', () => {
    exec("CREATE DIRECTORY obj_dir AS '/srv/obj'");
    const rows = exec("SELECT OWNER, OBJECT_TYPE FROM DBA_OBJECTS WHERE OBJECT_NAME = 'OBJ_DIR'").rows;
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual(['SYS', 'DIRECTORY']);
  });

  test('DATA_PUMP_DIR is reported as Oracle-maintained', () => {
    const rows = exec("SELECT ORACLE_MAINTAINED FROM DBA_OBJECTS WHERE OBJECT_NAME = 'DATA_PUMP_DIR' AND OBJECT_TYPE = 'DIRECTORY'").rows;
    expect(rows[0][0]).toBe('Y');
  });

  test('DROP DIRECTORY removes it from DBA_OBJECTS', () => {
    exec("CREATE DIRECTORY temp_obj_dir AS '/srv/tmp'");
    exec('DROP DIRECTORY temp_obj_dir');
    const rows = exec("SELECT COUNT(*) FROM DBA_OBJECTS WHERE OBJECT_NAME = 'TEMP_OBJ_DIR'").rows;
    expect(rows[0][0]).toBe(0);
  });
});

describe('Directory DDL privileges', () => {
  test('a user without CREATE ANY DIRECTORY gets ORA-01031', () => {
    exec("CREATE USER dirless IDENTIFIED BY pass");
    exec('GRANT CREATE SESSION TO dirless');
    const user = db.connect('dirless', 'pass').executor;
    expect(() => exec("CREATE DIRECTORY nope AS '/x'", user)).toThrow(/1031|insufficient privileges/i);
  });

  test('granting CREATE ANY DIRECTORY lets the user create one', () => {
    exec("CREATE USER dirful IDENTIFIED BY pass");
    exec('GRANT CREATE SESSION TO dirful');
    exec('GRANT CREATE ANY DIRECTORY TO dirful');
    const user = db.connect('dirful', 'pass').executor;
    expect(() => exec("CREATE DIRECTORY user_dir AS '/u/d'", user)).not.toThrow();
    const rows = exec('SELECT DIRECTORY_NAME FROM DBA_DIRECTORIES').rows;
    expect(rows.some(r => r[0] === 'USER_DIR')).toBe(true);
  });
});
