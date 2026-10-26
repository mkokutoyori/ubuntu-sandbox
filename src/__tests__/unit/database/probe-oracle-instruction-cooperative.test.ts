/**
 * Une instruction Oracle volumineuse se decoupe en tranches au lieu de figer l'onglet.
 *
 * MESURE DE DEPART (Chromium, e2e/nat-lab-stress.spec.ts, `ora-insert-300k` et
 * `ora-update-delete-300k`) : la tache longue la plus grosse durait 1 059 ms pour
 * `INSERT … SELECT … CONNECT BY level <= 300000` et 1 722 ms pour la suite UPDATE / DELETE /
 * ROLLBACK de 300 000 lignes — le ROLLBACK seul 2,3 s, `restoreRows` indexant toute la table. Une
 * instruction tournait d'une traite sur le fil de l'onglet parce que la chaine d'appel est
 * synchrone du terminal au stockage.
 *
 * Les boucles de lignes (filtre WHERE, CONNECT BY, projection, insertion, UPDATE, DELETE, annulation)
 * sont maintenant reprenables : `OracleDatabase.executeSqlSliced` rend un ResultSet portant une
 * `continuation`, et chaque couche (executeur, base, session SQL*Plus) la reprend sous sa propre portee
 * — horloge de la machine, budget d'appel, puit d'annulation. `executeSql` reste le pilote synchrone :
 * il regle la continuation d'une traite, donc tous les appelants existants voient le meme resultat.
 * Le sous-shell SQL*Plus du terminal rend la main a la boucle d'evenements entre deux tranches.
 * Au profil Chromium : `ora-insert-300k` 1 059 -> 144 ms, `ora-update-delete-300k` 1 722 -> 135 ms.
 *
 * Le temps CPU d'un profil (CPU_PER_CALL) ne compte que le temps ACTIF : le budget se suspend entre deux
 * tranches, sans quoi une instruction coupee en tranches serait facturee de son attente.
 *
 * Une sous-requete NON CORRELEE (aucune lecture de la ligne exterieure pendant son evaluation) n'est plus
 * reexecutee pour chaque ligne exterieure : `IN (SELECT id FROM big WHERE grp = 7)` sur 300 000 lignes coutait 31 s
 * (la sous-requete etait rejouee 300 000 fois, puis balayee lineairement a chaque ligne) et coute 84 ms ; sur
 * 20 000 lignes le cas ci-dessous passe de 38,5 s a moins de 1,5 s (quatre temoins passent des deux cotes : NOT IN
 * et NULL, textes et types mixtes, correlation, vie du cache). Le resultat
 * vit le temps de l'instruction ; une sous-requete correlee reste reevaluee ligne par ligne.
 *
 * Les boucles d'un bloc PL/SQL anonyme (FOR, WHILE, LOOP) rendent aussi la main : `ora-plsql-inserts-20k` avait
 * une tache longue de 784 ms.
 *
 * Discrimine en deux temps. Contre l'arbre d'avant tout le chantier (`git stash push -- src/database src/terminal
 * src/shell src/events` sur le premier lot), les onze cas SQL qui appellent `executeSqlSliced` tombent (l'API
 * n'existe pas). Contre l'arbre du lot SQL (le lot PL/SQL retire), trois cas tombent : la boucle FOR qui se
 * decoupe, DBMS_OUTPUT en tranches et le gestionnaire d'exception apres plusieurs tranches. Passent des deux
 * cotes, TEMOINS : le pilote synchrone ne rend jamais de continuation et regle l'instruction d'une traite, SQL
 * comme PL/SQL, et une erreur non attrapee remonte avec ORA-06512 que le bloc soit decoupe ou non.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';
import type { OracleExecutor } from '../../../database/oracle/OracleExecutor';
import type { ResultSet } from '../../../database/engine/executor/ResultSet';

let db: OracleDatabase;
let executor: OracleExecutor;

afterEach(() => { vi.restoreAllMocks(); });

function exec(sql: string, who: OracleExecutor = executor): ResultSet {
  return db.executeSql(who, sql);
}

function scalar(sql: string): unknown {
  return exec(sql).rows[0][0];
}

function sliced(sql: string, who: OracleExecutor = executor, between?: () => void): { result: ResultSet; slices: number } {
  let result = db.executeSqlSliced(who, sql, 1);
  let slices = 1;
  while (result.continuation) {
    between?.();
    result = result.continuation();
    slices++;
  }
  return { result, slices };
}

const FILL = (rows: number): string =>
  `INSERT INTO big SELECT level, MOD(level, 100), 'name_' || level, level * 1.5 FROM dual CONNECT BY level <= ${rows}`;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup();
  executor = db.connectAsSysdba().executor;
  exec('CREATE TABLE big (id NUMBER PRIMARY KEY, grp NUMBER, name VARCHAR2(40), amount NUMBER(10,2))');
});

describe('la voie synchrone', () => {
  test('TEMOIN — executeSql ne rend jamais de continuation et regle l instruction d une traite', () => {
    const result = exec(FILL(30000));
    expect(result.continuation).toBeUndefined();
    expect(result.message).toBe('30000 rows created.');
    expect(scalar('SELECT COUNT(*) FROM big')).toBe(30000);
  });
});

describe('INSERT … SELECT … CONNECT BY', () => {
  test('se decoupe en plusieurs tranches et cree toutes les lignes', () => {
    const { result, slices } = sliced(FILL(40000));
    expect(slices).toBeGreaterThan(3);
    expect(result.message).toBe('40000 rows created.');
    expect(scalar('SELECT COUNT(*) FROM big')).toBe(40000);
  });

  test('TEMOIN — la voie en tranches pose les memes donnees que la voie synchrone', () => {
    exec(FILL(20000));
    const direct = [scalar('SELECT SUM(id) FROM big'), scalar('SELECT SUM(amount) FROM big'), scalar("SELECT MAX(name) FROM big")];
    exec('ROLLBACK');
    sliced(FILL(20000));
    const viaSlices = [scalar('SELECT SUM(id) FROM big'), scalar('SELECT SUM(amount) FROM big'), scalar("SELECT MAX(name) FROM big")];
    expect(viaSlices).toEqual(direct);
  });

  test('une erreur de la derniere tranche remonte, et l executeur reste utilisable', () => {
    exec("INSERT INTO big VALUES (39000, 1, 'dup', 1)");
    exec('COMMIT');
    let slices = 0;
    let result = db.executeSqlSliced(executor, FILL(40000), 1);
    const drive = (): void => {
      while (result.continuation) { slices++; result = result.continuation(); }
    };
    expect(drive).toThrow(/ORA-00001/);
    expect(slices).toBeGreaterThan(1);
    expect(scalar('SELECT 1 FROM dual')).toBe(1);
    expect(exec('INSERT INTO big VALUES (500000, 1, \'ok\', 1)').message).toBe('1 row created.');
  });
});

describe('UPDATE, DELETE, ROLLBACK', () => {
  beforeEach(() => { exec(FILL(30000)); exec('COMMIT'); });

  test('UPDATE se decoupe et compte les memes lignes', () => {
    const { result, slices } = sliced('UPDATE big SET amount = amount + 1');
    expect(slices).toBeGreaterThan(2);
    expect(result.message).toBe('30000 rows updated.');
    expect(scalar('SELECT SUM(amount) FROM big')).toBe(30000 * 30001 / 2 * 1.5 + 30000);
  });

  test('DELETE se decoupe, valide les cles etrangeres et retire les bonnes lignes', () => {
    const { result, slices } = sliced('DELETE FROM big WHERE MOD(id, 2) = 0');
    expect(slices).toBeGreaterThan(2);
    expect(result.message).toBe('15000 rows deleted.');
    expect(scalar('SELECT COUNT(*) FROM big')).toBe(15000);
    expect(scalar('SELECT MIN(id) FROM big')).toBe(1);
    expect(scalar('SELECT MAX(id) FROM big')).toBe(29999);
  });

  test('ROLLBACK se decoupe et restaure l etat valide, insertions, mises a jour et suppressions', () => {
    const before = [scalar('SELECT COUNT(*) FROM big'), scalar('SELECT SUM(amount) FROM big')];
    sliced('UPDATE big SET amount = amount * 2');
    sliced('DELETE FROM big WHERE MOD(id, 3) = 0');
    sliced("INSERT INTO big VALUES (900001, 1, 'x', 5)");
    const rolled = sliced('ROLLBACK');
    expect(rolled.slices).toBeGreaterThan(1);
    expect(rolled.result.message).toBe('Rollback complete.');
    expect([scalar('SELECT COUNT(*) FROM big'), scalar('SELECT SUM(amount) FROM big')]).toEqual(before);
  });

  test('un DELETE concurrent d une autre session fait echouer la tranche suivante : ORA-08177', () => {
    const other = db.connectAsSysdba().executor;
    let result = db.executeSqlSliced(executor, 'UPDATE big SET amount = 0', 1);
    expect(result.continuation).toBeDefined();
    exec("DELETE FROM big WHERE id = 1", other);
    expect(() => { while (result.continuation) result = result.continuation(); }).toThrow(/ORA-08177/);
  });

  test('une insertion concurrente d une autre session n est ni perdue ni mise a jour', () => {
    const other = db.connectAsSysdba().executor;
    let result = db.executeSqlSliced(executor, 'DELETE FROM big WHERE id <= 20000', 1);
    expect(result.continuation).toBeDefined();
    exec("INSERT INTO big VALUES (777777, 1, 'late', 9)", other);
    exec('COMMIT', other);
    while (result.continuation) result = result.continuation();
    expect(result.message).toBe('20000 rows deleted.');
    expect(scalar('SELECT COUNT(*) FROM big WHERE id = 777777')).toBe(1);
  });
});

describe('bloc PL/SQL anonyme', () => {
  const LOOP = (rows: number): string =>
    `BEGIN FOR i IN 1..${rows} LOOP INSERT INTO big VALUES (i, 1, 'n', i); END LOOP; END;`;

  test('une boucle FOR se decoupe et execute toutes ses iterations', () => {
    const { result, slices } = sliced(LOOP(20000));
    expect(slices).toBeGreaterThan(2);
    expect(result.message).toBe('PL/SQL procedure successfully completed.');
    expect(scalar('SELECT COUNT(*) FROM big')).toBe(20000);
  });

  test('DBMS_OUTPUT garde toutes ses lignes dans l ordre', () => {
    executor.getContext().serverOutput = true;
    const block = "BEGIN FOR i IN 1..20000 LOOP DBMS_OUTPUT.PUT_LINE('ligne ' || i); END LOOP; END;";
    const direct = exec(block).message;
    const { result, slices } = sliced(block);
    expect(slices).toBeGreaterThan(2);
    expect(result.message).toBe(direct);
    expect(result.message).toContain('ligne 20000');
    expect(result.message!.split('\n')[0]).toBe('ligne 1');
  });

  test('un gestionnaire d exception attrape une erreur levee apres plusieurs tranches', () => {
    exec("INSERT INTO big VALUES (15000, 1, 'dup', 1)");
    exec('COMMIT');
    const block = `BEGIN FOR i IN 1..20000 LOOP INSERT INTO big VALUES (i, 1, 'n', i); END LOOP;
      EXCEPTION WHEN DUP_VAL_ON_INDEX THEN DBMS_OUTPUT.PUT_LINE('doublon'); END;`;
    const { result, slices } = sliced(block);
    expect(slices).toBeGreaterThan(2);
    expect(result.message).toContain('PL/SQL procedure successfully completed.');
  });

  test('une erreur non attrapee remonte avec ORA-06512', () => {
    exec("INSERT INTO big VALUES (15000, 1, 'dup', 1)");
    exec('COMMIT');
    const { result } = sliced(LOOP(20000));
    expect(result.message).toMatch(/ORA-00001[\s\S]*ORA-06512/);
  });

  test('TEMOIN — le pilote synchrone regle le meme bloc d une traite', () => {
    const result = exec(LOOP(5000));
    expect(result.continuation).toBeUndefined();
    expect(scalar('SELECT COUNT(*) FROM big')).toBe(5000);
  });
});

describe('sous-requetes', () => {
  beforeEach(() => {
    exec('CREATE TABLE ref (id NUMBER, label VARCHAR2(10), g NUMBER)');
  });

  test('IN (sous-requete non correlee) sur 20 000 lignes : evalue une fois, sonde par table de hachage', () => {
    exec(FILL(20000));
    exec('COMMIT');
    const startedAt = performance.now();
    const count = scalar('SELECT COUNT(*) FROM big WHERE id IN (SELECT id FROM big WHERE grp = 7)');
    expect(count).toBe(200);
    expect(performance.now() - startedAt).toBeLessThan(1500);
  }, 30_000);

  test('TEMOIN — NOT IN avec un NULL dans la sous-requete ne laisse passer aucune ligne', () => {
    exec("INSERT INTO ref VALUES (1, 'a', 1)");
    exec('INSERT INTO ref VALUES (NULL, \'b\', 1)');
    exec(FILL(10));
    expect(scalar('SELECT COUNT(*) FROM big WHERE id NOT IN (SELECT id FROM ref)')).toBe(0);
    expect(scalar('SELECT COUNT(*) FROM big WHERE id IN (SELECT id FROM ref)')).toBe(1);
  });

  test('TEMOIN — IN sur des textes et sur des types mixtes garde la comparaison d Oracle', () => {
    exec("INSERT INTO ref VALUES (5, '7', 1)");
    exec(FILL(10));
    expect(scalar("SELECT COUNT(*) FROM big WHERE name IN (SELECT 'name_' || id FROM ref)")).toBe(1);
    expect(scalar('SELECT COUNT(*) FROM big WHERE id IN (SELECT label FROM ref)')).toBe(1);
  });

  test('TEMOIN — une sous-requete correlee est reevaluee pour chaque ligne', () => {
    exec('INSERT INTO ref VALUES (1, \'x\', 1)');
    exec('INSERT INTO ref VALUES (2, \'y\', 1)');
    exec('INSERT INTO ref VALUES (3, \'z\', 2)');
    exec('INSERT INTO ref VALUES (4, \'w\', 2)');
    const rows = exec('SELECT id FROM ref a WHERE a.id > (SELECT AVG(id) FROM ref b WHERE b.g = a.g) ORDER BY id').rows;
    expect(rows.map(row => row[0])).toEqual([2, 4]);
  });

  test('TEMOIN — la sous-requete mise en cache ne survit pas a l instruction', () => {
    exec(FILL(10));
    exec('INSERT INTO ref VALUES (1, \'x\', 1)');
    const query = 'SELECT COUNT(*) FROM big WHERE id IN (SELECT id FROM ref)';
    expect(scalar(query)).toBe(1);
    exec('INSERT INTO ref VALUES (2, \'y\', 1)');
    expect(scalar(query)).toBe(2);
  });
});

describe('SELECT', () => {
  test('un SELECT volumineux se decoupe et rend les memes lignes', () => {
    exec(FILL(50000));
    exec('COMMIT');
    const direct = exec('SELECT id, amount FROM big WHERE MOD(id, 7) = 0');
    const { result, slices } = sliced('SELECT id, amount FROM big WHERE MOD(id, 7) = 0');
    expect(slices).toBeGreaterThan(2);
    expect(result.rows).toEqual(direct.rows);
    expect(result.continuation).toBeUndefined();
  });
});

describe('budget d appel d un profil', () => {
  function cappedUser(cpuCentiseconds: number): OracleExecutor {
    exec('CREATE TABLE owner_t (n NUMBER)');
    exec(`CREATE PROFILE capped LIMIT CPU_PER_CALL ${cpuCentiseconds}`);
    exec('CREATE USER capped_user IDENTIFIED BY "Pw#1234" PROFILE capped');
    exec('GRANT CREATE SESSION, UNLIMITED TABLESPACE TO capped_user');
    exec('GRANT INSERT, SELECT ON sys.owner_t TO capped_user');
    return db.connect('CAPPED_USER', 'Pw#1234').executor;
  }

  test('l attente entre deux tranches n est pas facturee au CPU de l appel', () => {
    const user = cappedUser(100);
    const real = performance.now.bind(performance);
    let skew = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => real() + skew);
    const { result, slices } = sliced(
      'INSERT INTO sys.owner_t SELECT level FROM dual CONNECT BY level <= 30000', user, () => { skew += 5000; });
    expect(slices).toBeGreaterThan(3);
    expect(result.message).toBe('30000 rows created.');
  });

  test('TEMOIN — un appel qui consomme vraiment le budget est coupe : ORA-02393', () => {
    const user = cappedUser(5);
    expect(() => sliced('INSERT INTO sys.owner_t SELECT level FROM dual CONNECT BY level <= 400000', user)).toThrow(/ORA-02393/);
    expect(scalar('SELECT COUNT(*) FROM owner_t')).toBe(0);
  });
});
