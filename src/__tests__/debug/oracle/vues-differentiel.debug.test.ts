import { describe, it, expect } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { listRegisteredViews } from '@/database/oracle/views/registry';
import '@/database/oracle/views';

const note = (l: string) => { console.log(l); };

function snapshot(db: OracleDatabase, exec: ReturnType<OracleDatabase['connectAsSysdba']>['executor']): Map<string, string> {
  const out = new Map<string, string>();
  for (const v of listRegisteredViews()) {
    const name = v.name.toUpperCase();
    try {
      const r = db.executeSql(exec, `SELECT * FROM ${name}`);
      out.set(name, `${r.rows.length}|${r.rows.map(row => row.join(',')).join(';').slice(0, 400)}`);
    } catch (e) { out.set(name, `ERR`); }
  }
  return out;
}

describe('les vues bougent-elles avec l etat ?', () => {
  it('releve', () => {
    const bare = new OracleDatabase();
    bare.instance.startup();
    const bareSnap = snapshot(bare, bare.connectAsSysdba().executor);

    const db = new OracleDatabase();
    db.instance.startup();
    const sys = db.connectAsSysdba().executor;
    const run = (sql: string) => { try { db.executeSql(sys, sql); } catch (e) { note(`   (seed) ${sql.slice(0, 40)} -> ${(e as Error).message.slice(0, 50)}`); } };
    run('CREATE USER bob IDENTIFIED BY p');
    run('GRANT CREATE SESSION, CREATE TABLE, UNLIMITED TABLESPACE TO bob');
    run("CREATE TABLESPACE ts_probe DATAFILE '/u01/probe.dbf' SIZE 50M");
    run('CREATE TABLE bob.t (id NUMBER PRIMARY KEY, nom VARCHAR2(20))');
    run('CREATE INDEX bob.i_t ON bob.t (nom)');
    run("INSERT INTO bob.t VALUES (1, 'A')");
    run('COMMIT');
    run('CREATE PROFILE p_probe LIMIT SESSIONS_PER_USER 3 IDLE_TIME 10');
    run('ALTER USER bob PROFILE p_probe');
    run('CREATE ROLE r_probe');
    run('GRANT SELECT ON bob.t TO r_probe');
    run('AUDIT SELECT ON bob.t BY ACCESS');
    run('CREATE AUDIT POLICY pol_probe ACTIONS SELECT ON bob.t');
    run('AUDIT POLICY pol_probe');
    run('ALTER DATABASE ARCHIVELOG');
    run('ALTER SYSTEM SWITCH LOGFILE');
    run('ALTER SYSTEM CHECKPOINT');
    run('CREATE RESTORE POINT rp_probe');
    run("CREATE TABLE bob.part_t (id NUMBER) PARTITION BY RANGE (id) (PARTITION p1 VALUES LESS THAN (10), PARTITION p2 VALUES LESS THAN (20))");
    run("CREATE VIEW bob.v_t AS SELECT * FROM bob.t");
    run("CREATE SEQUENCE bob.s_t");
    db.connect('BOB', 'p');
    db.instance.catalogArchivedLog('/u01/arc/1_1_x.arc', 1, 1000);
    db.instance.recordNonlogged('TS_PROBE', 12, 'PROBE');
    const bobSess = db.connect('BOB', 'p');
    db.executeSql(bobSess.executor, 'SELECT * FROM bob.t');
    const richSnap = snapshot(db, sys);

    const figees: string[] = [];
    for (const [name, val] of richSnap) {
      if (val === 'ERR') continue;
      if (bareSnap.get(name) === val) figees.push(name);
    }
    note(`[D-1] vues dont la sortie est IDENTIQUE avant/apres tout cet etat : ${figees.length} / ${richSnap.size}`);
    const vides = figees.filter(n => richSnap.get(n)!.startsWith('0|'));
    note(`      dont vides dans les deux cas : ${vides.length}`);
    note(`      NON vides mais identiques (lignes fixes) : ${figees.length - vides.length}`);
    for (const n of figees.filter(n => !richSnap.get(n)!.startsWith('0|'))) {
      note(`      FIXE  ${n}`);
    }
    note('');
    note('[D-2] les vues VIDES malgre l etat (candidates a remplir) :');
    for (const n of vides) note(`      VIDE  ${n}`);
    expect(true).toBe(true);
  });
});
