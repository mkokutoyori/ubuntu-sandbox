/**
 * External tables (ORGANIZATION EXTERNAL / ORACLE_LOADER) reading real data
 * from the host filesystem through a directory object.
 *
 * Previously CREATE TABLE … ORGANIZATION EXTERNAL only registered catalog
 * metadata: SELECT * FROM the table returned nothing (the data file on the
 * host was never read). These tests pin the real behaviour — the location
 * file is read via the directory and parsed into typed rows — and the
 * read-on-query semantics (a later edit to the host file shows up on the
 * next SELECT).
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import type { OracleExecutor } from '../../../database/oracle/OracleExecutor';

let db: OracleDatabase;
let sys: OracleExecutor;
let hostFiles: Map<string, string>;

function exec(sql: string) {
  return db.executeSql(sys, sql);
}

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  hostFiles = new Map();
  db.instance.setDeviceFileReader((p) => (hostFiles.has(p) ? hostFiles.get(p)! : null));
  db.instance.setDeviceFileWriter((p, c) => { hostFiles.set(p, c); return true; });
  db.instance.setDeviceFileRemover((p) => hostFiles.delete(p));
  sys = db.connectAsSysdba().executor;
  exec("CREATE DIRECTORY ext_dir AS '/home/oracle/load'");
});

describe('External table data read', () => {
  test('SELECT reads and types rows from the host CSV file', () => {
    hostFiles.set('/home/oracle/load/emp.csv', '7369,SMITH,800\n7499,ALLEN,1600\n');
    exec(`CREATE TABLE emp_ext (empno NUMBER, ename VARCHAR2(20), sal NUMBER)
            ORGANIZATION EXTERNAL (TYPE ORACLE_LOADER DEFAULT DIRECTORY ext_dir
            ACCESS PARAMETERS (FIELDS TERMINATED BY ',') LOCATION ('emp.csv'))`);
    const r = exec('SELECT empno, ename, sal FROM emp_ext ORDER BY empno');
    expect(r.rows.length).toBe(2);
    expect(r.rows[0]).toEqual([7369, 'SMITH', 800]);
    expect(r.rows[1]).toEqual([7499, 'ALLEN', 1600]);
  });

  test('numeric columns are returned as numbers (aggregable)', () => {
    hostFiles.set('/home/oracle/load/nums.csv', '10\n20\n30\n');
    exec(`CREATE TABLE n_ext (v NUMBER) ORGANIZATION EXTERNAL
            (TYPE ORACLE_LOADER DEFAULT DIRECTORY ext_dir
             ACCESS PARAMETERS (FIELDS TERMINATED BY ',') LOCATION ('nums.csv'))`);
    const r = exec('SELECT SUM(v) FROM n_ext');
    expect(r.rows[0][0]).toBe(60);
  });

  test('read-on-query: a later edit to the host file is reflected', () => {
    hostFiles.set('/home/oracle/load/live.csv', 'a\n');
    exec(`CREATE TABLE live_ext (s VARCHAR2(10)) ORGANIZATION EXTERNAL
            (TYPE ORACLE_LOADER DEFAULT DIRECTORY ext_dir
             ACCESS PARAMETERS (FIELDS TERMINATED BY ',') LOCATION ('live.csv'))`);
    expect(exec('SELECT COUNT(*) FROM live_ext').rows[0][0]).toBe(1);
    hostFiles.set('/home/oracle/load/live.csv', 'a\nb\nc\n');
    expect(exec('SELECT COUNT(*) FROM live_ext').rows[0][0]).toBe(3);
  });

  test('SKIP skips header lines', () => {
    hostFiles.set('/home/oracle/load/h.csv', 'ID,NAME\n1,one\n2,two\n');
    exec(`CREATE TABLE h_ext (id NUMBER, name VARCHAR2(10)) ORGANIZATION EXTERNAL
            (TYPE ORACLE_LOADER DEFAULT DIRECTORY ext_dir
             ACCESS PARAMETERS (FIELDS TERMINATED BY ',' SKIP 1) LOCATION ('h.csv'))`);
    const r = exec('SELECT id, name FROM h_ext ORDER BY id');
    expect(r.rows.length).toBe(2);
    expect(r.rows[0]).toEqual([1, 'one']);
  });

  test('enclosed fields keep embedded delimiters', () => {
    hostFiles.set('/home/oracle/load/q.csv', '1,"Smith, John"\n');
    exec(`CREATE TABLE q_ext (id NUMBER, name VARCHAR2(40)) ORGANIZATION EXTERNAL
            (TYPE ORACLE_LOADER DEFAULT DIRECTORY ext_dir
             ACCESS PARAMETERS (FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '"')
             LOCATION ('q.csv'))`);
    const r = exec('SELECT name FROM q_ext');
    expect(r.rows[0][0]).toBe('Smith, John');
  });

  test('a WHERE clause filters external rows like an ordinary table', () => {
    hostFiles.set('/home/oracle/load/f.csv', '1,lo\n2,hi\n3,hi\n');
    exec(`CREATE TABLE f_ext (id NUMBER, g VARCHAR2(4)) ORGANIZATION EXTERNAL
            (TYPE ORACLE_LOADER DEFAULT DIRECTORY ext_dir
             ACCESS PARAMETERS (FIELDS TERMINATED BY ',') LOCATION ('f.csv'))`);
    const r = exec("SELECT COUNT(*) FROM f_ext WHERE g = 'hi'");
    expect(r.rows[0][0]).toBe(2);
  });

  test('a missing data file reads as an empty table (no error)', () => {
    exec(`CREATE TABLE miss_ext (s VARCHAR2(10)) ORGANIZATION EXTERNAL
            (TYPE ORACLE_LOADER DEFAULT DIRECTORY ext_dir
             ACCESS PARAMETERS (FIELDS TERMINATED BY ',') LOCATION ('nope.csv'))`);
    const r = exec('SELECT COUNT(*) FROM miss_ext');
    expect(r.rows[0][0]).toBe(0);
  });
});

describe('External table catalog coherence', () => {
  test('the table appears in DBA_EXTERNAL_TABLES', () => {
    hostFiles.set('/home/oracle/load/c.csv', '1\n');
    exec(`CREATE TABLE cat_ext (v NUMBER) ORGANIZATION EXTERNAL
            (TYPE ORACLE_LOADER DEFAULT DIRECTORY ext_dir
             ACCESS PARAMETERS (FIELDS TERMINATED BY ',') LOCATION ('c.csv'))`);
    const r = exec("SELECT TABLE_NAME, DEFAULT_DIRECTORY_NAME FROM DBA_EXTERNAL_TABLES WHERE TABLE_NAME='CAT_EXT'");
    expect(r.rows.length).toBe(1);
    expect(r.rows[0][1]).toBe('EXT_DIR');
  });

  test('DROP removes the table and its external metadata', () => {
    hostFiles.set('/home/oracle/load/d.csv', '1\n');
    exec(`CREATE TABLE drop_ext (v NUMBER) ORGANIZATION EXTERNAL
            (TYPE ORACLE_LOADER DEFAULT DIRECTORY ext_dir
             ACCESS PARAMETERS (FIELDS TERMINATED BY ',') LOCATION ('d.csv'))`);
    exec('DROP TABLE drop_ext');
    const r = exec("SELECT COUNT(*) FROM DBA_EXTERNAL_TABLES WHERE TABLE_NAME='DROP_EXT'");
    expect(r.rows[0][0]).toBe(0);
  });
});
