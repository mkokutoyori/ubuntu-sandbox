/**
 * Oracle : les déclencheurs DML s'exécutent (Oracle Database Concepts / PL/SQL Language Reference, « Triggers ») : BEFORE/AFTER, niveau ligne (:NEW/:OLD, affectation de :NEW dans un BEFORE) et niveau instruction, INSERTING/UPDATING/DELETING, clause WHEN, RAISE_APPLICATION_ERROR qui annule l'instruction. Aucun Oracle disponible ici : source = documentation.
 * Mesure de départ : un déclencheur était créé (DBA_TRIGGERS) mais jamais exécuté (fireTriggers était un squelette vide). 15 des 16 cas tombent avant (8 des 9 de déclenchement, les 4 de ALTER TRIGGER / ALL TRIGGERS) ; le témoin (DBA_TRIGGERS liste le déclencheur) passe dans les deux états.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';

describe('déclencheurs DML', () => {
  let db: OracleDatabase;
  let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];
  const exec = (sql: string) => db.executeSql(executor, sql);
  const rows = (sql: string) => exec(sql).rows;

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup();
    executor = db.connectAsSysdba().executor;
    exec('CREATE TABLE t1 (a NUMBER, b VARCHAR2(20))');
    exec('CREATE TABLE audit_t (msg VARCHAR2(80))');
  });

  test('témoin : le déclencheur est listé', () => {
    exec("CREATE OR REPLACE TRIGGER trg_a AFTER INSERT ON t1 FOR EACH ROW BEGIN INSERT INTO audit_t VALUES ('x'); END;");
    expect(rows("SELECT trigger_name, status FROM dba_triggers WHERE trigger_name='TRG_A'")).toEqual([['TRG_A', 'ENABLED']]);
  });
  test('AFTER INSERT niveau ligne lit :NEW', () => {
    exec("CREATE TRIGGER trg_a AFTER INSERT ON t1 FOR EACH ROW BEGIN INSERT INTO audit_t VALUES ('ins ' || :NEW.a); END;");
    exec("INSERT INTO t1 VALUES (5, 'x')");
    exec("INSERT INTO t1 VALUES (6, 'y')");
    expect(rows('SELECT msg FROM audit_t')).toEqual([['ins 5'], ['ins 6']]);
  });
  test('BEFORE INSERT niveau ligne modifie :NEW', () => {
    exec("CREATE TRIGGER trg_b BEFORE INSERT ON t1 FOR EACH ROW BEGIN :NEW.b := 'set by trigger'; END;");
    exec("INSERT INTO t1 VALUES (1, 'orig')");
    expect(rows('SELECT a, b FROM t1')).toEqual([[1, 'set by trigger']]);
  });
  test('niveau instruction : une fois par INSERT', () => {
    exec("CREATE TRIGGER trg_s AFTER INSERT ON t1 BEGIN INSERT INTO audit_t VALUES ('stmt'); END;");
    exec('INSERT INTO t1 VALUES (1, NULL)');
    exec('INSERT INTO t1 VALUES (2, NULL)');
    expect(rows('SELECT msg FROM audit_t')).toEqual([['stmt'], ['stmt']]);
  });
  test('UPDATE : :OLD et :NEW', () => {
    exec("CREATE TRIGGER trg_u AFTER UPDATE ON t1 FOR EACH ROW BEGIN INSERT INTO audit_t VALUES (:OLD.a || '->' || :NEW.a); END;");
    exec('INSERT INTO t1 VALUES (1, NULL)');
    exec('UPDATE t1 SET a = 2');
    expect(rows('SELECT msg FROM audit_t')).toEqual([['1->2']]);
  });
  test('DELETE : :OLD', () => {
    exec("CREATE TRIGGER trg_d AFTER DELETE ON t1 FOR EACH ROW BEGIN INSERT INTO audit_t VALUES ('del ' || :OLD.a); END;");
    exec('INSERT INTO t1 VALUES (7, NULL)');
    exec('DELETE FROM t1');
    expect(rows('SELECT msg FROM audit_t')).toEqual([['del 7']]);
  });
  test('INSERTING / UPDATING dans un déclencheur à plusieurs événements', () => {
    exec("CREATE TRIGGER trg_m AFTER INSERT OR UPDATE ON t1 FOR EACH ROW BEGIN IF INSERTING THEN INSERT INTO audit_t VALUES ('I'); ELSE INSERT INTO audit_t VALUES ('U'); END IF; END;");
    exec('INSERT INTO t1 VALUES (1, NULL)');
    exec('UPDATE t1 SET a = 2');
    expect(rows('SELECT msg FROM audit_t')).toEqual([['I'], ['U']]);
  });
  test('clause WHEN', () => {
    exec("CREATE TRIGGER trg_w AFTER INSERT ON t1 FOR EACH ROW WHEN (NEW.a > 5) BEGIN INSERT INTO audit_t VALUES ('big'); END;");
    exec('INSERT INTO t1 VALUES (1, NULL)');
    exec('INSERT INTO t1 VALUES (9, NULL)');
    expect(rows('SELECT msg FROM audit_t')).toEqual([['big']]);
  });
  test('RAISE_APPLICATION_ERROR annule l\'instruction', () => {
    exec("CREATE TRIGGER trg_e BEFORE INSERT ON t1 FOR EACH ROW BEGIN IF :NEW.a < 0 THEN RAISE_APPLICATION_ERROR(-20001, 'negative'); END IF; END;");
    expect(() => exec('INSERT INTO t1 VALUES (-1, NULL)')).toThrow('ORA-20001: negative');
    expect(rows('SELECT * FROM t1')).toEqual([]);
  });
});

describe('ALTER TRIGGER et ALTER TABLE ... ALL TRIGGERS', () => {
  let db: OracleDatabase;
  let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];
  const exec = (sql: string) => db.executeSql(executor, sql);
  const rows = (sql: string) => exec(sql).rows;

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup();
    executor = db.connectAsSysdba().executor;
    exec('CREATE TABLE t1 (a NUMBER)');
    exec('CREATE TABLE audit_t (msg VARCHAR2(80))');
    exec("CREATE TRIGGER trg_x AFTER INSERT ON t1 FOR EACH ROW BEGIN INSERT INTO audit_t VALUES ('fired'); END;");
  });

  test('ALTER TRIGGER DISABLE : le déclencheur ne s\'exécute plus et DBA_TRIGGERS le dit', () => {
    expect(exec('ALTER TRIGGER trg_x DISABLE').message).toBe('Trigger altered.');
    exec('INSERT INTO t1 VALUES (1)');
    expect(rows('SELECT * FROM audit_t')).toEqual([]);
    expect(rows("SELECT status FROM dba_triggers WHERE trigger_name='TRG_X'")).toEqual([['DISABLED']]);
  });
  test('ALTER TRIGGER ENABLE le remet en marche', () => {
    exec('ALTER TRIGGER trg_x DISABLE');
    exec('ALTER TRIGGER trg_x ENABLE');
    exec('INSERT INTO t1 VALUES (1)');
    expect(rows('SELECT * FROM audit_t')).toEqual([['fired']]);
  });
  test('ALTER TABLE DISABLE ALL TRIGGERS', () => {
    exec('ALTER TABLE t1 DISABLE ALL TRIGGERS');
    exec('INSERT INTO t1 VALUES (1)');
    expect(rows('SELECT * FROM audit_t')).toEqual([]);
    exec('ALTER TABLE t1 ENABLE ALL TRIGGERS');
    exec('INSERT INTO t1 VALUES (2)');
    expect(rows('SELECT * FROM audit_t')).toEqual([['fired']]);
  });
  test('ALTER TRIGGER inconnu : ORA-04080', () => {
    expect(() => exec('ALTER TRIGGER nothing_trg DISABLE')).toThrow('ORA-04080');
  });
});

describe('UPDATE OF et UPDATING(\'col\')', () => {
  let db: OracleDatabase;
  let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];
  const exec = (sql: string) => db.executeSql(executor, sql);
  const rows = (sql: string) => exec(sql).rows;

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup();
    executor = db.connectAsSysdba().executor;
    exec('CREATE TABLE emp_t (id NUMBER, salary NUMBER, dept VARCHAR2(10))');
    exec('CREATE TABLE audit_t (msg VARCHAR2(80))');
    exec("INSERT INTO emp_t VALUES (1, 100, 'a')");
  });

  test('UPDATE OF salary ne se déclenche que si salary est affectée', () => {
    exec("CREATE TRIGGER trg_of AFTER UPDATE OF salary ON emp_t FOR EACH ROW BEGIN INSERT INTO audit_t VALUES ('salary'); END;");
    exec("UPDATE emp_t SET dept = 'b'");
    expect(rows('SELECT * FROM audit_t')).toEqual([]);
    exec('UPDATE emp_t SET salary = 200');
    expect(rows('SELECT * FROM audit_t')).toEqual([['salary']]);
  });
  test('UPDATE OF a, b : l\'une ou l\'autre', () => {
    exec("CREATE TRIGGER trg_of2 AFTER UPDATE OF salary, dept ON emp_t FOR EACH ROW BEGIN INSERT INTO audit_t VALUES ('either'); END;");
    exec("UPDATE emp_t SET dept = 'c'");
    expect(rows('SELECT * FROM audit_t')).toEqual([['either']]);
  });
  test('UPDATING(\'col\') dans un déclencheur', () => {
    exec("CREATE TRIGGER trg_up AFTER UPDATE ON emp_t FOR EACH ROW BEGIN IF UPDATING('SALARY') THEN INSERT INTO audit_t VALUES ('S'); END IF; IF UPDATING('DEPT') THEN INSERT INTO audit_t VALUES ('D'); END IF; END;");
    exec("UPDATE emp_t SET dept = 'z'");
    expect(rows('SELECT * FROM audit_t')).toEqual([['D']]);
  });
});
