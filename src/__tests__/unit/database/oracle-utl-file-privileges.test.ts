import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import type { OracleExecutor } from '../../../database/oracle/OracleExecutor';

let db: OracleDatabase;
let sys: OracleExecutor;
let alice: OracleExecutor;
let hostFiles: Map<string, string>;

function exec(sql: string, on: OracleExecutor) {
  return db.executeSql(on, sql);
}

function asAlice(): OracleExecutor {
  const e = db.connect('alice', 'pw').executor;
  (e as unknown as { context: { serverOutput: boolean } }).context.serverOutput = true;
  return e;
}

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  hostFiles = new Map();
  db.instance.setDeviceFileReader((p) => (hostFiles.has(p) ? hostFiles.get(p)! : null));
  db.instance.setDeviceFileWriter((p, c) => { hostFiles.set(p, c); return true; });
  db.instance.setDeviceFileRemover((p) => hostFiles.delete(p));
  sys = db.connectAsSysdba().executor;
  exec("CREATE DIRECTORY ext_dir AS '/home/oracle/out'", sys);
  exec('CREATE USER alice IDENTIFIED BY pw', sys);
  exec('GRANT CREATE SESSION TO alice', sys);
  alice = asAlice();
});

const writeBlock = `DECLARE f UTL_FILE.FILE_TYPE; BEGIN
  f := UTL_FILE.FOPEN('EXT_DIR', 'a.txt', 'W');
  UTL_FILE.PUT_LINE(f, 'hi'); UTL_FILE.FCLOSE(f); END;`;

const readBlock = `DECLARE f UTL_FILE.FILE_TYPE; s VARCHAR2(100); BEGIN
  f := UTL_FILE.FOPEN('EXT_DIR', 'a.txt', 'R');
  UTL_FILE.GET_LINE(f, s); DBMS_OUTPUT.PUT_LINE(s); UTL_FILE.FCLOSE(f); END;`;

describe('UTL_FILE enforces directory privileges', () => {
  test('a user without any grant is denied with ORA-29289', () => {
    const r = exec(writeBlock, alice);
    expect(r.message).toMatch(/29289/);
    expect(hostFiles.has('/home/oracle/out/a.txt')).toBe(false);
  });

  test('WRITE grant lets the user open for write', () => {
    exec('GRANT WRITE ON DIRECTORY ext_dir TO alice', sys);
    const r = exec(writeBlock, alice);
    expect(r.message).not.toMatch(/29289/);
    expect(hostFiles.get('/home/oracle/out/a.txt')).toBe('hi\n');
  });

  test('READ grant lets the user open for read', () => {
    hostFiles.set('/home/oracle/out/a.txt', 'payload\n');
    exec('GRANT READ ON DIRECTORY ext_dir TO alice', sys);
    const r = exec(readBlock, alice);
    expect(r.message).toContain('payload');
  });

  test('READ alone does not authorize a write open (ORA-29289)', () => {
    exec('GRANT READ ON DIRECTORY ext_dir TO alice', sys);
    const r = exec(writeBlock, alice);
    expect(r.message).toMatch(/29289/);
  });

  test('a grant to PUBLIC authorizes every user', () => {
    hostFiles.set('/home/oracle/out/a.txt', 'shared\n');
    exec('GRANT READ ON DIRECTORY ext_dir TO PUBLIC', sys);
    const r = exec(readBlock, alice);
    expect(r.message).toContain('shared');
  });

  test('revoking the grant denies access again', () => {
    exec('GRANT WRITE ON DIRECTORY ext_dir TO alice', sys);
    exec('REVOKE WRITE ON DIRECTORY ext_dir FROM alice', sys);
    const r = exec(writeBlock, alice);
    expect(r.message).toMatch(/29289/);
  });

  test('SYS needs no directory grant', () => {
    (sys as unknown as { context: { serverOutput: boolean } }).context.serverOutput = true;
    const r = exec(writeBlock, sys);
    expect(r.message).not.toMatch(/29289/);
    expect(hostFiles.get('/home/oracle/out/a.txt')).toBe('hi\n');
  });

  test('FREMOVE requires WRITE on the directory', () => {
    hostFiles.set('/home/oracle/out/a.txt', 'x\n');
    const denied = exec(`BEGIN UTL_FILE.FREMOVE('EXT_DIR', 'a.txt'); END;`, alice);
    expect(denied.message).toMatch(/29289/);
    expect(hostFiles.has('/home/oracle/out/a.txt')).toBe(true);
    exec('GRANT WRITE ON DIRECTORY ext_dir TO alice', sys);
    exec(`BEGIN UTL_FILE.FREMOVE('EXT_DIR', 'a.txt'); END;`, alice);
    expect(hostFiles.has('/home/oracle/out/a.txt')).toBe(false);
  });
});
