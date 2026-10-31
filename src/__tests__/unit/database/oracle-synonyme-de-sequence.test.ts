/**
 * Oracle : un synonyme (privé ou public) désigne une séquence ; `syn.NEXTVAL` et `schema.syn.CURRVAL` suivent la même résolution que les tables (Oracle Database SQL Language Reference, CREATE SYNONYM : « synonym ... for ... sequence »). Aucun Oracle disponible ici : source = documentation.
 * Mesure de départ : `syn_seq.NEXTVAL` répondait ORA-02289. 3 des 5 cas tombent avant ; le témoin (NEXTVAL direct) et le synonyme inexistant (ORA-02289) passent dans les deux états.
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
