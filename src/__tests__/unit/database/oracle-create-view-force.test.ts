/**
 * Oracle CREATE [OR REPLACE] [[NO] FORCE] VIEW : sans FORCE, une vue sur une table absente (ORA-00942) ou une colonne inconnue (ORA-00904) est refusée ; avec FORCE elle est créée avec l'avertissement « View created with compilation errors. » et s'évalue dès que la table existe (Oracle Database SQL Language Reference, CREATE VIEW). Source : documentation, aucun Oracle disponible ici.
 * Mesure de départ : la vue était toujours créée avec « View created. ». 3 des 5 cas tombent avant ; les témoins (vue valide, FORCE sur table présente) passent dans les deux états.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';

describe('CREATE VIEW et FORCE', () => {
  let db: OracleDatabase;
  let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];
  const exec = (sql: string) => db.executeSql(executor, sql);

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup();
    executor = db.connectAsSysdba().executor;
  });

  test('sans FORCE, table absente : ORA-00942', () => {
    expect(() => exec('CREATE VIEW v1 AS SELECT * FROM missing_t')).toThrow('ORA-00942');
  });
  test('sans FORCE, colonne inconnue : ORA-00904', () => {
    exec('CREATE TABLE t_ok (a NUMBER)');
    expect(() => exec('CREATE VIEW v2 AS SELECT zzz FROM t_ok')).toThrow('ORA-00904');
  });
  test('avec FORCE, table absente : créée avec avertissement', () => {
    const result = exec('CREATE FORCE VIEW v3 AS SELECT * FROM missing_t');
    expect(result.message).toBe('Warning: View created with compilation errors.');
  });
  test('la vue FORCE s\'évalue une fois la table créée', () => {
    exec('CREATE FORCE VIEW v4 AS SELECT * FROM later_t');
    exec('CREATE TABLE later_t (a NUMBER)');
    exec('INSERT INTO later_t VALUES (7)');
    expect(exec('SELECT * FROM v4').rows).toEqual([[7]]);
  });
  test('témoin : vue valide', () => {
    exec('CREATE TABLE t_ok2 (a NUMBER)');
    expect(exec('CREATE VIEW v5 AS SELECT a FROM t_ok2').message).toBe('View created.');
  });
});
