/**
 * Mesure (Node, moteur Oracle et SQL*Plus sur un LinuxServer) de defauts de volume ou de correction :
 *
 * - `SELECT id FROM t ORDER BY name DESC` : le tri sur une colonne absente de la liste de selection etait ignore sans erreur (les lignes revenaient dans l'ordre de
 *   stockage) ; meme chose pour `GROUP BY grp ORDER BY COUNT(*) DESC`. Les cles de tri cachees sont maintenant evaluees sur la ligne source (ou le groupe) ;
 * - `ROLLBACK` d'une mise a jour, d'une suppression puis d'une seconde mise a jour de 40 000 lignes : plusieurs secondes (chaque enregistrement d'annulation cherchait sa ligne dans la
 *   table entiere) ; les enregistrements sont maintenant regroupes par table et appliques en une passe ;
 * - `SELECT * FROM big` de 150 000 lignes dans SQL*Plus : « ORA-00900: Maximum call stack size exceeded » (`output.push(...lignes)`), maintenant une boucle ;
 * - `SUM(amount) OVER (ORDER BY id)` : une matrice de positions par ligne et une somme refaite depuis le debut de la fenetre, soit un temps quadratique (85 s pour
 *   300 000 lignes) ; `ROWS BETWEEN 2 PRECEDING AND 1 PRECEDING` renvoyait la valeur de la ligne courante en tete de partition au lieu de NULL (bornes ecretees avant le test de fenetre vide). La fenetre est maintenant un intervalle et SUM / AVG / COUNT / MIN / MAX sont cumules d'une ligne a la suivante quand le debut de la fenetre ne bouge
 *   pas (memes additions, dans le meme ordre).
 *
 * - lecture coherente d'une table mise a jour par une autre session non validee : chaque enregistrement d'annulation cherchait sa ligne dans l'image entiere (`reverseApplyInMemory`, doublon de la restauration du ROLLBACK : 0,94 s a 20 000 lignes contre 0,06 s apres) ; le lecteur passe maintenant par `restoreRows`.
 *
 * - `CREATE USER` : 74 ms chacun (100 utilisateurs : 7,4 s), la derivation PBKDF2 des verificateurs de SYS.USER$ etant faite a la creation alors que `getStoredVerifiers` sait la faire a la demande ; elle est maintenant paresseuse, a valeur identique (derivation deterministe).
 *
 * Discrimine par `git stash push -- src/database/oracle src/terminal/commands/database.ts` : 9 cas sur 14 tombent (tri sur colonne cachee, tri groupe sur agregat cache, fenetre
 * PRECEDING vide en tete de partition — 10 au lieu de NULL —, ROLLBACK de 40 000 lignes : 4,8 s contre 0,15 s, SELECT * geant dans SQL*Plus, SUM OVER cumulatif de 60 000 lignes :
 * 184 s, AVG OVER sur le meme volume : 189 s). Passent des deux cotes, TEMOINS : les valeurs des fonctions de fenetre sur petites donnees (cumul, partition, ROWS BETWEEN glissant,
 * UNBOUNDED FOLLOWING, MIN/MAX, FIRST/LAST/NTH_VALUE, RANK) et le tri sur colonne selectionnee.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import type { OracleExecutor } from '../../../database/oracle/OracleExecutor';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { getOracleDatabase } from '@/terminal/commands/database';
import { createSqlPlusRunner } from '../../debug/oracle/_oracle-dump';

let db: OracleDatabase;
let executor: OracleExecutor;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup();
  executor = db.connectAsSysdba().executor;
});

function exec(sql: string) {
  return db.executeSql(executor, sql);
}

function column(sql: string): unknown[] {
  return exec(sql).rows.map(row => row[0]);
}

function timed<T>(run: () => T): { value: T; ms: number } {
  const startedAt = performance.now();
  const value = run();
  return { value, ms: performance.now() - startedAt };
}

function fillOrdered(rows: number): void {
  exec('CREATE TABLE t (id NUMBER PRIMARY KEY, grp NUMBER, name VARCHAR2(10), amount NUMBER)');
  for (let i = 1; i <= rows; i++) {
    exec(`INSERT INTO t VALUES (${i}, ${i % 2}, 'n${String.fromCharCode(100 - i)}', ${i * 10})`);
  }
  exec('COMMIT');
}

describe('tri sur une colonne absente de la selection', () => {
  test('ORDER BY name DESC sans selectionner name', () => {
    fillOrdered(4);
    expect(column('SELECT id FROM t ORDER BY name')).toEqual([4, 3, 2, 1]);
    expect(column('SELECT id FROM t ORDER BY name DESC')).toEqual([1, 2, 3, 4]);
  });

  test('GROUP BY avec ORDER BY sur un agregat non selectionne', () => {
    exec('CREATE TABLE sales (grp NUMBER)');
    exec('INSERT INTO sales VALUES (1)');
    exec('INSERT INTO sales VALUES (2)');
    exec('INSERT INTO sales VALUES (2)');
    exec('INSERT INTO sales VALUES (2)');
    exec('INSERT INTO sales VALUES (3)');
    exec('INSERT INTO sales VALUES (3)');
    expect(column('SELECT grp FROM sales GROUP BY grp ORDER BY COUNT(*) DESC')).toEqual([2, 3, 1]);
  });

  test('TEMOIN — le tri sur une colonne selectionnee reste correct', () => {
    fillOrdered(4);
    expect(column('SELECT name FROM t ORDER BY name')).toEqual(['n`', 'na', 'nb', 'nc']);
    expect(column('SELECT id FROM t ORDER BY id DESC')).toEqual([4, 3, 2, 1]);
  });
});

describe('annulation melangee', () => {
  test('ROLLBACK de 40 000 lignes mises a jour, supprimees pour un tiers, remises a jour', () => {
    exec('CREATE TABLE seqs (id NUMBER PRIMARY KEY, amount NUMBER)');
    exec('INSERT INTO seqs SELECT level, level FROM dual CONNECT BY level <= 40000');
    exec('COMMIT');
    exec('UPDATE seqs SET amount = amount + 1');
    exec('DELETE FROM seqs WHERE MOD(id, 3) = 0');
    exec('UPDATE seqs SET amount = amount + 1');
    const { ms } = timed(() => exec('ROLLBACK'));
    expect(ms).toBeLessThan(1500);
    expect(exec('SELECT COUNT(*) FROM seqs').rows[0][0]).toBe(40000);
    expect(exec('SELECT SUM(amount) FROM seqs').rows[0][0]).toBe(800020000);
  }, 120_000);
});

describe('resultat geant dans SQL*Plus', () => {
  test('SELECT * de 150 000 lignes', () => {
    const server = new LinuxServer('linux-server', 'ora-stress', 100, 100);
    getOracleDatabase(server.id);
    const runner = createSqlPlusRunner(server);
    runner.execute('CREATE TABLE big (id NUMBER PRIMARY KEY, name VARCHAR2(40));');
    runner.execute("INSERT INTO big SELECT level, 'n' || level FROM dual CONNECT BY level <= 150000;");
    runner.execute('COMMIT;');
    const out = runner.execute('SELECT * FROM big;');
    expect(out).not.toContain('ORA-00900');
    expect(out).toContain('150000 rows selected.');
    runner.dispose();
  }, 120_000);
});

describe('fonctions de fenetre', () => {
  beforeEach(() => {
    exec('CREATE TABLE w (id NUMBER, grp NUMBER, v NUMBER)');
    for (const [id, grp, v] of [[1, 1, 10], [2, 1, 20], [3, 1, 30], [4, 2, 5], [5, 2, 15]]) {
      exec(`INSERT INTO w VALUES (${id}, ${grp}, ${v})`);
    }
    exec('COMMIT');
  });

  test('TEMOIN — cumul par partition', () => {
    expect(column('SELECT SUM(v) OVER (PARTITION BY grp ORDER BY id) FROM w ORDER BY id')).toEqual([10, 30, 60, 5, 20]);
    expect(column('SELECT AVG(v) OVER (PARTITION BY grp ORDER BY id) FROM w ORDER BY id')).toEqual([10, 15, 20, 5, 10]);
    expect(column('SELECT COUNT(v) OVER (ORDER BY id) FROM w ORDER BY id')).toEqual([1, 2, 3, 4, 5]);
    expect(column('SELECT COUNT(*) OVER (PARTITION BY grp) FROM w ORDER BY id')).toEqual([3, 3, 3, 2, 2]);
  });

  test('TEMOIN — fenetre glissante, UNBOUNDED FOLLOWING et fenetre vide', () => {
    expect(column('SELECT SUM(v) OVER (ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM w ORDER BY id')).toEqual([10, 30, 50, 35, 20]);
    expect(column('SELECT SUM(v) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) FROM w ORDER BY id')).toEqual([80, 70, 50, 20, 15]);
    expect(column('SELECT SUM(v) OVER (ORDER BY id ROWS BETWEEN 2 PRECEDING AND 1 PRECEDING) FROM w ORDER BY id')).toEqual([null, 10, 30, 50, 35]);
  });

  test('TEMOIN — MIN, MAX, FIRST_VALUE, LAST_VALUE, NTH_VALUE, RANK', () => {
    expect(column('SELECT MAX(v) OVER (ORDER BY id) FROM w ORDER BY id')).toEqual([10, 20, 30, 30, 30]);
    expect(column('SELECT MIN(v) OVER (ORDER BY id) FROM w ORDER BY id')).toEqual([10, 10, 10, 5, 5]);
    expect(column('SELECT FIRST_VALUE(v) OVER (PARTITION BY grp ORDER BY id) FROM w ORDER BY id')).toEqual([10, 10, 10, 5, 5]);
    expect(column('SELECT LAST_VALUE(v) OVER (ORDER BY id) FROM w ORDER BY id')).toEqual([10, 20, 30, 5, 15]);
    expect(column('SELECT NTH_VALUE(v, 2) OVER (ORDER BY id) FROM w ORDER BY id')).toEqual([null, 20, 20, 20, 20]);
    expect(column('SELECT RANK() OVER (ORDER BY grp) FROM w ORDER BY id')).toEqual([1, 1, 1, 4, 4]);
  });

  test('SUM OVER cumulatif de 60 000 lignes', () => {
    exec('CREATE TABLE bigw (id NUMBER, amount NUMBER)');
    exec('INSERT INTO bigw SELECT level, 1 FROM dual CONNECT BY level <= 60000');
    const { value, ms } = timed(() => exec('SELECT MAX(running) FROM (SELECT SUM(amount) OVER (ORDER BY id) AS running FROM bigw)'));
    expect(value.rows[0][0]).toBe(60000);
    expect(ms).toBeLessThan(3000);
  }, 120_000);

  test('AVG OVER cumulatif de 60 000 lignes', () => {
    exec('CREATE TABLE bigw (id NUMBER, amount NUMBER)');
    exec('INSERT INTO bigw SELECT level, 2 FROM dual CONNECT BY level <= 60000');
    const { value, ms } = timed(() => exec('SELECT MAX(running) FROM (SELECT AVG(amount) OVER (ORDER BY id) AS running FROM bigw)'));
    expect(value.rows[0][0]).toBe(2);
    expect(ms).toBeLessThan(3000);
  }, 120_000);
});

describe('lecture coherente pendant une transaction ouverte', () => {
  test('un lecteur voit l\'image validee d\'une table de 50 000 lignes mise a jour par une autre session', () => {
    exec('CREATE TABLE shared (id NUMBER PRIMARY KEY, amount NUMBER)');
    exec('INSERT INTO shared SELECT level, level FROM dual CONNECT BY level <= 50000');
    exec('COMMIT');
    exec('UPDATE shared SET amount = amount + 1');
    const reader = db.connectAsSysdba().executor;
    const { value, ms } = timed(() => db.executeSql(reader, 'SELECT SUM(amount) FROM shared'));
    expect(value.rows[0][0]).toBe(1250025000);
    expect(ms).toBeLessThan(1500);
    expect(exec('SELECT SUM(amount) FROM shared').rows[0][0]).toBe(1250075000);
  }, 120_000);
});

describe('creation d\'utilisateurs', () => {
  test('100 CREATE USER ne paient pas la derivation PBKDF2 des verificateurs', () => {
    const { ms } = timed(() => {
      for (let i = 1; i <= 100; i++) exec(`CREATE USER u${i} IDENTIFIED BY "Pw#${i}"`);
    });
    expect(ms).toBeLessThan(2500);
  }, 120_000);

  test('TEMOIN — le verificateur 12c reste lisible dans SYS.USER$ a la demande', () => {
    exec('CREATE USER verif IDENTIFIED BY "Secret#1"');
    const spare4 = String(exec("SELECT spare4 FROM sys.user$ WHERE name = 'VERIF'").rows[0][0]);
    expect(spare4).toMatch(/^S:/);
    expect(spare4).toContain('T:');
  });

  test('TEMOIN — changer le mot de passe change le verificateur', () => {
    exec('CREATE USER verif2 IDENTIFIED BY "Secret#1"');
    const before = String(exec("SELECT spare4 FROM sys.user$ WHERE name = 'VERIF2'").rows[0][0]);
    exec('ALTER USER verif2 IDENTIFIED BY "Autre#2"');
    const after = String(exec("SELECT spare4 FROM sys.user$ WHERE name = 'VERIF2'").rows[0][0]);
    expect(after).not.toBe(before);
  });
});
