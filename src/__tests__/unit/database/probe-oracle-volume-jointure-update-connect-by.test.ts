/**
 * Mesure (Node, SQL*Plus sur un LinuxServer) de requetes de volume que le moteur traitait en temps quadratique ou par recursion :
 *
 * - `INSERT … SELECT … FROM DUAL CONNECT BY LEVEL <= 5000` : « ORA-00900: Maximum call stack size exceeded » (parcours recursif, un niveau par ligne ; la
 *   plus grande valeur qui passait etait un millier), et plafonne en silence a 10 000 lignes meme sans pile ;
 * - `SELECT … FROM big a JOIN big b ON a.id = b.id` : boucle imbriquee, 12,5 s pour 5000 lignes, 221 s pour 20 000 (l'onglet du navigateur est fige tout ce temps) ;
 * - `UPDATE big SET amount = amount + 1` : 5,3 s pour 5000 lignes, 3,2 s pour 4000 — chaque ligne mise a jour invalidait l'index de cles (RowIndexCache) que la
 *   verification de contrainte reconstruisait ensuite en entier.
 * - `ROLLBACK` d'un `UPDATE` de 50 000 lignes : 34,7 s (chaque enregistrement d'annulation cherchait sa ligne dans toute la table) ; l'annulation d'une insertion cherche depuis la fin, celle
 *   d'une mise a jour part de la derniere ligne restauree ;
 * - `INSERT … SELECT` de plus de ~125 000 lignes : « Maximum call stack size exceeded » (`rows.push(...rows)`), maintenant une boucle.
 *
 * Corrige : parcours CONNECT BY iteratif (plafond de profondeur pour les seules hierarchies a PRIOR, 2 000 000 lignes au plus : ORA-30009), jointure par
 * hachage sur les egalites colonne = colonne (la condition ON complete est toujours reevaluee sur les candidats ; repli sur la boucle quand les types des cles
 * different, NULL jamais apparie), index de cles mis a jour ligne par ligne par UPDATE.
 *
 * NOCYCLE ne coupait aucune boucle (la cle de visite portait le niveau, donc ne se repetait jamais : 10 000 lignes pour un cycle de 3) ; la cle ignore maintenant le niveau.
 *
 * Discrimine par `git stash push -- src/database` : 6 cas sur 16 tombent (CONNECT BY 30 000, NOCYCLE, jointure 3000x3000, UPDATE 6000 lignes — ce dernier parce que son
 * remplissage passe par CONNECT BY —, puis les deux ROLLBACK de 20 000 lignes, 1,6 s et 2,7 s avant contre quelques dizaines de ms). Passent des deux cotes, TEMOINS : les
 * hierarchies a PRIOR, les semantiques de jointure (LEFT, doublons, cles texte, predicat en plus, types differents, USING), la cle primaire decalee par un UPDATE, le doublon
 * refuse, ROLLBACK TO SAVEPOINT, et l'INSERT de 200 000 lignes (la pile de Node est plus haute que celle de Chromium, ou la limite est d'environ 125 000).
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import type { OracleExecutor } from '../../../database/oracle/OracleExecutor';

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

function scalar(sql: string): unknown {
  return exec(sql).rows[0][0];
}

function timed<T>(run: () => T): { value: T; ms: number } {
  const startedAt = performance.now();
  const value = run();
  return { value, ms: performance.now() - startedAt };
}

describe('CONNECT BY itere', () => {
  test('30 000 lignes generees par CONNECT BY LEVEL', () => {
    exec('CREATE TABLE seqs (n NUMBER)');
    const inserted = exec('INSERT INTO seqs SELECT level FROM dual CONNECT BY level <= 30000');
    expect(inserted.message ?? '').toContain('30000 rows created');
    expect(scalar('SELECT COUNT(*) FROM seqs')).toBe(30000);
    expect(scalar('SELECT MAX(n) FROM seqs')).toBe(30000);
  }, 60_000);

  test('TEMOIN — une hierarchie a PRIOR donne les bons niveaux', () => {
    exec('CREATE TABLE staff (id NUMBER, boss NUMBER)');
    exec('INSERT INTO staff VALUES (1, NULL)');
    exec('INSERT INTO staff VALUES (2, 1)');
    exec('INSERT INTO staff VALUES (3, 2)');
    exec('INSERT INTO staff VALUES (4, 2)');
    exec('INSERT INTO staff VALUES (5, 3)');
    const result = exec('SELECT id, LEVEL FROM staff START WITH boss IS NULL CONNECT BY PRIOR id = boss');
    expect(result.rows.map(row => `${row[0]}:${row[1]}`)).toEqual(['1:1', '2:2', '3:3', '5:4', '4:3']);
  });

  test('TEMOIN — NOCYCLE coupe une boucle', () => {
    exec('CREATE TABLE ring (id NUMBER, nxt NUMBER)');
    exec('INSERT INTO ring VALUES (1, 2)');
    exec('INSERT INTO ring VALUES (2, 3)');
    exec('INSERT INTO ring VALUES (3, 1)');
    const result = exec('SELECT id FROM ring START WITH id = 1 CONNECT BY NOCYCLE PRIOR nxt = id');
    expect(result.rows.length).toBe(3);
  });
});

describe('jointure par hachage', () => {
  function seed(rows: number): void {
    exec('CREATE TABLE big (id NUMBER PRIMARY KEY, grp NUMBER, tag VARCHAR2(20))');
    exec(`INSERT INTO big SELECT level, MOD(level, 50), 'tag' || MOD(level, 7) FROM dual CONNECT BY level <= ${rows}`);
  }

  test('3000 x 3000 sur une egalite tient sous 2,5 s', () => {
    seed(3000);
    const { value, ms } = timed(() => scalar('SELECT COUNT(*) FROM big a JOIN big b ON a.id = b.id WHERE a.grp = 7'));
    expect(value).toBe(60);
    expect(ms).toBeLessThan(2500);
  }, 120_000);

  test('TEMOIN — LEFT JOIN garde les lignes sans correspondance et ne rapproche jamais deux NULL', () => {
    exec('CREATE TABLE l (k NUMBER, v VARCHAR2(5))');
    exec('CREATE TABLE r (k NUMBER, w VARCHAR2(5))');
    exec("INSERT INTO l VALUES (1, 'a')");
    exec("INSERT INTO l VALUES (2, 'b')");
    exec("INSERT INTO l VALUES (NULL, 'c')");
    exec("INSERT INTO r VALUES (1, 'x')");
    exec("INSERT INTO r VALUES (NULL, 'y')");
    const result = exec('SELECT l.v, r.w FROM l LEFT JOIN r ON l.k = r.k ORDER BY l.v');
    expect(result.rows).toEqual([['a', 'x'], ['b', null], ['c', null]]);
  });

  test('TEMOIN — doublons a droite, ordre des lignes conserve', () => {
    exec('CREATE TABLE l (k NUMBER, v VARCHAR2(5))');
    exec('CREATE TABLE r (k NUMBER, w VARCHAR2(5))');
    exec("INSERT INTO l VALUES (1, 'a')");
    exec("INSERT INTO r VALUES (1, 'x')");
    exec("INSERT INTO r VALUES (2, 'z')");
    exec("INSERT INTO r VALUES (1, 'y')");
    const result = exec('SELECT l.v, r.w FROM l JOIN r ON l.k = r.k');
    expect(result.rows).toEqual([['a', 'x'], ['a', 'y']]);
  });

  test('TEMOIN — cles texte et predicat supplementaire dans ON', () => {
    exec('CREATE TABLE l (k VARCHAR2(5), n NUMBER)');
    exec('CREATE TABLE r (k VARCHAR2(5), n NUMBER)');
    exec("INSERT INTO l VALUES ('a', 1)");
    exec("INSERT INTO l VALUES ('b', 5)");
    exec("INSERT INTO r VALUES ('a', 9)");
    exec("INSERT INTO r VALUES ('b', 2)");
    const result = exec('SELECT l.k FROM l JOIN r ON l.k = r.k AND l.n < r.n');
    expect(result.rows).toEqual([['a']]);
  });

  test('TEMOIN — une cle numerique face a une cle texte garde la conversion implicite', () => {
    exec('CREATE TABLE l (k NUMBER)');
    exec('CREATE TABLE r (k VARCHAR2(5))');
    exec('INSERT INTO l VALUES (5)');
    exec("INSERT INTO r VALUES ('5')");
    expect(exec('SELECT COUNT(*) FROM l JOIN r ON l.k = r.k').rows[0][0]).toBe(1);
  });

  test('TEMOIN — JOIN USING', () => {
    exec('CREATE TABLE l (k NUMBER, v VARCHAR2(5))');
    exec('CREATE TABLE r (k NUMBER, w VARCHAR2(5))');
    exec("INSERT INTO l VALUES (1, 'a')");
    exec("INSERT INTO r VALUES (1, 'x')");
    exec("INSERT INTO r VALUES (2, 'y')");
    expect(exec('SELECT v, w FROM l JOIN r USING (k)').rows).toEqual([['a', 'x']]);
  });
});

describe('UPDATE de volume', () => {
  test('6000 lignes mises a jour sur une table a cle primaire tiennent sous 1,5 s', () => {
    exec('CREATE TABLE big (id NUMBER PRIMARY KEY, amount NUMBER)');
    exec('INSERT INTO big SELECT level, level FROM dual CONNECT BY level <= 6000');
    const { value, ms } = timed(() => exec('UPDATE big SET amount = amount + 1'));
    expect(value.message ?? '').toContain('6000 rows updated');
    expect(ms).toBeLessThan(1500);
    expect(scalar('SELECT SUM(amount) FROM big')).toBe(6000 * 6001 / 2 + 6000);
  }, 120_000);

  test('TEMOIN — decaler toute la cle primaire passe, et la recherche par cle retrouve la ligne', () => {
    exec('CREATE TABLE keyed (id NUMBER PRIMARY KEY, label VARCHAR2(10))');
    exec("INSERT INTO keyed SELECT level, 'row' || level FROM dual CONNECT BY level <= 50");
    exec('UPDATE keyed SET id = id + 1000');
    expect(scalar('SELECT label FROM keyed WHERE id = 1007')).toBe('row7');
    expect(scalar('SELECT COUNT(*) FROM keyed WHERE id <= 50')).toBe(0);
  });

  test('TEMOIN — un doublon de cle primaire est refuse', () => {
    exec('CREATE TABLE keyed (id NUMBER PRIMARY KEY)');
    exec('INSERT INTO keyed SELECT level FROM dual CONNECT BY level <= 10');
    expect(() => exec('UPDATE keyed SET id = 5 WHERE id = 6')).toThrow(/ORA-00001/);
  });
});

describe('annulation de volume', () => {
  test('ROLLBACK d\'un UPDATE de 20 000 lignes tient sous 0,6 s et restaure les valeurs', () => {
    exec('CREATE TABLE big (id NUMBER PRIMARY KEY, amount NUMBER)');
    exec('INSERT INTO big SELECT level, level FROM dual CONNECT BY level <= 20000');
    exec('COMMIT');
    exec('UPDATE big SET amount = amount + 1000000');
    const { ms } = timed(() => exec('ROLLBACK'));
    expect(ms).toBeLessThan(600);
    expect(scalar('SELECT SUM(amount) FROM big')).toBe(20000 * 20001 / 2);
  }, 120_000);

  test('ROLLBACK de 20 000 insertions tient sous 0,6 s', () => {
    exec('CREATE TABLE grow (n NUMBER)');
    exec('INSERT INTO grow SELECT level FROM dual CONNECT BY level <= 20000');
    const { ms } = timed(() => exec('ROLLBACK'));
    expect(ms).toBeLessThan(600);
    expect(scalar('SELECT COUNT(*) FROM grow')).toBe(0);
  }, 120_000);

  test('un INSERT … SELECT de 200 000 lignes ne depasse pas la pile (temoin sous Node, dont la pile est plus haute que celle de Chromium)', () => {
    exec('CREATE TABLE huge (n NUMBER)');
    exec('INSERT INTO huge SELECT level FROM dual CONNECT BY level <= 200000');
    expect(scalar('SELECT COUNT(*) FROM huge')).toBe(200000);
  }, 120_000);

  test('TEMOIN — ROLLBACK TO SAVEPOINT restaure la mise a jour et la suppression', () => {
    exec('CREATE TABLE acct (id NUMBER PRIMARY KEY, balance NUMBER)');
    exec('INSERT INTO acct SELECT level, 100 FROM dual CONNECT BY level <= 10');
    exec('COMMIT');
    exec('SAVEPOINT s1');
    exec('UPDATE acct SET balance = 0 WHERE id <= 5');
    exec('DELETE FROM acct WHERE id > 8');
    exec('ROLLBACK TO SAVEPOINT s1');
    expect(scalar('SELECT SUM(balance) FROM acct')).toBe(1000);
    expect(scalar('SELECT COUNT(*) FROM acct')).toBe(10);
  });
});

