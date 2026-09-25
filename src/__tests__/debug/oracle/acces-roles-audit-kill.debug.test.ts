/**
 * Suite de RELEVE — deuxieme passage, cible sur ce que le premier a
 * laisse dans l'ombre : les roles comme PORTEURS de privileges, l'effet
 * reel d'un KILL SESSION sur la victime, et ce que la journalisation
 * enregistre VRAIMENT quand une option d'audit la nomme.
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
  srv = new LinuxServer('linux-server', 'ORA-SEC2', 0, 0);
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

const flat = (s: string, n = 400) => s.replace(/\s+/g, ' ').trim().slice(0, n);

describe('roles, victimes de KILL, et ce que l audit enregistre', () => {
  it('releve', () => {
    asSys([
      'CREATE USER hr IDENTIFIED BY hr;',
      'GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO hr;',
      'CREATE TABLE hr.emp (id NUMBER, salaire NUMBER);',
      'INSERT INTO hr.emp VALUES (1, 1000);',
      'COMMIT;',
      'CREATE USER bob IDENTIFIED BY bobpass;',
      'GRANT CREATE SESSION TO bob;',
    ]);

    note('=== E. LES ROLES PORTENT-ILS LES PRIVILEGES ? ===');
    note(flat(asSys([
      'CREATE ROLE r_lecture;',
      'GRANT SELECT ON hr.emp TO r_lecture;',
      'GRANT r_lecture TO bob;',
    ]).join(' | ')));
    const bob = session(['bob/bobpass']);
    note(`[E-1] SELECT via le ROLE : ${flat(bob.run('SELECT * FROM hr.emp;'), 120)}`);
    note(`[E-2] SESSION_ROLES : ${flat(bob.run('SELECT role FROM session_roles;'), 120)}`);
    note(`[E-3] DBA_ROLE_PRIVS : ${flat(asSys(["SELECT grantee, granted_role, default_role FROM dba_role_privs WHERE grantee = 'BOB';"])[0], 200)}`);
    note(`[E-4] ROLE_TAB_PRIVS : ${flat(asSys(["SELECT role, owner, table_name, privilege FROM role_tab_privs WHERE role = 'R_LECTURE';"])[0], 200)}`);
    bob.close();
    note(flat(asSys(['ALTER USER bob DEFAULT ROLE NONE;'])[0], 80));
    const bob2 = session(['bob/bobpass']);
    note(`[E-5] role NON par defaut, SELECT : ${flat(bob2.run('SELECT * FROM hr.emp;'), 120)}`);
    note(`[E-6] SET ROLE r_lecture : ${flat(bob2.run('SET ROLE r_lecture;'), 120)}`);
    note(`[E-7] puis SELECT : ${flat(bob2.run('SELECT * FROM hr.emp;'), 120)}`);
    bob2.close();
    note(`[E-8] role avec mot de passe : ${flat(asSys(['CREATE ROLE r_secret IDENTIFIED BY secret;', 'GRANT r_secret TO bob;']).join(' | '), 160)}`);
    note(`[E-9] ADMIN OPTION : ${flat(asSys(['GRANT SELECT ANY TABLE TO bob WITH ADMIN OPTION;'])[0], 80)}`);
    const bob3 = session(['bob/bobpass']);
    note(`[E-10] bob re-accorde le privilege : ${flat(bob3.run('GRANT SELECT ANY TABLE TO hr;'), 120)}`);
    note(`[E-11] GRANT OPTION sur objet : ${flat(asSys(['GRANT SELECT ON hr.emp TO bob WITH GRANT OPTION;'])[0], 80)}`);
    note(`[E-12] bob re-accorde l objet : ${flat(bob3.run('GRANT SELECT ON hr.emp TO hr;'), 120)}`);
    note(`[E-13] DBA_TAB_PRIVS (grantable) : ${flat(asSys(["SELECT grantee, owner, table_name, privilege, grantable FROM dba_tab_privs WHERE grantee IN ('BOB','HR');"])[0], 300)}`);
    note(`[E-14] DBA_COL_PRIVS : ${flat(asSys(["SELECT grantee, column_name, privilege FROM dba_col_privs;"])[0], 200)}`);
    bob3.close();

    note('');
    note('=== F. LA VICTIME D UN KILL ===');
    const victime = session(['hr/hr']);
    victime.run('CREATE TABLE hr.t_kill (id NUMBER);');
    victime.run('INSERT INTO hr.t_kill VALUES (1);');
    const ligne = asSys(["SELECT sid, serial# FROM v$session WHERE username = 'HR';"])[0];
    note(`[F-1] la session de HR : ${flat(ligne, 120)}`);
    const nums = /(\d+)\s+(\d+)/.exec(ligne.split('\n').filter(l => /\d/.test(l)).join('\n'));
    const cible = nums ? `${nums[1]},${nums[2]}` : '1,1';
    note(`[F-2] KILL SESSION '${cible}' : ${flat(asSys([`ALTER SYSTEM KILL SESSION '${cible}';`])[0], 120)}`);
    note(`[F-3] V$SESSION voit-elle encore HR ? ${flat(asSys(["SELECT COUNT(*) FROM v$session WHERE username = 'HR';"])[0], 80)}`);
    note(`[F-4] la victime : SELECT      -> ${flat(victime.run('SELECT * FROM DUAL;'), 90)}`);
    note(`[F-5] la victime : COMMIT      -> ${flat(victime.run('COMMIT;'), 90)}`);
    note(`[F-6] la victime : INSERT      -> ${flat(victime.run('INSERT INTO hr.t_kill VALUES (2);'), 90)}`);
    note(`[F-7] la transaction non validee a-t-elle ete annulee ? ${flat(asSys(['SELECT COUNT(*) FROM hr.t_kill;'])[0], 90)}`);
    victime.close();
    note(`[F-8] un utilisateur ORDINAIRE peut-il tuer une session ? ${flat(
      (() => { const b = session(['bob/bobpass']); const r = b.run("ALTER SYSTEM KILL SESSION '1,1';"); b.close(); return r; })(), 140)}`);

    note('');
    note('=== G. CE QUE L AUDIT ENREGISTRE ===');
    asSys(['AUDIT SELECT ON hr.emp BY ACCESS;']);
    const lecteur = session(['bob/bobpass']);
    lecteur.run('SELECT * FROM hr.emp;');
    lecteur.run('SELECT * FROM hr.emp;');
    lecteur.close();
    note(`[G-1] DBA_AUDIT_TRAIL pour EMP : ${flat(asSys(["SELECT username, obj_name, action_name, returncode FROM dba_audit_trail WHERE obj_name = 'EMP';"])[0], 300)}`);
    note(`[G-2] DBA_AUDIT_OBJECT : ${flat(asSys(["SELECT username, obj_name, action_name FROM dba_audit_object;"])[0], 250)}`);
    note(`[G-3] NOAUDIT puis un acces de plus : ${flat(asSys(['NOAUDIT SELECT ON hr.emp;'])[0], 80)}`);
    const lecteur2 = session(['bob/bobpass']);
    lecteur2.run('SELECT * FROM hr.emp;');
    lecteur2.close();
    note(`      lignes pour EMP apres NOAUDIT : ${flat(asSys(["SELECT COUNT(*) FROM dba_audit_trail WHERE obj_name = 'EMP';"])[0], 90)}`);
    note(`[G-4] AUDIT ... WHENEVER NOT SUCCESSFUL : ${flat(asSys(['AUDIT DELETE ON hr.emp WHENEVER NOT SUCCESSFUL;'])[0], 90)}`);
    note(`      DBA_OBJ_AUDIT_OPTS (del) : ${flat(asSys(["SELECT object_name, del, sel FROM dba_obj_audit_opts WHERE object_name = 'EMP';"])[0], 200)}`);
    const suppr = session(['bob/bobpass']);
    note(`      DELETE refuse : ${flat(suppr.run('DELETE FROM hr.emp;'), 110)}`);
    suppr.close();
    note(`      la tentative ECHOUEE est-elle enregistree ? ${flat(asSys(["SELECT username, action_name, returncode FROM dba_audit_trail WHERE action_name LIKE '%DELETE%';"])[0], 200)}`);
    note(`[G-5] politique unifiee sur SELECT : ${flat(asSys(['CREATE AUDIT POLICY pol_emp ACTIONS SELECT ON hr.emp;', 'AUDIT POLICY pol_emp;']).join(' | '), 120)}`);
    const u = session(['bob/bobpass']);
    u.run('SELECT * FROM hr.emp;');
    u.close();
    note(`      UNIFIED_AUDIT_TRAIL pour EMP : ${flat(asSys(["SELECT dbusername, action_name, object_name, unified_audit_policies FROM unified_audit_trail WHERE object_name = 'EMP';"])[0], 300)}`);
    note(`[G-6] NOAUDIT POLICY : ${flat(asSys(['NOAUDIT POLICY pol_emp;'])[0], 80)}`);
    note(`      AUDIT_UNIFIED_ENABLED_POLICIES : ${flat(asSys(['SELECT policy_name FROM audit_unified_enabled_policies;'])[0], 200)}`);
    note(`[G-7] audit d un PRIVILEGE : ${flat(asSys(['AUDIT CREATE TABLE;'])[0], 80)} / DBA_PRIV_AUDIT_OPTS : ${flat(asSys(['SELECT privilege, success, failure FROM dba_priv_audit_opts;'])[0], 200)}`);
    note(`[G-8] audit_trail = NONE, l audit s arrete-t-il ? ${flat(asSys(["ALTER SYSTEM SET audit_trail = NONE SCOPE=SPFILE;"])[0], 90)}`);

    expect(true).toBe(true);
  });
});
