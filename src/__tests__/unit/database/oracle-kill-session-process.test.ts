/**
 * CORRECTION (lot « sessions terminees ») : ces cas EPINGLAIENT un
 * defaut. Ils exigeaient que le KILL fasse disparaitre la ligne de
 * V$SESSION et rende le processus serveur SUR-LE-CHAMP. Un vrai serveur
 * marque la session KILLED et garde sa ligne jusqu'au PROCHAIN appel de
 * la victime : « a session marked to be terminated is indicated in
 * V$SESSION with a status of KILLED », et « a killed session waits for a
 * SQLNet message from client to which it can respond with ORA-00028 ;
 * only when this message is received, PMON will take ownership of the
 * process ». Les cas verifient desormais LA SEQUENCE : marquee d'abord,
 * nettoyee quand la victime l'apprend.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { DEFAULT_OS_CONTEXT } from '@/database/oracle/security/types';

let db: OracleDatabase;
let sysExecutor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup();
  sysExecutor = db.connectAsSysdba().executor;
  db.executeSql(sysExecutor, 'CREATE USER u1 IDENTIFIED BY pw');
  db.executeSql(sysExecutor, 'GRANT CREATE SESSION TO u1');
});

const query = (sql: string) =>
  db.executeSql(sysExecutor, sql).rows.map(r => r.join('|')).join('\n');

describe('ALTER SYSTEM KILL SESSION releases the dedicated server process', () => {
  it('the server process is released once the victim learns of the kill', () => {
    const victim = db.connect('U1', 'pw', DEFAULT_OS_CONTEXT, 'tcp');
    const sid = victim.sid;
    expect(db.instance.getServerProcess(sid)).toBeDefined();
    const serial = db.getSession(sid)!.serial;

    db.executeSql(sysExecutor, `ALTER SYSTEM KILL SESSION '${sid},${serial}'`);
    expect(db.instance.getServerProcess(sid)).toBeDefined();

    expect(() => db.executeSql(victim.executor, 'SELECT 1 FROM DUAL'))
      .toThrow(/ORA-00028/);
    expect(db.instance.getServerProcess(sid)).toBeUndefined();
  });

  it('V$PROCESS no longer lists the killed session server', () => {
    const victim = db.connect('U1', 'pw', DEFAULT_OS_CONTEXT, 'tcp');
    const sid = victim.sid;
    const serverPid = db.instance.getServerProcess(sid)!.pid;
    expect(query('SELECT pid FROM v$process WHERE pname IS NULL')).toContain(String(serverPid));

    db.executeSql(sysExecutor, `ALTER SYSTEM KILL SESSION '${sid},${db.getSession(sid)!.serial}'`);
    expect(() => db.executeSql(victim.executor, 'SELECT 1 FROM DUAL')).toThrow(/ORA-00028/);

    expect(query('SELECT pid FROM v$process WHERE pname IS NULL')).not.toContain(String(serverPid));
  });

  it('V$SESSION says KILLED, then drops the session once the victim calls', () => {
    const victim = db.connect('U1', 'pw', DEFAULT_OS_CONTEXT, 'tcp');
    const sid = victim.sid;
    expect(query("SELECT sid FROM v$session WHERE username = 'U1'")).toContain(String(sid));

    db.executeSql(sysExecutor, `ALTER SYSTEM KILL SESSION '${sid},${db.getSession(sid)!.serial}'`);
    expect(query("SELECT status FROM v$session WHERE username = 'U1'")).toContain('KILLED');

    expect(() => db.executeSql(victim.executor, 'SELECT 1 FROM DUAL')).toThrow(/ORA-00028/);
    expect(query("SELECT sid FROM v$session WHERE username = 'U1'")).not.toContain(String(sid));
  });

  it('killing an unknown session is rejected', () => {
    expect(() => db.executeSql(sysExecutor, "ALTER SYSTEM KILL SESSION '999,999'"))
      .toThrow(/no such session/i);
  });
});
