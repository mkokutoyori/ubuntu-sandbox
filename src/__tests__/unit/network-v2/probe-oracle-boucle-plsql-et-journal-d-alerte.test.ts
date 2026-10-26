/**
 * Mesure (Node, SQL*Plus sur un LinuxServer) d'une boucle PL/SQL qui modifie des lignes une a une :
 *
 * - 5000 `INSERT` dans un bloc : 2,5 s, dont 1,3 s a reecrire en entier /u01/.../alert_ORCL.log apres CHAQUE ligne d'alerte (une anomalie « OFF_HOURS_DML » par DML hors heures
 *   ouvrables) : cout quadratique du fichier ; idem pour listener.log a chaque connexion. L'adaptateur ajoute maintenant la seule ligne nouvelle (appendSystemFile) quand le
 *   fichier est a jour, et reecrit tout sinon ;
 * - 1500 `UPDATE big SET … WHERE id = i` sur 20 000 lignes : 4,5 s, parce que UPDATE et DELETE evaluaient leur WHERE sur toutes les lignes alors que SELECT passait deja par
 *   l'index de cle (tryIndexAccessPath). UPDATE et DELETE restreignent maintenant le WHERE aux candidats de l'index ; la condition complete est reevaluee sur eux.
 *
 * Discrimine par `git stash push -- src/database src/adapters src/network/devices/LinuxMachine.ts` : les deux cas de duree tombent. Passent des deux cotes, TEMOINS : le fichier
 * d'alerte porte une ligne par entree, les UPDATE/DELETE a cle et a OR touchent les bonnes lignes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase } from '@/terminal/commands/database';
import { createSqlPlusRunner, type SqlPlusRunner } from '../../debug/oracle/_oracle-dump';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

function lab(): { srv: LinuxServer; sql: SqlPlusRunner } {
  const srv = new LinuxServer('linux-server', 'ora-volume', 0, 0);
  getOracleDatabase(srv.id);
  return { srv, sql: createSqlPlusRunner(srv) };
}

describe('boucles PL/SQL et journal d alerte', () => {
  it('6000 INSERT dans un bloc PL/SQL tiennent sous 1,5 s', () => {
    const { sql } = lab();
    sql.execute('CREATE TABLE t2 (id NUMBER, v VARCHAR2(20));');
    const startedAt = performance.now();
    sql.execute("BEGIN FOR i IN 1..6000 LOOP INSERT INTO t2 VALUES (i, 'v'||i); END LOOP; COMMIT; END;");
    expect(performance.now() - startedAt).toBeLessThan(1500);
    expect(sql.execute('SELECT COUNT(*) FROM t2;')).toContain('6000');
  }, 120_000);

  it('1500 UPDATE par cle primaire sur 20 000 lignes tiennent sous 1,5 s', () => {
    const { sql } = lab();
    sql.execute('CREATE TABLE big (id NUMBER PRIMARY KEY, grp NUMBER, amount NUMBER);');
    sql.execute('INSERT INTO big SELECT level, MOD(level, 100), level FROM dual CONNECT BY level <= 20000;');
    const startedAt = performance.now();
    sql.execute('BEGIN FOR i IN 1..1500 LOOP UPDATE big SET amount = amount + 1 WHERE id = i; END LOOP; COMMIT; END;');
    expect(performance.now() - startedAt).toBeLessThan(1500);
    expect(sql.execute('SELECT amount FROM big WHERE id = 1500;')).toContain('1501');
    expect(sql.execute('SELECT amount FROM big WHERE id = 1501;')).toContain('1501');
  }, 120_000);

  it('TEMOIN — le fichier d alerte porte une ligne par entree du journal de l instance', () => {
    const { srv, sql } = lab();
    sql.execute('CREATE TABLE t3 (id NUMBER);');
    sql.execute('BEGIN FOR i IN 1..40 LOOP INSERT INTO t3 VALUES (i); END LOOP; COMMIT; END;');
    const instance = (getOracleDatabase(srv.id) as unknown as { instance: { getAlertLog(): string[] } }).instance;
    const file = (srv as unknown as { executor: { vfs: { find(path: string, o: object): string[]; readFile(path: string): string | null } } })
      .executor.vfs;
    const path = file.find('/', { type: 'f' }).find((candidate) => /alert_.*\.log$/.test(candidate));
    expect(path).toBeDefined();
    expect((file.readFile(path as string) ?? '').trimEnd().split('\n')).toEqual(instance.getAlertLog());
  }, 120_000);

  it('TEMOIN — UPDATE et DELETE a cle, a conjonction et a OR touchent les bonnes lignes', () => {
    const { sql } = lab();
    sql.execute('CREATE TABLE k (id NUMBER PRIMARY KEY, grp NUMBER, amount NUMBER);');
    sql.execute('INSERT INTO k SELECT level, MOD(level, 3), level FROM dual CONNECT BY level <= 30;');
    expect(sql.execute('UPDATE k SET amount = -1 WHERE id = 5 AND grp = 2;')).toContain('1 row updated');
    expect(sql.execute('UPDATE k SET amount = -2 WHERE id = 5 AND grp = 0;')).toContain('0 rows updated');
    expect(sql.execute('DELETE FROM k WHERE id = 7 OR id = 8;')).toContain('2 rows deleted');
    expect(sql.execute('DELETE FROM k WHERE id = 9;')).toContain('1 row deleted');
    expect(sql.execute('SELECT COUNT(*) FROM k;')).toContain('27');
    expect(sql.execute('SELECT amount FROM k WHERE id = 5;')).toContain('-1');
  });
});
