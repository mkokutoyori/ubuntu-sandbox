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

describe('DROP USER releases the dedicated server processes of its sessions', () => {
  it('the server process is gone after the user is dropped', () => {
    const { sid } = db.connect('U1', 'pw', DEFAULT_OS_CONTEXT, 'tcp');
    const serverPid = db.instance.getServerProcess(sid)!.pid;
    expect(query('SELECT pid FROM v$process WHERE pname IS NULL')).toContain(String(serverPid));

    db.executeSql(sysExecutor, 'DROP USER u1');

    expect(db.instance.getServerProcess(sid)).toBeUndefined();
    expect(query('SELECT pid FROM v$process WHERE pname IS NULL')).not.toContain(String(serverPid));
  });

  it('dropping a user with no open session leaves other servers untouched', () => {
    const other = db.connect('SYSTEM', 'oracle', DEFAULT_OS_CONTEXT, 'tcp');
    const otherPid = db.instance.getServerProcess(other.sid)!.pid;

    db.executeSql(sysExecutor, 'DROP USER u1');

    expect(db.instance.getServerProcess(other.sid)?.pid).toBe(otherPid);
  });
});
