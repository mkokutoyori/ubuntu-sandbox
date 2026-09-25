/**
 * Suite de RELEVE — ce que devient une session que le serveur termine :
 * tuee (ALTER SYSTEM KILL SESSION), deconnectee, ou coupee par une
 * limite de profil (IDLE_TIME, CONNECT_TIME) ; plus les parametres
 * statiques et le refus d'un GRANT a soi-meme.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

const note = (l: string) => { console.log(l); };
let srv: LinuxServer;
beforeEach(() => {
  resetCounters(); resetDeviceCounters(); resetAllOracleInstances(); Logger.reset();
  srv = new LinuxServer('linux-server', 'ORA-SEC3', 0, 0);
  SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
});
function session(args: string[]) {
  const created = SqlPlusSubShell.create(srv, args);
  return {
    login: created.loginOutput.join(' ').trim(),
    run: (sql: string) => created.subShell.processLine(sql).output.join('\n').trim(),
    close: () => created.subShell.dispose(),
  };
}
function asSys(statements: string[]): string[] {
  const s = session(['/', 'as', 'sysdba']);
  const out = statements.map(stmt => s.run(stmt));
  s.close();
  return out;
}
const flat = (s: string, n = 300) => s.replace(/\s+/g, ' ').trim().slice(0, n);
const sidSerial = (out: string): string => {
  const m = /(\d+)\s+(\d+)/.exec(out.split('\n').filter(l => /^\s*\d/.test(l)).join('\n'));
  return m ? `${m[1]},${m[2]}` : '0,0';
};

describe('sessions terminees par le serveur', () => {
  it('releve', () => {
    asSys([
      'CREATE USER hr IDENTIFIED BY hr;',
      'GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO hr;',
      'CREATE TABLE hr.emp (id NUMBER);',
      'INSERT INTO hr.emp VALUES (1);', 'COMMIT;',
    ]);
    const victime = session(['hr/hr']);
    victime.run('INSERT INTO hr.emp VALUES (2);');
    const cible = sidSerial(asSys(["SELECT sid, serial# FROM v$session WHERE username = 'HR';"])[0]);
    note(`[K-1] KILL SESSION '${cible}' : ${flat(asSys([`ALTER SYSTEM KILL SESSION '${cible}';`])[0], 120)}`);
    note(`[K-2] V$SESSION pendant ce temps : ${flat(asSys(["SELECT username, status FROM v$session WHERE username = 'HR';"])[0], 150)}`);
    note(`[K-3] la victime, premier appel : ${flat(victime.run('SELECT * FROM hr.emp;'), 200)}`);
    note(`[K-4] la victime, appel suivant : ${flat(victime.run('SELECT * FROM DUAL;'), 200)}`);
    note(`[K-5] la ligne non validee a-t-elle ete annulee ? ${flat(asSys(['SELECT COUNT(*) FROM hr.emp;'])[0], 120)}`);
    note(`[K-6] V$SESSION apres l appel : ${flat(asSys(["SELECT COUNT(*) FROM v$session WHERE username = 'HR';"])[0], 120)}`);
    note(`[K-7] alert log : ${srv.executeShellCommandSync('grep -i "kill session" /u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log').trim().slice(-160)}`);
    victime.close();

    note('');
    const db = getOracleDatabase(srv.getId());
    asSys(['CREATE PROFILE p_idle LIMIT IDLE_TIME 5;', 'ALTER USER hr PROFILE p_idle;']);
    const dormeuse = session(['hr/hr']);
    dormeuse.run('SELECT * FROM DUAL;');
    const info = db.securityEngine.sessions.getAllSessions().find(s => s.username === 'HR');
    db.idleMonitor.bumpIdle(info!.sessionId, 600);
    note(`[I-1] STATUS apres le balayage : ${flat(asSys(["SELECT username, status FROM v$session WHERE username = 'HR';"])[0], 150)}`);
    note(`[I-2] la dormeuse, premier appel : ${flat(dormeuse.run('SELECT * FROM DUAL;'), 200)}`);
    note(`[I-3] puis : ${flat(dormeuse.run('SELECT * FROM DUAL;'), 160)}`);
    dormeuse.close();

    note('');
    asSys(['ALTER USER hr PROFILE DEFAULT;', 'CREATE PROFILE p_conn LIMIT CONNECT_TIME 1;', 'ALTER USER hr PROFILE p_conn;']);
    const ancienne = session(['hr/hr']);
    const info2 = db.securityEngine.sessions.getAllSessions().find(s => s.username === 'HR');
    db.idleMonitor.bumpConnected(info2!.sessionId, 600);
    note(`[C-1] CONNECT_TIME depasse, premier appel : ${flat(ancienne.run('SELECT * FROM DUAL;'), 200)}`);
    ancienne.close();

    note('');
    note(`[P-1] ALTER SYSTEM SET audit_trail = NONE : ${flat(asSys(['ALTER SYSTEM SET audit_trail = NONE;'])[0], 160)}`);
    note(`[P-2] ... SCOPE = SPFILE : ${flat(asSys(['ALTER SYSTEM SET audit_trail = NONE SCOPE=SPFILE;'])[0], 120)}`);
    note(`[P-3] ALTER SYSTEM SET sessions = 2 : ${flat(asSys(['ALTER SYSTEM SET sessions = 2;'])[0], 160)}`);
    note(`[P-4] parametre dynamique (db_recovery_file_dest_size) : ${flat(asSys(["ALTER SYSTEM SET db_recovery_file_dest_size = '20G';"])[0], 120)}`);

    note('');
    asSys(['CREATE USER bob IDENTIFIED BY bobpass;', 'GRANT CREATE SESSION TO bob;',
           'GRANT SELECT ON hr.emp TO bob WITH GRANT OPTION;']);
    const bob = session(['bob/bobpass']);
    note(`[G-1] bob s accorde a LUI-MEME : ${flat(bob.run('GRANT SELECT ON hr.emp TO bob;'), 160)}`);
    note(`[G-2] bob accorde au PROPRIETAIRE : ${flat(bob.run('GRANT SELECT ON hr.emp TO hr;'), 160)}`);
    note(`[G-3] bob accorde a un TIERS : ${flat(asSys(['CREATE USER carol IDENTIFIED BY c;']).join('') + ' ' + bob.run('GRANT SELECT ON hr.emp TO carol;'), 160)}`);
    bob.close();
    expect(true).toBe(true);
  });
});
