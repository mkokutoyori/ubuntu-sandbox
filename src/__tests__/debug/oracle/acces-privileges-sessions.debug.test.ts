/**
 * Suite de RELEVE — `src/__tests__/debug/`.
 *
 * La gestion des ACCES d'Oracle, mesuree la ou elle se voit : les
 * privileges (systeme, objet, colonne, roles), les sessions (V$SESSION,
 * KILL SESSION, limites de profil), les comptes (verrouillage,
 * expiration, tentatives echouees) et la JOURNALISATION (AUDIT
 * classique, politiques unifiees, audit fin).
 *
 * Aucune assertion de contrat : ce banc imprime ce que la machine
 * repond, pour que le lot suivant sache ou est le manque.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

const note = (l: string) => { console.log(l); };
let srv: LinuxServer;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  srv = new LinuxServer('linux-server', 'ORA-SEC', 0, 0);
  SqlPlusSubShell.create(srv, ['/', 'as', 'sysdba']).subShell.dispose();
});

function session(args: string[]): { run: (sql: string) => string; close: () => void; login: string } {
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

const flat = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 150);

describe('les acces Oracle : privileges, sessions, comptes, journalisation', () => {
  it('releve', () => {
    asSys([
      'CREATE USER hr IDENTIFIED BY hr;',
      'GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO hr;',
      'CREATE USER bob IDENTIFIED BY bobpass;',
      'CREATE TABLE hr.emp (id NUMBER, salaire NUMBER);',
      'INSERT INTO hr.emp VALUES (1, 1000);',
      'COMMIT;',
    ]);

    note('=== A. PRIVILEGES ===');
    const bobSansSession = session(['bob/bobpass']);
    note(`[A-1] logon sans CREATE SESSION : ${flat(bobSansSession.login)}`);
    note(`[A-2] et une requete passe-t-elle ? ${flat(bobSansSession.run('SELECT * FROM DUAL;'))}`);
    bobSansSession.close();

    asSys(['GRANT CREATE SESSION TO bob;']);
    const bob = session(['bob/bobpass']);
    note(`[A-3] logon avec CREATE SESSION : ${flat(bob.login)}`);
    note(`[A-4] SELECT sur la table d autrui : ${flat(bob.run('SELECT * FROM hr.emp;'))}`);
    note(`[A-5] CREATE TABLE sans le privilege : ${flat(bob.run('CREATE TABLE t_bob (id NUMBER);'))}`);
    note(`[A-6] DROP de la table d autrui : ${flat(bob.run('DROP TABLE hr.emp;'))}`);
    note(`[A-7] UPDATE sur la table d autrui : ${flat(bob.run('UPDATE hr.emp SET salaire = 0;'))}`);
    note(`[A-8] SESSION_PRIVS : ${flat(bob.run('SELECT privilege FROM session_privs;'))}`);
    note(`[A-9] SESSION_ROLES : ${flat(bob.run('SELECT role FROM session_roles;'))}`);

    asSys(['GRANT SELECT ON hr.emp TO bob;']);
    note(`[A-10] apres GRANT SELECT : ${flat(bob.run('SELECT * FROM hr.emp;'))}`);
    asSys(['REVOKE SELECT ON hr.emp FROM bob;']);
    note(`[A-11] apres REVOKE      : ${flat(bob.run('SELECT * FROM hr.emp;'))}`);

    asSys(['GRANT SELECT (id) ON hr.emp TO bob;']);
    note(`[A-12] privilege de COLONNE, colonne permise : ${flat(bob.run('SELECT id FROM hr.emp;'))}`);
    note(`[A-13] privilege de COLONNE, colonne interdite : ${flat(bob.run('SELECT salaire FROM hr.emp;'))}`);

    note(`[A-14] GRANT sans ADMIN OPTION par bob : ${flat(bob.run('GRANT CREATE SESSION TO hr;'))}`);
    asSys(['GRANT SELECT ANY TABLE TO bob;']);
    note(`[A-15] SELECT ANY TABLE : ${flat(bob.run('SELECT * FROM hr.emp;'))}`);
    note(`[A-16] DBA_SYS_PRIVS pour bob : ${flat(asSys(["SELECT privilege, admin_option FROM dba_sys_privs WHERE grantee = 'BOB';"])[0])}`);
    note(`[A-17] DBA_TAB_PRIVS pour bob : ${flat(asSys(["SELECT owner, table_name, privilege, grantable FROM dba_tab_privs WHERE grantee = 'BOB';"])[0])}`);
    bob.close();

    note('');
    note('=== B. SESSIONS ===');
    const s1 = session(['hr/hr']);
    const s2 = session(['bob/bobpass']);
    note(`[B-1] V$SESSION (username, status, program, machine, osuser) :`);
    note(flat(asSys(["SELECT sid, serial#, username, status, osuser, machine, program FROM v$session WHERE username IS NOT NULL;"])[0]));
    note(`[B-2] V$SESSION_CONNECT_INFO : ${flat(asSys(['SELECT sid, authentication_type, osuser, network_service_banner FROM v$session_connect_info;'])[0])}`);
    const ligne = asSys(["SELECT sid, serial# FROM v$session WHERE username = 'BOB';"])[0];
    note(`[B-3] la session de bob : ${flat(ligne)}`);
    const nums = ligne.match(/^\s*(\d+)\s+(\d+)\s*$/m);
    const cible = nums ? `${nums[1]},${nums[2]}` : '1,1';
    note(`[B-4] KILL SESSION '${cible}' : ${flat(asSys([`ALTER SYSTEM KILL SESSION '${cible}';`])[0])}`);
    note(`[B-5] la victime peut-elle encore travailler ? ${flat(s2.run('SELECT * FROM DUAL;'))}`);
    note(`[B-6] la ligne a-t-elle disparu de V$SESSION ? ${flat(asSys(["SELECT COUNT(*) FROM v$session WHERE username = 'BOB';"])[0])}`);
    note(`[B-7] DISCONNECT SESSION : ${flat(asSys([`ALTER SYSTEM DISCONNECT SESSION '${cible}' IMMEDIATE;`])[0])}`);
    note(`[B-8] session inexistante : ${flat(asSys(["ALTER SYSTEM KILL SESSION '999,999';"])[0])}`);
    s1.close(); s2.close();

    note('');
    note('=== C. COMPTES ET MOTS DE PASSE ===');
    asSys(['CREATE PROFILE p_strict LIMIT FAILED_LOGIN_ATTEMPTS 2 PASSWORD_LIFE_TIME 1 SESSIONS_PER_USER 1;',
           'ALTER USER bob PROFILE p_strict;']);
    note(`[C-1] mauvais mot de passe : ${flat(session(['bob/faux']).login)}`);
    note(`[C-2] deuxieme echec      : ${flat(session(['bob/faux']).login)}`);
    note(`[C-3] puis le BON mot de passe (compte verrouille ?) : ${flat(session(['bob/bobpass']).login)}`);
    note(`[C-4] DBA_USERS : ${flat(asSys(["SELECT username, account_status, lock_date, expiry_date, profile FROM dba_users WHERE username = 'BOB';"])[0])}`);
    note(`[C-5] ACCOUNT UNLOCK : ${flat(asSys(['ALTER USER bob ACCOUNT UNLOCK;'])[0])}`);
    note(`[C-6] logon apres deverrouillage : ${flat(session(['bob/bobpass']).login)}`);
    note(`[C-7] ACCOUNT LOCK explicite : ${flat(asSys(['ALTER USER bob ACCOUNT LOCK;'])[0])} / logon : ${flat(session(['bob/bobpass']).login)}`);
    asSys(['ALTER USER bob ACCOUNT UNLOCK;', 'ALTER USER bob PASSWORD EXPIRE;']);
    note(`[C-8] mot de passe EXPIRE, logon : ${flat(session(['bob/bobpass']).login)}`);
    note(`[C-9] SESSIONS_PER_USER 1 — deux sessions de bob :`);
    asSys(['ALTER USER bob IDENTIFIED BY bobpass;']);
    const b1 = session(['bob/bobpass']);
    const b2 = session(['bob/bobpass']);
    note(`      premiere : ${flat(b1.login)} | seconde : ${flat(b2.login)}`);
    b1.close(); b2.close();

    note('');
    note('=== D. JOURNALISATION ===');
    note(`[D-1] AUDIT SELECT ON hr.emp : ${flat(asSys(['AUDIT SELECT ON hr.emp BY ACCESS;'])[0])}`);
    note(`[D-2] DBA_OBJ_AUDIT_OPTS : ${flat(asSys(["SELECT owner, object_name, sel FROM dba_obj_audit_opts WHERE object_name = 'EMP';"])[0])}`);
    const bob2 = session(['bob/bobpass']);
    bob2.run('SELECT * FROM hr.emp;');
    bob2.close();
    note(`[D-3] DBA_AUDIT_TRAIL apres l acces : ${flat(asSys(["SELECT username, obj_name, action_name, returncode FROM dba_audit_trail;"])[0])}`);
    note(`[D-4] AUDIT SESSION : ${flat(asSys(['AUDIT SESSION;'])[0])}`);
    session(['bob/bobpass']).close();
    note(`[D-5] DBA_AUDIT_SESSION : ${flat(asSys(['SELECT username, action_name, logoff_time FROM dba_audit_session;'])[0])}`);
    note(`[D-6] politique unifiee : ${flat(asSys(['CREATE AUDIT POLICY pol_emp ACTIONS SELECT ON hr.emp;', 'AUDIT POLICY pol_emp;']).join(' | '))}`);
    const bob3 = session(['bob/bobpass']);
    bob3.run('SELECT * FROM hr.emp;');
    bob3.close();
    note(`[D-7] UNIFIED_AUDIT_TRAIL : ${flat(asSys(["SELECT dbusername, action_name, object_name, unified_audit_policies FROM unified_audit_trail;"])[0])}`);
    note(`[D-8] logon ECHOUE journalise ? ${flat(session(['bob/faux']).login)}`);
    note(`      UNIFIED_AUDIT_TRAIL des echecs : ${flat(asSys(["SELECT dbusername, action_name, return_code FROM unified_audit_trail WHERE return_code <> 0;"])[0])}`);
    note(`[D-9] AUDIT_UNIFIED_ENABLED_POLICIES : ${flat(asSys(['SELECT policy_name, enabled_option FROM audit_unified_enabled_policies;'])[0])}`);
    note(`[D-10] audit_trail : ${flat(asSys(["SELECT value FROM v$parameter WHERE name = 'audit_trail';"])[0])}`);
    note(`[D-11] fichier .aud sur le disque : ${srv.executeShellCommandSync('ls /u01/app/oracle/admin/ORCL/adump 2>&1').replace(/\n/g, ' ').slice(0, 120)}`);
    note(`[D-12] trace des GRANT/REVOKE dans l alert log : ${srv.executeShellCommandSync('grep -icE "grant|revoke" /u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log').trim()}`);

    expect(true).toBe(true);
  });
});
