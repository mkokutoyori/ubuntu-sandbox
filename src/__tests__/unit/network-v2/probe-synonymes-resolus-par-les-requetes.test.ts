/**
 * Un synonyme Oracle etait STOCKE, LISTE et jamais CONSULTE : `CREATE SYNONYM scott.a1 FOR scott.emp` puis
 * `SELECT COUNT(*) FROM scott.a1` repondait ORA-00942, comme pour un synonyme public. La resolution d'un nom de
 * table ne regardait que les tables et les vues du schema.
 *
 * MESURE (avant) : SELECT par synonyme prive, par synonyme public, par chaine de synonymes, INSERT, UPDATE,
 * DELETE et MERGE par synonyme : ORA-00942 dans tous les cas.
 *
 * Corrige par UNE regle (`followSynonyms`, naming/SynonymResolution.ts) que l'executeur applique aux references de
 * table du SELECT, de l'INSERT, de l'UPDATE, du DELETE et du MERGE : la table ou la vue du schema d'abord, puis le
 * synonyme prive du schema, puis — pour un nom non qualifie — le synonyme public ; chaine bornee a 16
 * (ORA-01775 au dela). Les privileges sont verifies sur la CIBLE, comme sur Oracle.
 *
 * Au passage, `MERGE ... USING (SELECT ...) alias` etait refuse par l'analyseur (« Expected identifier ») alors que
 * l'executeur sait deja lire une source sous-requete : l'analyseur la produit maintenant.
 *
 * Discriminee contre l'etat d'avant (`git stash` des sources) : 4 des 9 cas tombent (synonyme prive, synonyme
 * public, chaine, DML par synonyme). Les 5 autres passent des deux cotes et sont NOMMES : le temoin « la table
 * reelle repond toujours », « une table gagne sur un synonyme public de meme nom » (non-regression), et trois
 * refus qui doivent rester des refus (synonyme public par un qualificatif de schema, cible absente, synonyme
 * supprime), plus la boucle dont le refus (ORA-01775) n'etait atteint que par la resolution.
 */
import { describe, it, expect } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { EventBus } from '@/events/EventBus';
import { installAllDemoSchemas } from '@/database/oracle/demo/DemoSchemas';

function lab() {
  const db = new OracleDatabase();
  db.instance.setEventBus(new EventBus());
  db.instance.startup();
  installAllDemoSchemas(db);
  const sys = db.connectAsSysdba().executor;
  const run = (sql: string) => db.executeSql(sys, sql);
  const rows = (sql: string) => JSON.stringify((run(sql) as { rows: unknown[][] }).rows);
  return { db, run, rows };
}

describe('queries follow synonyms', () => {
  it('witness: the real table still answers', () => {
    const { rows } = lab();
    expect(rows('SELECT COUNT(*) FROM scott.dept')).toBe('[[4]]');
  });

  it('a private synonym answers a SELECT, qualified', () => {
    const { run, rows } = lab();
    run('CREATE SYNONYM scott.d FOR scott.dept');
    expect(rows('SELECT COUNT(*) FROM scott.d')).toBe(rows('SELECT COUNT(*) FROM scott.dept'));
    expect(rows('SELECT d.dname FROM scott.d d WHERE d.deptno = 10')).toBe(rows('SELECT dname FROM scott.dept WHERE deptno = 10'));
  });

  it('a public synonym answers an unqualified name', () => {
    const { run, rows } = lab();
    run('CREATE PUBLIC SYNONYM pub_dept FOR scott.dept');
    expect(rows('SELECT COUNT(*) FROM pub_dept')).toBe(rows('SELECT COUNT(*) FROM scott.dept'));
  });

  it('a public synonym is not reachable through a schema qualifier', () => {
    const { run } = lab();
    run('CREATE PUBLIC SYNONYM pub_dept FOR scott.dept');
    expect(() => run('SELECT COUNT(*) FROM scott.pub_dept')).toThrow('ORA-00942');
  });

  it('a chain of synonyms is followed, and a loop is refused', () => {
    const { run, rows } = lab();
    run('CREATE SYNONYM scott.s1 FOR scott.dept');
    run('CREATE SYNONYM scott.s2 FOR scott.s1');
    expect(rows('SELECT COUNT(*) FROM scott.s2')).toBe(rows('SELECT COUNT(*) FROM scott.dept'));
    run('CREATE SYNONYM scott.l1 FOR scott.l2');
    run('CREATE SYNONYM scott.l2 FOR scott.l1');
    expect(() => run('SELECT * FROM scott.l1')).toThrow('ORA-01775');
  });

  it('a synonym over a missing target is ORA-00942, not a silent empty result', () => {
    const { run } = lab();
    run('CREATE SYNONYM scott.ghost FOR scott.no_such_table');
    expect(() => run('SELECT * FROM scott.ghost')).toThrow('ORA-00942');
  });

  it('a real table wins over a public synonym of the same name', () => {
    const { run, rows } = lab();
    run('CREATE PUBLIC SYNONYM dept FOR scott.emp');
    expect(rows('SELECT COUNT(*) FROM scott.dept')).toBe('[[4]]');
  });

  it('INSERT, UPDATE, DELETE and MERGE go through the synonym to the table', () => {
    const { run, rows } = lab();
    run('CREATE SYNONYM scott.d FOR scott.dept');
    run("INSERT INTO scott.d VALUES (50, 'LAB', 'DOUALA')");
    expect(rows('SELECT dname FROM scott.dept WHERE deptno = 50')).toBe('[["LAB"]]');
    run("UPDATE scott.d SET loc = 'YAOUNDE' WHERE deptno = 50");
    expect(rows('SELECT loc FROM scott.dept WHERE deptno = 50')).toBe('[["YAOUNDE"]]');
    run("MERGE INTO scott.d t USING (SELECT 50 AS n FROM dual) s ON (t.deptno = s.n) WHEN MATCHED THEN UPDATE SET t.dname = 'MERGED'");
    expect(rows('SELECT dname FROM scott.dept WHERE deptno = 50')).toBe('[["MERGED"]]');
    run('DELETE FROM scott.d WHERE deptno = 50');
    expect(rows('SELECT COUNT(*) FROM scott.dept WHERE deptno = 50')).toBe('[[0]]');
  });

  it('a dropped synonym stops answering', () => {
    const { run } = lab();
    run('CREATE SYNONYM scott.d FOR scott.dept');
    run('DROP SYNONYM scott.d');
    expect(() => run('SELECT * FROM scott.d')).toThrow('ORA-00942');
  });
});
