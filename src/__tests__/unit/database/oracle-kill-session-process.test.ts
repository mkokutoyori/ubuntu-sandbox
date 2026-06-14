import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { DEFAULT_OS_CONTEXT } from '@/database/oracle/security/types';

let db: OracleDatabase;
let sysExecutor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup('OPEN');
  sysExecutor = db.connectAsSysdba().executor;
  db.executeSql(sysExecutor, 'CREATE USER u1 IDENTIFIED BY pw');
  db.executeSql(sysExecutor, 'GRANT CREATE SESSION TO u1');
});

const query = (sql: string) =>
  db.executeSql(sysExecutor, sql).rows.map(r => r.join('|')).join('\n');

describe('ALTER SYSTEM KILL SESSION releases the dedicated server process', () => {
  it('the server process is gone from the instance after the kill', () => {
    const { sid } = db.connect('U1', 'pw', DEFAULT_OS_CONTEXT, 'tcp');
    expect(db.instance.getServerProcess(sid)).toBeDefined();
    const serial = db.getSession(sid)!.serial;

    db.executeSql(sysExecutor, `ALTER SYSTEM KILL SESSION '${sid},${serial}'`);

    expect(db.instance.getServerProcess(sid)).toBeUndefined();
  });

  it('V$PROCESS no longer lists the killed session server', () => {
    const { sid } = db.connect('U1', 'pw', DEFAULT_OS_CONTEXT, 'tcp');
    const serverPid = db.instance.getServerProcess(sid)!.pid;
    expect(query('SELECT pid FROM v$process WHERE pname IS NULL')).toContain(String(serverPid));

    db.executeSql(sysExecutor, `ALTER SYSTEM KILL SESSION '${sid},${db.getSession(sid)!.serial}'`);

    expect(query('SELECT pid FROM v$process WHERE pname IS NULL')).not.toContain(String(serverPid));
  });

  it('V$SESSION drops the killed session', () => {
    const { sid } = db.connect('U1', 'pw', DEFAULT_OS_CONTEXT, 'tcp');
    expect(query("SELECT sid FROM v$session WHERE username = 'U1'")).toContain(String(sid));

    db.executeSql(sysExecutor, `ALTER SYSTEM KILL SESSION '${sid},${db.getSession(sid)!.serial}'`);

    expect(query("SELECT sid FROM v$session WHERE username = 'U1'")).not.toContain(String(sid));
  });

  it('killing an unknown session is rejected', () => {
    expect(() => db.executeSql(sysExecutor, "ALTER SYSTEM KILL SESSION '999,999'"))
      .toThrow(/no such session/i);
  });
});
