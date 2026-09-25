/**
 * Suite de RELEVE — recensement des VUES du dictionnaire et des vues
 * dynamiques : chacune rend-elle quelque chose, et QUI a le droit de la
 * lire ?
 *
 * Deux questions distinctes :
 *   1. la vue remplit-elle son role, ou rend-elle un ensemble vide quel
 *      que soit l'etat de la base ?
 *   2. l'acces est-il realiste ? Sur un vrai Oracle, un utilisateur sans
 *      privilege de catalogue ne voit NI les V$ NI les DBA_ (ORA-00942) ;
 *      les ALL_ et USER_ sont publiques mais FILTREES par ligne.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { listRegisteredViews } from '@/database/oracle/views/registry';
import '@/database/oracle/views';

const note = (l: string) => { console.log(l); };
let db: OracleDatabase;
let sys: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup();
  sys = db.connectAsSysdba().executor;
});

function asSys(sql: string): string {
  try {
    const r = db.executeSql(sys, sql);
    return `rows=${r.rows.length}`;
  } catch (e) {
    return `ERR ${(e as Error).message.slice(0, 60)}`;
  }
}

describe('recensement des vues', () => {
  it('releve', () => {
    db.executeSql(sys, 'GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO hr');
    db.executeSql(sys, 'CREATE TABLE hr.emp_probe (id NUMBER, nom VARCHAR2(20))');
    db.executeSql(sys, "INSERT INTO hr.emp_probe VALUES (1, 'A')");
    db.executeSql(sys, 'COMMIT');
    db.executeSql(sys, 'CREATE USER bob IDENTIFIED BY bobpass');
    db.executeSql(sys, 'GRANT CREATE SESSION TO bob');
    const bob = db.connect('BOB', 'bobpass');

    const views = listRegisteredViews().map(v => v.name.toUpperCase()).sort();
    note(`[V-0] vues enregistrees : ${views.length}`);

    const vides: string[] = [];
    const erreurs: string[] = [];
    const parFamille = new Map<string, { total: number; vides: number }>();
    for (const name of views) {
      const famille = name.startsWith('V$') ? 'V$'
        : name.startsWith('GV$') ? 'GV$'
        : name.startsWith('DBA_') ? 'DBA_'
        : name.startsWith('ALL_') ? 'ALL_'
        : name.startsWith('USER_') ? 'USER_'
        : name.startsWith('ROLE_') ? 'ROLE_'
        : 'autres';
      const stat = parFamille.get(famille) ?? { total: 0, vides: 0 };
      stat.total++;
      const verdict = asSys(`SELECT * FROM ${name}`);
      if (verdict.startsWith('ERR')) erreurs.push(`${name} ${verdict}`);
      else if (verdict === 'rows=0') { vides.push(name); stat.vides++; }
      parFamille.set(famille, stat);
    }
    note('[V-1] par famille : total / vides comme SYS sur une base seedee');
    for (const [f, s] of [...parFamille.entries()].sort()) {
      note(`      ${f.padEnd(8)} ${String(s.total).padStart(4)} / ${String(s.vides).padStart(4)} vides`);
    }
    note(`[V-2] vues en ERREUR : ${erreurs.length}`);
    for (const e of erreurs.slice(0, 15)) note(`      ${e}`);

    note('');
    note('[A-1] ACCES : un utilisateur sans privilege de catalogue lit-il ces vues ?');
    const echantillon = [
      'V$SESSION', 'V$DATABASE', 'V$PARAMETER', 'V$INSTANCE', 'V$DATAFILE',
      'DBA_USERS', 'DBA_TAB_PRIVS', 'DBA_SYS_PRIVS', 'DBA_TABLES', 'DBA_AUDIT_TRAIL',
      'ALL_TABLES', 'USER_TABLES', 'SESSION_PRIVS', 'SESSION_ROLES', 'DICTIONARY',
      'GV$SESSION', 'V$RESTORE_POINT', 'DBA_PROFILES',
    ];
    for (const v of echantillon) {
      let verdict: string;
      try {
        const r = db.executeSql(bob.executor, `SELECT * FROM ${v}`);
        verdict = `LU (${r.rows.length} lignes)`;
      } catch (e) {
        verdict = (e as Error).message.slice(0, 48);
      }
      note(`      ${v.padEnd(18)} ${verdict}`);
    }

    note('');
    note('[A-2] FILTRAGE par ligne des vues publiques, vu par BOB');
    const filtre = (sql: string): string => {
      try {
        const r = db.executeSql(bob.executor, sql);
        return `${r.rows.length} lignes : ${r.rows.slice(0, 4).map(row => String(row[0]) + '.' + String(row[1])).join(' ')}`;
      } catch (e) { return (e as Error).message.slice(0, 60); }
    };
    note(`      USER_TABLES (bob n a aucune table) : ${filtre('SELECT table_name, tablespace_name FROM user_tables')}`);
    note(`      ALL_TABLES  (sans privilege sur HR.EMP) : ${filtre("SELECT owner, table_name FROM all_tables WHERE table_name = 'EMP_PROBE'")}`);
    db.executeSql(sys, 'GRANT SELECT ON hr.emp_probe TO bob');
    note(`      ALL_TABLES  (apres GRANT SELECT) : ${filtre("SELECT owner, table_name FROM all_tables WHERE table_name = 'EMP_PROBE'")}`);
    note(`      USER_TAB_PRIVS_RECD : ${filtre('SELECT owner, table_name FROM user_tab_privs_recd')}`);

    note('');
    note('[A-3] avec SELECT_CATALOG_ROLE, puis apres revocation');
    db.executeSql(sys, 'GRANT SELECT_CATALOG_ROLE TO bob');
    const bob2 = db.connect('BOB', 'bobpass');
    for (const v of ['V$SESSION', 'DBA_USERS']) {
      let verdict: string;
      try { verdict = `LU (${db.executeSql(bob2.executor, `SELECT * FROM ${v}`).rows.length})`; }
      catch (e) { verdict = (e as Error).message.slice(0, 48); }
      note(`      ${v.padEnd(12)} ${verdict}`);
    }

    note('');
    note('[A-3b] le GRANT explicite sur V_$SESSION (la recette reelle)');
    db.executeSql(sys, 'CREATE USER dave IDENTIFIED BY d');
    db.executeSql(sys, 'GRANT CREATE SESSION TO dave');
    const dave = db.connect('DAVE', 'd');
    const lire = (ex: typeof dave.executor, v: string): string => {
      try { return `LU (${db.executeSql(ex, `SELECT * FROM ${v}`).rows.length})`; }
      catch (e) { return (e as Error).message.slice(0, 48); }
    };
    note(`      avant : V$SESSION ${lire(dave.executor, 'V$SESSION')} | V$DATAFILE ${lire(dave.executor, 'V$DATAFILE')}`);
    let octroi = 'ok';
    try { db.executeSql(sys, 'GRANT SELECT ON v_$session TO dave'); }
    catch (e) { octroi = (e as Error).message.slice(0, 60); }
    note(`      GRANT SELECT ON v_$session TO dave : ${octroi}`);
    const dave2 = db.connect('DAVE', 'd');
    note(`      apres : V$SESSION ${lire(dave2.executor, 'V$SESSION')} | V$DATAFILE ${lire(dave2.executor, 'V$DATAFILE')}`);

    note('');
    note('[R-1] V$RESOURCE_LIMIT, sessions/processes : suit-il l etat vivant ?');
    note(`      ${JSON.stringify(db.executeSql(sys, "SELECT resource_name, current_utilization, max_utilization, limit_value FROM v$resource_limit WHERE resource_name IN ('sessions','processes')").rows)}`);
    note(`      V$LICENSE : ${JSON.stringify(db.executeSql(sys, 'SELECT sessions_current, sessions_max FROM v$license').rows)}`);
    note(`      V$SESSION : ${JSON.stringify(db.executeSql(sys, 'SELECT COUNT(*) FROM v$session').rows)}`);

    note('');
    note('[A-4] les V$ en MOUNT (vues fixes) vs les DBA_ (dictionnaire absent)');
    db.instance.shutdown();
    db.instance.startup('MOUNT');
    const sys2 = db.connectAsSysdba().executor;
    for (const v of ['V$DATABASE', 'V$SESSION', 'DBA_USERS', 'ALL_TABLES']) {
      let verdict: string;
      try { verdict = `LU (${db.executeSql(sys2, `SELECT * FROM ${v}`).rows.length})`; }
      catch (e) { verdict = (e as Error).message.slice(0, 56); }
      note(`      ${v.padEnd(12)} ${verdict}`);
    }

    expect(true).toBe(true);
  });
});
