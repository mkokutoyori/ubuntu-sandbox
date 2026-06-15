/**
 * UTL_FILE — real server-side file I/O backed by directory objects and the
 * database server's host filesystem.
 *
 * UTL_FILE used to be a pure stub (every call returned null). These tests
 * pin the real behaviour AND the cross-layer coherence the simulator is
 * about: an in-memory host VFS stands in for the device filesystem the
 * terminal layer wires, so we can assert that a file written by
 * UTL_FILE.PUT_LINE is exactly what the OS shell would `cat`, and that a
 * file dropped on the host by the shell is read back by UTL_FILE.GET_LINE.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import type { OracleExecutor } from '../../../database/oracle/OracleExecutor';

let db: OracleDatabase;
let sys: OracleExecutor;
/** Stand-in for the device VFS the terminal layer would wire in. */
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
  // Engine-level equivalent of SET SERVEROUTPUT ON, so DBMS_OUTPUT lands in
  // the result message we can assert on.
  (sys as unknown as { context: { serverOutput: boolean } }).context.serverOutput = true;
  exec("CREATE DIRECTORY ext_dir AS '/home/oracle/out'");
});

describe('UTL_FILE write path (Oracle → host filesystem)', () => {
  test('PUT_LINE materialises a file on the host filesystem', () => {
    exec(`DECLARE f UTL_FILE.FILE_TYPE; BEGIN
            f := UTL_FILE.FOPEN('EXT_DIR', 'report.txt', 'W');
            UTL_FILE.PUT_LINE(f, 'line one');
            UTL_FILE.PUT_LINE(f, 'line two');
            UTL_FILE.FCLOSE(f);
          END;`);
    expect(hostFiles.get('/home/oracle/out/report.txt')).toBe('line one\nline two\n');
  });

  test('PUT then NEW_LINE compose a line without a trailing separator', () => {
    exec(`DECLARE f UTL_FILE.FILE_TYPE; BEGIN
            f := UTL_FILE.FOPEN('EXT_DIR', 'compose.txt', 'W');
            UTL_FILE.PUT(f, 'a');
            UTL_FILE.PUT(f, 'b');
            UTL_FILE.NEW_LINE(f);
            UTL_FILE.FCLOSE(f);
          END;`);
    expect(hostFiles.get('/home/oracle/out/compose.txt')).toBe('ab\n');
  });

  test('append mode preserves existing host content', () => {
    hostFiles.set('/home/oracle/out/app.txt', 'first\n');
    exec(`DECLARE f UTL_FILE.FILE_TYPE; BEGIN
            f := UTL_FILE.FOPEN('EXT_DIR', 'app.txt', 'A');
            UTL_FILE.PUT_LINE(f, 'second');
            UTL_FILE.FCLOSE(f);
          END;`);
    expect(hostFiles.get('/home/oracle/out/app.txt')).toBe('first\nsecond\n');
  });

  test('write mode truncates an existing file', () => {
    hostFiles.set('/home/oracle/out/trunc.txt', 'old content\n');
    exec(`DECLARE f UTL_FILE.FILE_TYPE; BEGIN
            f := UTL_FILE.FOPEN('EXT_DIR', 'trunc.txt', 'W');
            UTL_FILE.PUT_LINE(f, 'fresh');
            UTL_FILE.FCLOSE(f);
          END;`);
    expect(hostFiles.get('/home/oracle/out/trunc.txt')).toBe('fresh\n');
  });
});

describe('UTL_FILE read path (host filesystem → Oracle)', () => {
  test('GET_LINE reads a file the shell dropped on the host', () => {
    hostFiles.set('/home/oracle/out/in.txt', 'alpha\nbeta\n');
    const r = exec(`DECLARE f UTL_FILE.FILE_TYPE; s VARCHAR2(100); BEGIN
            f := UTL_FILE.FOPEN('EXT_DIR', 'in.txt', 'R');
            UTL_FILE.GET_LINE(f, s); DBMS_OUTPUT.PUT_LINE(s);
            UTL_FILE.GET_LINE(f, s); DBMS_OUTPUT.PUT_LINE(s);
            UTL_FILE.FCLOSE(f);
          END;`);
    expect(r.message).toContain('alpha');
    expect(r.message).toContain('beta');
  });

  test('GET_LINE past EOF raises a catchable NO_DATA_FOUND', () => {
    hostFiles.set('/home/oracle/out/one.txt', 'only\n');
    const r = exec(`DECLARE f UTL_FILE.FILE_TYPE; s VARCHAR2(100); BEGIN
            f := UTL_FILE.FOPEN('EXT_DIR', 'one.txt', 'R');
            UTL_FILE.GET_LINE(f, s);
            UTL_FILE.GET_LINE(f, s);
          EXCEPTION WHEN NO_DATA_FOUND THEN DBMS_OUTPUT.PUT_LINE('EOF reached');
          END;`);
    expect(r.message).toContain('EOF reached');
  });

  test('a file written by UTL_FILE is read back by UTL_FILE (round trip)', () => {
    exec(`DECLARE f UTL_FILE.FILE_TYPE; BEGIN
            f := UTL_FILE.FOPEN('EXT_DIR', 'rt.txt', 'W');
            UTL_FILE.PUT_LINE(f, 'hello world');
            UTL_FILE.FCLOSE(f);
          END;`);
    const r = exec(`DECLARE f UTL_FILE.FILE_TYPE; s VARCHAR2(100); BEGIN
            f := UTL_FILE.FOPEN('EXT_DIR', 'rt.txt', 'R');
            UTL_FILE.GET_LINE(f, s); DBMS_OUTPUT.PUT_LINE(s);
            UTL_FILE.FCLOSE(f);
          END;`);
    expect(r.message).toContain('hello world');
  });
});

