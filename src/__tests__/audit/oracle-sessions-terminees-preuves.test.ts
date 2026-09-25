/**
 * Sonde — une session que le serveur termine doit l'APPRENDRE.
 *
 * Les bancs de releve `debug/oracle/*` ont mesure que les trois ordres
 * par lesquels un serveur Oracle met fin a une session n'avaient aucun
 * effet sur leur victime :
 *
 *   - `ALTER SYSTEM KILL SESSION 'sid,serial#'` repondait « System
 *     altered. », la ligne disparaissait de V$SESSION — et la victime
 *     continuait a lire, a inserer et a valider. Deux vues du meme fait
 *     qui se contredisaient (regle 3) et un ordre sans effet (regle 6).
 *   - `IDLE_TIME` etait balaye par `IdleSessionMonitor`, qui DESINSCRIVAIT
 *     la session : elle n'etait donc jamais rendue SNIPED par V$SESSION,
 *     et sa victime ne voyait rien.
 *   - `CONNECT_TIME` etait resolu par `ProfileManager` et n'avait AUCUN
 *     appelant : lu, rendu par DBA_PROFILES, jamais evalue.
 *
 * Ce que fait le vrai serveur, et que ce lot met en place, tient en une
 * phrase : la session terminee GARDE sa ligne dans V$SESSION avec son
 * nouveau statut (KILLED, SNIPED) jusqu'a son PROCHAIN appel, qui est
 * l'endroit ou elle l'apprend ; le travail non valide est annule et les
 * verrous rendus des la terminaison ; et tout appel ulterieur ne trouve
 * plus de session du tout.
 *
 * Autorites (docs.oracle.com est injoignable depuis cet environnement ;
 * les formulations viennent d'extraits de recherche et de la
 * documentation « Terminating Sessions » citee par eux) :
 *   - « the transaction is rolled back and the user immediately receives
 *     ORA-00028: your session has been killed » ; « If, after receiving
 *     the ORA-00028 message, a user submits additional statements before
 *     reconnecting, Oracle Database returns ORA-01012: not logged on » ;
 *   - « a session marked to be terminated is indicated in V$SESSION with
 *     a status of KILLED » ;
 *   - ORA-02396 « exceeded maximum idle time, please connect again » et
 *     ORA-02399 « exceeded maximum connect time, you are being logged
 *     off » pour les limites de profil ;
 *   - ORA-02095 « specified initialization parameter cannot be
 *     modified » : AUDIT_TRAIL est STATIQUE, il n'accepte que
 *     SCOPE=SPFILE et ne prend effet qu'au redemarrage ;
 *   - ORA-01749 vaut pour un GRANT a SOI-MEME comme au PROPRIETAIRE de
 *     l'objet ; le simulateur ne fermait que la seconde moitie.
 *
 * MESURE LAISSEE TELLE QUELLE, et pourquoi : un ordre refuse pour
 * privileges insuffisants (ORA-01031) n'apparait pas dans
 * DBA_AUDIT_TRAIL meme sous `AUDIT ... WHENEVER NOT SUCCESSFUL`. Le
 * releve l'a constate et la recherche montre que le vrai Oracle ne
 * l'enregistre pas non plus (« ORA-01031: insufficient privileges not
 * audited »). Le simulateur reste donc comme il est : « corriger » ici
 * l'aurait rendu FAUX.
 *
 * Discrimination par `git stash push -- src/database` : 10 cas sur 14
 * tombent avant (mesure).
 *
 * Les QUATRE qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN — une session que personne ne tue traverse le lot » :
 *    TEMOIN. Il interdit de fermer le defaut en terminant tout le monde.
 *  - « une session inconnue repond ORA-00031 » : non-regression.
 *  - « un utilisateur ordinaire ne peut pas tuer » : non-regression du
 *    controle de privilege, deja en place.
 *  - « un parametre DYNAMIQUE reste modifiable a chaud » : TEMOIN de la
 *    regle ORA-02095 — sans lui, refuser TOUT parametre passerait.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

const ALERT = '/u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log';
let srv: LinuxServer;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  srv = new LinuxServer('linux-server', 'ORA-ACCES', 0, 0);
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

function seedSchema(): void {
  asSys([
    'CREATE USER hr IDENTIFIED BY hr;',
    'GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO hr;',
    'CREATE TABLE hr.emp (id NUMBER);',
    'INSERT INTO hr.emp VALUES (1);',
    'COMMIT;',
  ]);
}

function sidSerialOf(username: string): string {
  const out = asSys([`SELECT sid, serial# FROM v$session WHERE username = '${username}';`])[0];
  const m = /(\d+)\s+(\d+)/.exec(out.split('\n').filter(l => /^\s*\d/.test(l)).join('\n'));
  return m ? `${m[1]},${m[2]}` : '0,0';
}

function count(output: string): number | null {
  const line = output.split('\n').map(l => l.trim()).find(l => /^\d+$/.test(l));
  return line === undefined ? null : Number(line);
}

function liveSession(user: string) {
  const s = session([user]);
  s.run('SELECT * FROM DUAL;');
  return s;
}

describe('ALTER SYSTEM KILL SESSION', () => {
  it('la victime recoit ORA-00028 a son appel suivant, puis ORA-01012', () => {
    seedSchema();
    const victim = liveSession('hr/hr');
    asSys([`ALTER SYSTEM KILL SESSION '${sidSerialOf('HR')}';`]);
    expect(victim.run('SELECT * FROM hr.emp;')).toContain('ORA-00028: your session has been killed');
    expect(victim.run('SELECT * FROM DUAL;')).toContain('ORA-01012: not logged on');
    victim.close();
  });

  it('V$SESSION porte STATUS = KILLED tant que la victime ne l a pas appris', () => {
    seedSchema();
    const victim = liveSession('hr/hr');
    asSys([`ALTER SYSTEM KILL SESSION '${sidSerialOf('HR')}';`]);
    expect(asSys(["SELECT username, status FROM v$session WHERE username = 'HR';"])[0])
      .toMatch(/HR\s+KILLED/);
    victim.run('SELECT * FROM DUAL;');
    expect(count(asSys(["SELECT COUNT(*) FROM v$session WHERE username = 'HR';"])[0])).toBe(0);
    victim.close();
  });

  it('le travail non valide de la victime est ANNULE, et son COMMIT refuse', () => {
    seedSchema();
    const victim = liveSession('hr/hr');
    victim.run('INSERT INTO hr.emp VALUES (2);');
    expect(count(victim.run('SELECT COUNT(*) FROM hr.emp;'))).toBe(2);
    asSys([`ALTER SYSTEM KILL SESSION '${sidSerialOf('HR')}';`]);
    expect(victim.run('COMMIT;')).toContain('ORA-00028');
    victim.close();
    const apres = session(['hr/hr']);
    expect(count(apres.run('SELECT COUNT(*) FROM hr.emp;'))).toBe(1);
    apres.close();
  });

  it('la terminaison est ecrite dans l alert log', () => {
    seedSchema();
    const victim = liveSession('hr/hr');
    const cible = sidSerialOf('HR');
    asSys([`ALTER SYSTEM KILL SESSION '${cible}';`]);
    expect(srv.executeShellCommandSync(`grep -i "kill session" ${ALERT}`))
      .toMatch(new RegExp(`Kill Session#: ${cible.split(',')[0]}, Serial#: ${cible.split(',')[1]}`));
    victim.close();
  });

  it('DISCONNECT SESSION IMMEDIATE termine de la meme facon', () => {
    seedSchema();
    const victim = liveSession('hr/hr');
    asSys([`ALTER SYSTEM DISCONNECT SESSION '${sidSerialOf('HR')}' IMMEDIATE;`]);
    expect(victim.run('SELECT * FROM DUAL;')).toContain('ORA-00028');
    victim.close();
  });

  it('une session inconnue repond ORA-00031', () => {
    expect(asSys(["ALTER SYSTEM KILL SESSION '9999,9999';"])[0]).toContain('ORA-00031');
  });

  it('un utilisateur ordinaire ne peut pas tuer', () => {
    seedSchema();
    const hr = liveSession('hr/hr');
    expect(hr.run("ALTER SYSTEM KILL SESSION '1,1';")).toContain('ORA-01031');
    hr.close();
  });

  it('TEMOIN — une session que personne ne tue traverse le lot', () => {
    seedSchema();
    const paisible = liveSession('hr/hr');
    expect(paisible.run('INSERT INTO hr.emp VALUES (3);')).toContain('1 row created.');
    expect(paisible.run('COMMIT;')).toContain('Commit complete.');
    expect(count(paisible.run('SELECT COUNT(*) FROM hr.emp;'))).toBe(2);
    expect(asSys(["SELECT status FROM v$session WHERE username = 'HR';"])[0]).toMatch(/ACTIVE/);
    paisible.close();
  });
});

describe('les limites de profil qui coupent une session', () => {
  it('IDLE_TIME : la session devient SNIPED puis recoit ORA-02396', () => {
    seedSchema();
    asSys(['CREATE PROFILE p_idle LIMIT IDLE_TIME 5;', 'ALTER USER hr PROFILE p_idle;']);
    const dormeuse = liveSession('hr/hr');
    const db = getOracleDatabase(srv.getId());
    const info = db.securityEngine.sessions.getAllSessions().find(s => s.username === 'HR');
    db.idleMonitor.bumpIdle(info!.sessionId, 600);
    expect(asSys(["SELECT username, status FROM v$session WHERE username = 'HR';"])[0])
      .toMatch(/HR\s+SNIPED/);
    expect(dormeuse.run('SELECT * FROM DUAL;'))
      .toContain('ORA-02396: exceeded maximum idle time, please connect again');
    expect(dormeuse.run('SELECT * FROM DUAL;')).toContain('ORA-01012');
    dormeuse.close();
  });

  it('CONNECT_TIME : la session recoit ORA-02399', () => {
    seedSchema();
    asSys(['CREATE PROFILE p_conn LIMIT CONNECT_TIME 1;', 'ALTER USER hr PROFILE p_conn;']);
    const ancienne = liveSession('hr/hr');
    const db = getOracleDatabase(srv.getId());
    const info = db.securityEngine.sessions.getAllSessions().find(s => s.username === 'HR');
    db.idleMonitor.bumpConnected(info!.sessionId, 600);
    expect(ancienne.run('SELECT * FROM DUAL;'))
      .toContain('ORA-02399: exceeded maximum connect time, you are being logged off');
    ancienne.close();
  });

  it('LAST_CALL_ET compte le temps ECOULE, pas un compteur fige a zero', () => {
    seedSchema();
    const s = liveSession('hr/hr');
    const db = getOracleDatabase(srv.getId());
    const info = db.securityEngine.sessions.getAllSessions().find(x => x.username === 'HR');
    info!.lastCallAt = new Date(Date.now() - 120_000);
    const lu = asSys(["SELECT last_call_et FROM v$session WHERE username = 'HR';"])[0];
    expect(count(lu)).toBeGreaterThanOrEqual(120);
    s.close();
  });
});

describe('les parametres statiques et le GRANT a soi-meme', () => {
  it('AUDIT_TRAIL et SESSIONS refusent une modification a chaud (ORA-02095)', () => {
    expect(asSys(['ALTER SYSTEM SET audit_trail = NONE;'])[0])
      .toContain('ORA-02095: specified initialization parameter cannot be modified');
    expect(asSys(['ALTER SYSTEM SET sessions = 2;'])[0]).toContain('ORA-02095');
    expect(asSys(['ALTER SYSTEM SET audit_trail = NONE SCOPE=SPFILE;'])[0])
      .toContain('System altered.');
  });

  it('TEMOIN — un parametre DYNAMIQUE reste modifiable a chaud', () => {
    expect(asSys(["ALTER SYSTEM SET db_recovery_file_dest_size = '20G';"])[0])
      .toContain('System altered.');
  });

  it('ORA-01749 vaut pour soi-meme comme pour le proprietaire', () => {
    seedSchema();
    asSys([
      'CREATE USER bob IDENTIFIED BY bobpass;',
      'GRANT CREATE SESSION TO bob;',
      'GRANT SELECT ON hr.emp TO bob WITH GRANT OPTION;',
      'CREATE USER carol IDENTIFIED BY c;',
    ]);
    const bob = session(['bob/bobpass']);
    expect(bob.run('GRANT SELECT ON hr.emp TO bob;')).toContain('ORA-01749');
    expect(bob.run('GRANT SELECT ON hr.emp TO hr;')).toContain('ORA-01749');
    expect(bob.run('GRANT SELECT ON hr.emp TO carol;')).toContain('Grant succeeded.');
    bob.close();
  });
});
