/**
 * Sonde — QUI peut lire les vues du dictionnaire, et les vues du meme
 * fait s'accordent-elles ?
 *
 * Le banc `debug/oracle/vues-recensement` a interroge les 450 vues
 * enregistrees comme SYS, puis comme un utilisateur n'ayant que CREATE
 * SESSION. Deux defauts symetriques :
 *
 *   - les vues V$ et GV$ etaient LIBREMENT lisibles par n'importe qui :
 *     V$SESSION, V$DATABASE, V$PARAMETER, V$DATAFILE rendaient leurs
 *     lignes a un utilisateur sans aucun privilege de catalogue, alors
 *     que les DBA_ etaient correctement refusees (ORA-00942). Deux
 *     familles de meme nature, deux traitements.
 *   - les vues ALL_ et USER_ etaient refusees a TOUT LE MONDE sauf aux
 *     DBA : elles derivaient de la vue DBA_ correspondante et heritaient
 *     donc de son controle de privilege. Sur une vraie base ce sont les
 *     vues PUBLIQUES par excellence — tout utilisateur lit USER_TABLES
 *     (ses objets) et ALL_TABLES (ce qu'il a le droit de voir).
 *
 * Et la recette reelle par laquelle un DBA ouvre UNE vue a UN
 * utilisateur — `GRANT SELECT ON v_$session TO app_user` — echouait en
 * ORA-00942 : la verification d'existence de l'objet ne connaissait pas
 * les vues fixes.
 *
 * Le controle est desormais ECRIT UNE FOIS (`canAccessDictionaryViews`)
 * et partage par les deux familles, avec pour les V$ le chemin d'octroi
 * explicite en plus (SELECT sur SYS.V_$X, ou V$X).
 *
 * TROISIEME DEFAUT, de coherence : trois vues comptaient les sessions et
 * donnaient trois reponses. V$SESSION en listait 9, V$LICENSE en
 * annoncait 0 et V$RESOURCE_LIMIT 1 — cette derniere avec des lignes
 * ECRITES EN DUR (« sessions, 1, 1, 472 »), y compris sa limite, qui ne
 * lisait pas le parametre `sessions`. Les trois lisent maintenant le
 * meme compte.
 *
 * Discrimination par `git stash push -- src/database` : 8 cas sur 14
 * tombent avant (mesure).
 *
 * Les SIX qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN — les DBA_ restent refusees a un utilisateur ordinaire » :
 *    non-regression du controle qui, lui, existait.
 *  - « TEMOIN — SYS lit tout » : TEMOIN. Sans lui, tout fermer passerait.
 *  - « TEMOIN — une connexion SYSOPER lit les vues fixes » : TEMOIN.
 *    Un operateur dont le metier est de demarrer et d'arreter l'instance
 *    doit pouvoir interroger V$INSTANCE et V$SESSION ; c'est la
 *    connexion, non un privilege accorde, qui l'y autorise.
 *  - « TEMOIN — SESSION_PRIVS et SESSION_ROLES restent publiques » :
 *    TEMOIN. Ces deux vues DOIVENT rester lisibles par leur session.
 *  - « SELECT_CATALOG_ROLE ouvre les DBA_ » : non-regression.
 *  - « SELECT ANY DICTIONARY les ouvre aussi » : le privilege systeme
 *    passait deja pour les DBA_, et la V$ qu'il ouvre etait libre avant ;
 *    le cas garde les deux portes ensemble apres le lot.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import '@/database/oracle/views';

let db: OracleDatabase;
let sys: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup();
  sys = db.connectAsSysdba().executor;
  db.executeSql(sys, 'GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO hr');
  db.executeSql(sys, 'CREATE TABLE hr.emp_vues (id NUMBER)');
  db.executeSql(sys, 'CREATE USER bob IDENTIFIED BY bobpass');
  db.executeSql(sys, 'GRANT CREATE SESSION TO bob');
});

function connect(user: string, password: string) {
  return db.connect(user, password);
}

function read(executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'], view: string):
  { ok: true; rows: unknown[][] } | { ok: false; error: string } {
  try {
    return { ok: true, rows: db.executeSql(executor, `SELECT * FROM ${view}`).rows };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const refused = (r: ReturnType<typeof read>): boolean =>
  r.ok === false && r.error.includes('ORA-00942');

function scalar(executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'], sql: string): number {
  const rows = db.executeSql(executor, sql).rows;
  return Number(rows[0]?.[0] ?? -1);
}

describe('les vues fixes V$ se gagnent', () => {
  it('un utilisateur sans privilege de catalogue ne les voit pas', () => {
    const bob = connect('BOB', 'bobpass');
    for (const v of ['V$SESSION', 'V$DATABASE', 'V$PARAMETER', 'V$DATAFILE', 'GV$SESSION']) {
      expect(refused(read(bob.executor, v))).toBe(true);
    }
  });

  it('SELECT_CATALOG_ROLE les ouvre, et une revocation les referme', () => {
    db.executeSql(sys, 'GRANT SELECT_CATALOG_ROLE TO bob');
    const avecRole = connect('BOB', 'bobpass');
    expect(read(avecRole.executor, 'V$SESSION').ok).toBe(true);
    db.executeSql(sys, 'REVOKE SELECT_CATALOG_ROLE FROM bob');
    const sansRole = connect('BOB', 'bobpass');
    expect(refused(read(sansRole.executor, 'V$SESSION'))).toBe(true);
  });

  it('SELECT ANY DICTIONARY les ouvre aussi', () => {
    db.executeSql(sys, 'GRANT SELECT ANY DICTIONARY TO bob');
    const bob = connect('BOB', 'bobpass');
    expect(read(bob.executor, 'V$INSTANCE').ok).toBe(true);
  });

  it('GRANT SELECT ON v_$session ouvre CETTE vue et pas les autres', () => {
    db.executeSql(sys, 'GRANT SELECT ON v_$session TO bob');
    const bob = connect('BOB', 'bobpass');
    expect(read(bob.executor, 'V$SESSION').ok).toBe(true);
    expect(refused(read(bob.executor, 'V$DATAFILE'))).toBe(true);
    expect(refused(read(bob.executor, 'DBA_USERS'))).toBe(true);
  });

  it('TEMOIN — les DBA_ restent refusees a un utilisateur ordinaire', () => {
    const bob = connect('BOB', 'bobpass');
    for (const v of ['DBA_USERS', 'DBA_TABLES', 'DBA_SYS_PRIVS', 'DBA_PROFILES']) {
      expect(refused(read(bob.executor, v))).toBe(true);
    }
  });

  it('TEMOIN — une connexion SYSOPER lit les vues fixes', () => {
    const operateur = db.connectAsSysoper();
    expect(read(operateur.executor, 'V$INSTANCE').ok).toBe(true);
    expect(read(operateur.executor, 'V$SESSION').ok).toBe(true);
  });

  it('TEMOIN — SYS lit tout', () => {
    for (const v of ['V$SESSION', 'GV$SESSION', 'DBA_USERS', 'ALL_TABLES', 'USER_TABLES']) {
      expect(read(sys, v).ok).toBe(true);
    }
  });

  it('SELECT_CATALOG_ROLE ouvre les DBA_', () => {
    db.executeSql(sys, 'GRANT SELECT_CATALOG_ROLE TO bob');
    const bob = connect('BOB', 'bobpass');
    expect(read(bob.executor, 'DBA_USERS').ok).toBe(true);
  });
});

describe('les vues ALL_ et USER_ sont publiques, et filtrees par ligne', () => {
  it('USER_TABLES est lisible et ne montre que les tables de son proprietaire', () => {
    const bob = connect('BOB', 'bobpass');
    const vide = read(bob.executor, 'USER_TABLES');
    expect(vide.ok).toBe(true);
    expect(vide.ok && vide.rows.length).toBe(0);
    db.executeSql(sys, 'GRANT CREATE TABLE, UNLIMITED TABLESPACE TO bob');
    const bob2 = connect('BOB', 'bobpass');
    db.executeSql(bob2.executor, 'CREATE TABLE bob.t_bob (id NUMBER)');
    const apres = db.executeSql(bob2.executor, "SELECT table_name FROM user_tables");
    expect(apres.rows.map(r => String(r[0]))).toContain('T_BOB');
    expect(apres.rows.map(r => String(r[0]))).not.toContain('EMP_VUES');
  });

  it('ALL_TABLES ne montre la table d autrui qu apres le GRANT', () => {
    const bob = connect('BOB', 'bobpass');
    const avant = db.executeSql(bob.executor,
      "SELECT owner, table_name FROM all_tables WHERE table_name = 'EMP_VUES'");
    expect(avant.rows).toHaveLength(0);
    db.executeSql(sys, 'GRANT SELECT ON hr.emp_vues TO bob');
    const bob2 = connect('BOB', 'bobpass');
    const apres = db.executeSql(bob2.executor,
      "SELECT owner, table_name FROM all_tables WHERE table_name = 'EMP_VUES'");
    expect(apres.rows.map(r => r.join('.'))).toEqual(['HR.EMP_VUES']);
  });

  it('TEMOIN — SESSION_PRIVS et SESSION_ROLES restent publiques', () => {
    const bob = connect('BOB', 'bobpass');
    const privs = read(bob.executor, 'SESSION_PRIVS');
    expect(privs.ok).toBe(true);
    expect(privs.ok && privs.rows.map(r => String(r[0]))).toContain('CREATE SESSION');
    expect(read(bob.executor, 'SESSION_ROLES').ok).toBe(true);
  });
});

describe('un seul compte de sessions pour les trois vues qui le rapportent', () => {
  it('V$SESSION, V$LICENSE et V$RESOURCE_LIMIT s accordent', () => {
    const dansSession = scalar(sys, 'SELECT COUNT(*) FROM v$session');
    const licence = scalar(sys, 'SELECT sessions_current FROM v$license');
    const limite = scalar(sys,
      "SELECT current_utilization FROM v$resource_limit WHERE resource_name = 'sessions'");
    expect(licence).toBe(dansSession);
    expect(limite).toBe(dansSession);
  });

  it('le compte AVANCE quand une session s ouvre', () => {
    const avant = scalar(sys, 'SELECT COUNT(*) FROM v$session');
    connect('BOB', 'bobpass');
    const apres = scalar(sys, 'SELECT COUNT(*) FROM v$session');
    expect(apres).toBe(avant + 1);
    expect(scalar(sys, 'SELECT sessions_current FROM v$license')).toBe(apres);
    expect(scalar(sys,
      "SELECT current_utilization FROM v$resource_limit WHERE resource_name = 'sessions'"))
      .toBe(apres);
  });

  it('V$RESOURCE_LIMIT lit la LIMITE dans le parametre, pas dans une constante', () => {
    const attendu = db.instance.getParameter('sessions');
    const lu = db.executeSql(sys,
      "SELECT limit_value FROM v$resource_limit WHERE resource_name = 'sessions'").rows[0][0];
    expect(String(lu)).toBe(String(attendu));
    const processus = db.executeSql(sys,
      "SELECT current_utilization FROM v$resource_limit WHERE resource_name = 'processes'").rows[0][0];
    expect(Number(processus)).toBe(
      db.instance.getBackgroundProcesses().length + db.instance.getServerProcesses().length);
  });
});
