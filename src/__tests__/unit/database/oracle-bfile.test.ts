import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import type { OracleExecutor } from '../../../database/oracle/OracleExecutor';

let db: OracleDatabase;
let sys: OracleExecutor;
let alice: OracleExecutor;
let hostFiles: Map<string, string>;

function exec(sql: string, on: OracleExecutor = sys) {
  return db.executeSql(on, sql);
}

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  hostFiles = new Map();
  db.instance.setDeviceFileReader((p) => (hostFiles.has(p) ? hostFiles.get(p)! : null));
  db.instance.setDeviceFileWriter((p, c) => { hostFiles.set(p, c); return true; });
  db.instance.setDeviceFileRemover((p) => hostFiles.delete(p));
  sys = db.connectAsSysdba().executor;
  (sys as unknown as { context: { serverOutput: boolean } }).context.serverOutput = true;
  exec("CREATE DIRECTORY ext_dir AS '/home/oracle/files'");
  hostFiles.set('/home/oracle/files/a.txt', 'hello');
  exec('CREATE USER alice IDENTIFIED BY pw');
  exec('GRANT CREATE SESSION TO alice');
  alice = db.connect('alice', 'pw').executor;
});

describe('BFILENAME and BFILE columns', () => {
  test('BFILENAME builds a locator that can be stored and read back', () => {
    exec('CREATE TABLE docs (id NUMBER, f BFILE)');
    exec("INSERT INTO docs VALUES (1, BFILENAME('ext_dir', 'a.txt'))");
    const r = exec('SELECT f FROM docs');
    expect(r.rows[0][0]).toBe('BFILE:EXT_DIR/a.txt');
  });
});

describe('DBMS_LOB BFILE operations resolve the host file', () => {
  test('FILEEXISTS is 1 for a present file, 0 for an absent one', () => {
    expect(exec("SELECT DBMS_LOB.FILEEXISTS(BFILENAME('EXT_DIR','a.txt')) FROM dual").rows[0][0]).toBe(1);
    expect(exec("SELECT DBMS_LOB.FILEEXISTS(BFILENAME('EXT_DIR','missing.txt')) FROM dual").rows[0][0]).toBe(0);
  });

  test('GETLENGTH returns the host file size', () => {
    expect(exec("SELECT DBMS_LOB.GETLENGTH(BFILENAME('EXT_DIR','a.txt')) FROM dual").rows[0][0]).toBe(5);
  });

  test('GETLENGTH of an absent file is NULL', () => {
    expect(exec("SELECT DBMS_LOB.GETLENGTH(BFILENAME('EXT_DIR','ghost.txt')) FROM dual").rows[0][0]).toBeNull();
  });

  test('GETLENGTH still measures a plain CLOB string', () => {
    expect(exec("SELECT DBMS_LOB.GETLENGTH('abcd') FROM dual").rows[0][0]).toBe(4);
  });

  test('an unknown directory raises ORA-22285', () => {
    expect(() => exec("SELECT DBMS_LOB.GETLENGTH(BFILENAME('NOPE','a.txt')) FROM dual")).toThrow(/22285/);
  });

  test('BFILE works inside PL/SQL via the SQL bridge', () => {
    const r = exec(`DECLARE n NUMBER; BEGIN
      n := DBMS_LOB.GETLENGTH(BFILENAME('EXT_DIR','a.txt'));
      DBMS_OUTPUT.PUT_LINE('len=' || n); END;`);
    expect(r.message).toContain('len=5');
  });
});

describe('BFILE reads enforce directory READ privilege', () => {
  test('a user without READ is denied with ORA-22285', () => {
    expect(() => exec("SELECT DBMS_LOB.FILEEXISTS(BFILENAME('EXT_DIR','a.txt')) FROM dual", alice))
      .toThrow(/22285/);
  });

  test('granting READ lets the user resolve the BFILE', () => {
    exec('GRANT READ ON DIRECTORY ext_dir TO alice');
    expect(exec("SELECT DBMS_LOB.FILEEXISTS(BFILENAME('EXT_DIR','a.txt')) FROM dual", alice).rows[0][0]).toBe(1);
  });
});
