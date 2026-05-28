import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function server(name: string): LinuxServer {
  return new LinuxServer('linux-server', name, 100, 100);
}
function session(srv: LinuxServer): SqlPlusSubShell {
  return SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell;
}
function run(sh: SqlPlusSubShell, sql: string): string {
  return sh.processLine(sql).output.join('\n');
}

describe('LOCK TABLE', () => {
  it('registers a TM lock visible in V$LOCK and DBA_DML_LOCKS', () => {
    const srv = server('lk-1');
    const a = session(srv);
    run(a, 'CREATE TABLE LK_T (id NUMBER);');
    const out = run(a, 'LOCK TABLE LK_T IN EXCLUSIVE MODE;');
    expect(out).toMatch(/Table\(s\) Locked\./);
    const locks = run(a, "SELECT TYPE, LMODE FROM V$LOCK WHERE TYPE='TM';");
    expect(locks).toMatch(/TM\s+6/);
    const dml = run(a, "SELECT NAME, MODE_HELD FROM DBA_DML_LOCKS WHERE NAME='LK_T';");
    expect(dml).toMatch(/LK_T\s+Exclusive/);
    a.dispose();
  });

  it('V$LOCKED_OBJECT reflects the locked table', () => {
    const srv = server('lk-2');
    const a = session(srv);
    run(a, 'CREATE TABLE LK_T2 (id NUMBER);');
    run(a, 'LOCK TABLE LK_T2 IN EXCLUSIVE MODE;');
    const out = run(a, 'SELECT LOCKED_MODE FROM V$LOCKED_OBJECT;');
    expect(out).toMatch(/6/);
    a.dispose();
  });

  it('NOWAIT raises ORA-00054 when another session holds a conflicting lock', () => {
    const srv = server('lk-3');
    const a = session(srv);
    const b = session(srv);
    run(a, 'CREATE TABLE LK_T3 (id NUMBER);');
    run(a, 'LOCK TABLE LK_T3 IN EXCLUSIVE MODE;');
    const out = run(b, 'LOCK TABLE LK_T3 IN EXCLUSIVE MODE NOWAIT;');
    expect(out).toMatch(/ORA-00054/);
    a.dispose();
    b.dispose();
  });

  it('compatible modes (ROW SHARE) do not conflict', () => {
    const srv = server('lk-4');
    const a = session(srv);
    const b = session(srv);
    run(a, 'CREATE TABLE LK_T4 (id NUMBER);');
    run(a, 'LOCK TABLE LK_T4 IN ROW SHARE MODE;');
    const out = run(b, 'LOCK TABLE LK_T4 IN ROW SHARE MODE NOWAIT;');
    expect(out).toMatch(/Table\(s\) Locked\./);
    a.dispose();
    b.dispose();
  });
});

describe('Blocking sessions', () => {
  it('a waiting session shows up in DBA_WAITERS / DBA_BLOCKERS', () => {
    const srv = server('blk-1');
    const a = session(srv);
    const b = session(srv);
    run(a, 'CREATE TABLE BLK_T (id NUMBER);');
    run(a, 'LOCK TABLE BLK_T IN EXCLUSIVE MODE;');
    run(b, 'LOCK TABLE BLK_T IN EXCLUSIVE MODE;');
    const waiters = run(a, 'SELECT WAITING_SESSION, HOLDING_SESSION FROM DBA_WAITERS;');
    expect(waiters).toMatch(/\d+\s+\d+/);
    const blockers = run(a, 'SELECT HOLDING_SESSION FROM DBA_BLOCKERS;');
    expect(blockers).toMatch(/\d+/);
    a.dispose();
    b.dispose();
  });

  it('V$SESSION.BLOCKING_SESSION points at the holder', () => {
    const srv = server('blk-2');
    const a = session(srv);
    const b = session(srv);
    run(a, 'CREATE TABLE BLK_T2 (id NUMBER);');
    run(a, 'LOCK TABLE BLK_T2 IN EXCLUSIVE MODE;');
    run(b, 'LOCK TABLE BLK_T2 IN EXCLUSIVE MODE;');
    const out = run(a, "SELECT SID, BLOCKING_SESSION FROM V$SESSION WHERE BLOCKING_SESSION IS NOT NULL AND TYPE='USER';");
    expect(out).toMatch(/\d+\s+\d+/);
    a.dispose();
    b.dispose();
  });

  it('releasing the holder lets the waiter acquire the lock', () => {
    const srv = server('blk-3');
    const a = session(srv);
    const b = session(srv);
    run(a, 'CREATE TABLE BLK_T3 (id NUMBER);');
    run(a, 'LOCK TABLE BLK_T3 IN EXCLUSIVE MODE;');
    run(b, 'LOCK TABLE BLK_T3 IN EXCLUSIVE MODE;');
    a.processLine('COMMIT;');
    a.processLine('DISCONNECT;');
    const out = run(b, "SELECT LMODE, REQUEST FROM V$LOCK WHERE TYPE='TM';");
    expect(out).toMatch(/6\s+0/);
    b.dispose();
  });
});

