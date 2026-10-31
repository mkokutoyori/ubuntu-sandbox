/**
 * Oracle : un synonyme (privé ou public) désigne une séquence ; `syn.NEXTVAL` et `schema.syn.CURRVAL` suivent la même résolution que les tables (Oracle Database SQL Language Reference, CREATE SYNONYM : « synonym ... for ... sequence »). Aucun Oracle disponible ici : source = documentation.
 * Mesure de départ : `syn_seq.NEXTVAL` répondait ORA-02289. 3 des 5 cas de séquence , 2 des 3 cas TRUNCATE et 2 des 3 cas LOCK TABLE / GRANT tombent avant ; le témoin (NEXTVAL direct) et le synonyme inexistant (ORA-02289) passent dans les deux états.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '../../../database/oracle/OracleDatabase';

describe('synonymes de séquence', () => {
  let db: OracleDatabase;
  let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];
  const exec = (sql: string) => db.executeSql(executor, sql);
  const first = (sql: string) => exec(sql).rows[0][0];

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup();
    executor = db.connectAsSysdba().executor;
    exec('CREATE SEQUENCE s1 START WITH 10 INCREMENT BY 5');
  });

  test('témoin : NEXTVAL direct', () => { expect(first('SELECT s1.NEXTVAL FROM dual')).toBe(10); });
  test('synonyme privé : NEXTVAL', () => {
    exec('CREATE SYNONYM syn_seq FOR s1');
    expect(first('SELECT syn_seq.NEXTVAL FROM dual')).toBe(10);
  });
  test('le synonyme et la séquence partagent le compteur et le CURRVAL de session', () => {
    exec('CREATE SYNONYM syn_seq FOR s1');
    expect(first('SELECT syn_seq.NEXTVAL FROM dual')).toBe(10);
    expect(first('SELECT s1.NEXTVAL FROM dual')).toBe(15);
    expect(first('SELECT syn_seq.CURRVAL FROM dual')).toBe(15);
  });
  test('synonyme public', () => {
    exec('CREATE PUBLIC SYNONYM pub_seq FOR s1');
    expect(first('SELECT pub_seq.NEXTVAL FROM dual')).toBe(10);
  });
  test('synonyme inexistant : ORA-02289', () => {
    expect(() => exec('SELECT nothing_seq.NEXTVAL FROM dual')).toThrow('ORA-02289');
  });
});

describe('TRUNCATE TABLE et synonymes', () => {
  let db: OracleDatabase;
  let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];
  const exec = (sql: string) => db.executeSql(executor, sql);

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup();
    executor = db.connectAsSysdba().executor;
    exec('CREATE TABLE t_trunc (a NUMBER)');
    exec('INSERT INTO t_trunc VALUES (1)');
  });

  test('TRUNCATE TABLE sur un synonyme vide la table cible', () => {
    exec('CREATE SYNONYM syn_trunc FOR t_trunc');
    exec('TRUNCATE TABLE syn_trunc');
    expect(exec('SELECT COUNT(*) FROM t_trunc').rows[0][0]).toBe(0);
  });
  test('TRUNCATE TABLE sur un synonyme public', () => {
    exec('CREATE PUBLIC SYNONYM pub_trunc FOR t_trunc');
    exec('TRUNCATE TABLE pub_trunc');
    expect(exec('SELECT COUNT(*) FROM t_trunc').rows[0][0]).toBe(0);
  });
  test('TRUNCATE d\'un nom inconnu : ORA-00942', () => {
    expect(() => exec('TRUNCATE TABLE nothing_t')).toThrow('ORA-00942');
  });
});

describe('LOCK TABLE et GRANT sur un synonyme', () => {
  let db: OracleDatabase;
  let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'];
  const exec = (sql: string) => db.executeSql(executor, sql);

  beforeEach(() => {
    db = new OracleDatabase();
    db.instance.startup();
    executor = db.connectAsSysdba().executor;
    exec('CREATE TABLE t_lk (a NUMBER)');
    exec('CREATE SYNONYM syn_lk FOR t_lk');
  });

  test('LOCK TABLE sur un synonyme verrouille la table cible', () => {
    expect(exec('LOCK TABLE syn_lk IN EXCLUSIVE MODE').message).toBe('Table(s) Locked.');
  });
  test('LOCK TABLE d\'un nom inconnu : ORA-00942', () => {
    expect(exec('LOCK TABLE nothing_lk IN EXCLUSIVE MODE').message).toContain('ORA-00942');
  });
  test('GRANT ... ON synonyme accorde sur la table cible', () => {
    exec('CREATE USER grantee_u IDENTIFIED BY pw');
    expect(exec('GRANT SELECT ON syn_lk TO grantee_u').message).toBe('Grant succeeded.');
    expect(exec("SELECT table_name FROM dba_tab_privs WHERE grantee='GRANTEE_U'").rows).toEqual([['T_LK']]);
  });
});