describe('UTL_FILE handle and error semantics', () => {
  test('IS_OPEN reflects the handle lifecycle', () => {
    const r = exec(`DECLARE f UTL_FILE.FILE_TYPE; BEGIN
            f := UTL_FILE.FOPEN('EXT_DIR', 'io.txt', 'W');
            IF UTL_FILE.IS_OPEN(f) THEN DBMS_OUTPUT.PUT_LINE('open'); END IF;
            UTL_FILE.FCLOSE(f);
            IF NOT UTL_FILE.IS_OPEN(f) THEN DBMS_OUTPUT.PUT_LINE('closed'); END IF;
          END;`);
    expect(r.message).toContain('open');
    expect(r.message).toContain('closed');
  });

  test('FOPEN on an unknown directory object raises ORA-29280', () => {
    const r = exec(`DECLARE f UTL_FILE.FILE_TYPE; BEGIN
            f := UTL_FILE.FOPEN('NO_SUCH_DIR', 'x.txt', 'W');
          END;`);
    expect(r.message).toMatch(/29280|invalid directory/i);
  });

  test('a filename with a path separator raises ORA-29280', () => {
    const r = exec(`DECLARE f UTL_FILE.FILE_TYPE; BEGIN
            f := UTL_FILE.FOPEN('EXT_DIR', 'sub/x.txt', 'W');
          END;`);
    expect(r.message).toMatch(/29280/);
  });

  test('opening a missing file for read raises ORA-29283', () => {
    const r = exec(`DECLARE f UTL_FILE.FILE_TYPE; BEGIN
            f := UTL_FILE.FOPEN('EXT_DIR', 'ghost.txt', 'R');
          END;`);
    expect(r.message).toMatch(/29283|invalid file operation/i);
  });

  test('an invalid open mode raises ORA-29281', () => {
    const r = exec(`DECLARE f UTL_FILE.FILE_TYPE; BEGIN
            f := UTL_FILE.FOPEN('EXT_DIR', 'm.txt', 'Z');
          END;`);
    expect(r.message).toMatch(/29281|invalid file open mode/i);
  });
});

describe('UTL_FILE file management', () => {
  test('FREMOVE deletes the host file', () => {
    hostFiles.set('/home/oracle/out/del.txt', 'x\n');
    exec(`BEGIN UTL_FILE.FREMOVE('EXT_DIR', 'del.txt'); END;`);
    expect(hostFiles.has('/home/oracle/out/del.txt')).toBe(false);
  });

  test('FRENAME moves a file between names', () => {
    hostFiles.set('/home/oracle/out/src.txt', 'payload\n');
    exec(`BEGIN UTL_FILE.FRENAME('EXT_DIR', 'src.txt', 'EXT_DIR', 'dst.txt', TRUE); END;`);
    expect(hostFiles.has('/home/oracle/out/src.txt')).toBe(false);
    expect(hostFiles.get('/home/oracle/out/dst.txt')).toBe('payload\n');
  });

  test('FCOPY duplicates a file, leaving the source in place', () => {
    hostFiles.set('/home/oracle/out/orig.txt', 'data\n');
    exec(`BEGIN UTL_FILE.FCOPY('EXT_DIR', 'orig.txt', 'EXT_DIR', 'copy.txt'); END;`);
    expect(hostFiles.get('/home/oracle/out/orig.txt')).toBe('data\n');
    expect(hostFiles.get('/home/oracle/out/copy.txt')).toBe('data\n');
  });
});