describe('Deadlock detection', () => {
  it('a lock cycle raises ORA-00060', () => {
    const srv = server('dl-1');
    const a = session(srv);
    const b = session(srv);
    run(a, 'CREATE TABLE DL_T1 (id NUMBER);');
    run(a, 'CREATE TABLE DL_T2 (id NUMBER);');
    run(a, 'LOCK TABLE DL_T1 IN EXCLUSIVE MODE;');
    run(b, 'LOCK TABLE DL_T2 IN EXCLUSIVE MODE;');
    run(a, 'LOCK TABLE DL_T2 IN EXCLUSIVE MODE;');
    const out = run(b, 'LOCK TABLE DL_T1 IN EXCLUSIVE MODE;');
    expect(out).toMatch(/ORA-00060/);
    a.dispose();
    b.dispose();
  });
});

describe('SELECT FOR UPDATE', () => {
  it('acquires a TX and TM lock', () => {
    const srv = server('fu-1');
    const a = session(srv);
    run(a, 'CREATE TABLE FU_T (id NUMBER);');
    run(a, 'INSERT INTO FU_T VALUES (1);');
    run(a, 'SELECT * FROM FU_T FOR UPDATE;');
    const out = run(a, 'SELECT TYPE FROM V$LOCK;');
    expect(out).toMatch(/TM/);
    expect(out).toMatch(/TX/);
    a.dispose();
  });

  it('FOR UPDATE NOWAIT raises ORA-00054 on a conflicting row lock', () => {
    const srv = server('fu-2');
    const a = session(srv);
    const b = session(srv);
    run(a, 'CREATE TABLE FU_T2 (id NUMBER);');
    run(a, 'INSERT INTO FU_T2 VALUES (1);');
    run(a, 'LOCK TABLE FU_T2 IN EXCLUSIVE MODE;');
    const out = run(b, 'SELECT * FROM FU_T2 FOR UPDATE NOWAIT;');
    expect(out).toMatch(/ORA-00054/);
    a.dispose();
    b.dispose();
  });
});

describe('DML locks via the bus', () => {
  it('an INSERT acquires a TM lock that COMMIT releases', () => {
    const srv = server('dml-1');
    const a = session(srv);
    run(a, 'CREATE TABLE DMLK_T (id NUMBER);');
    run(a, 'INSERT INTO DMLK_T VALUES (1);');
    const held = run(a, "SELECT NAME FROM DBA_DML_LOCKS WHERE NAME='DMLK_T';");
    expect(held).toMatch(/DMLK_T/);
    a.processLine('COMMIT;');
    const after = run(a, "SELECT NAME FROM DBA_DML_LOCKS WHERE NAME='DMLK_T';");
    expect(after).not.toMatch(/DMLK_T/);
    a.dispose();
  });
});
