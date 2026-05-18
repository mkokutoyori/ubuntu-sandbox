/**
 * Debug — Cohérence de l'enregistrement des vues Oracle.
 *
 * Objectif : garantir que TOUTE vue auto-enregistrée via `registerView`
 * (fichiers sous `src/database/oracle/views/`) apparaît bien dans le
 * dictionnaire de données — `DBA_VIEWS`, `ALL_VIEWS`, `DICTIONARY` — et
 * reste interrogeable directement. Le fichier de transcript produit sous
 * `debug-output/oracle/` sert d'inspection humaine ; les assertions
 * ci-dessous échouent si la registry et le dictionnaire divergent.
 */

import { describe, it, beforeEach, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { removeOracleDatabase, getOracleDatabase } from '@/terminal/commands/database';
import { listRegisteredViews } from '@/database/oracle/views/registry';
import { createSqlPlusRunner, runOracleDump, type OracleDebugLine } from './_oracle-dump';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

/** Oracle expose `V$X` ; `V_$X` est un alias. On normalise pour comparer. */
const norm = (n: string) => n.toUpperCase().replace(/^V_\$/, 'V$');

describe('debug — Oracle view registration coherence', () => {
  it('toute vue registerView apparaît dans DBA_VIEWS / ALL_VIEWS / DICT', () => {
    const srv = new LinuxServer('linux-server', 'ora-viewreg', 100, 100);
    const db = getOracleDatabase(srv.id);
    const { executor } = db.connectAsSysdba();

    const namesOf = (sql: string, col = 'VIEW_NAME'): Set<string> => {
      const rs = db.executeSql(executor, sql);
      const idx = rs.columns.findIndex(c => c.name === col);
      return new Set(rs.rows.map(r => norm(String(r[idx]))));
    };

    const registered = [...new Set(listRegisteredViews().map(v => norm(v.name)))].sort();
    const inDbaViews = namesOf('SELECT VIEW_NAME FROM DBA_VIEWS');
    const inAllViews = namesOf('SELECT VIEW_NAME FROM ALL_VIEWS');
    const inDict = namesOf('SELECT TABLE_NAME FROM DICTIONARY', 'TABLE_NAME');

    const missingFromDba = registered.filter(n => !inDbaViews.has(n));
    const missingFromAll = registered.filter(n => !inAllViews.has(n));
    const missingFromDict = registered.filter(n => !inDict.has(n));

    // Échantillon de vues historiquement absentes (enregistrées mais
    // jamais ajoutées à l'ancien catalogue statique builtinCatalog.ts).
    const spotCheck = ['V$BH', 'V$WAIT_CHAINS', 'V$SQL_MONITOR', 'DBA_HIST_SNAPSHOT',
      'V$SESSION_LONGOPS', 'DBA_SCHEDULER_PROGRAMS', 'V$PGASTAT', 'DBA_RECYCLEBIN']
      .filter(n => registered.includes(n));

    const lines: OracleDebugLine[] = [
      { section: 'registry vs dictionary', note:
        `registry=${registered.length} dba_views=${inDbaViews.size} ` +
        `all_views=${inAllViews.size} dict=${inDict.size}`,
        cmd: 'SELECT COUNT(*) AS dba_views FROM DBA_VIEWS;' },
      'SELECT COUNT(*) AS all_views FROM ALL_VIEWS;',
      'SELECT COUNT(*) AS dict_entries FROM DICTIONARY;',
      { note: `manquantes DBA_VIEWS: ${missingFromDba.join(', ') || '(aucune)'}`,
        cmd: 'SELECT 1 FROM DUAL;' },
      { note: `manquantes ALL_VIEWS: ${missingFromAll.join(', ') || '(aucune)'}`,
        cmd: 'SELECT 1 FROM DUAL;' },
      { note: `manquantes DICTIONARY: ${missingFromDict.join(', ') || '(aucune)'}`,
        cmd: 'SELECT 1 FROM DUAL;' },
      { section: 'spot-check (vues jadis absentes)', cmd: 'SELECT 1 FROM DUAL;' },
    ];
    for (const v of spotCheck) {
      lines.push(`SELECT VIEW_NAME, TEXT_LENGTH FROM DBA_VIEWS WHERE VIEW_NAME = '${v}';`);
      lines.push(`SELECT COUNT(*) FROM ALL_VIEWS WHERE VIEW_NAME = '${v}';`);
      lines.push(`SELECT * FROM ${v} WHERE rownum < 3;`);
    }

    const runner = createSqlPlusRunner(srv);
    runOracleDump('oracle-view-registration', srv.name, lines, runner);
    runner.dispose();

    // ── Assertions de cohérence ──────────────────────────────────────
    expect(registered.length).toBeGreaterThan(100);
    expect(missingFromDba, 'vues enregistrées absentes de DBA_VIEWS').toEqual([]);
    expect(missingFromAll, 'vues enregistrées absentes de ALL_VIEWS').toEqual([]);
    expect(missingFromDict, 'vues enregistrées absentes de DICTIONARY').toEqual([]);

    // Chaque vue spot-check est interrogeable et porte un TEXT non vide.
    for (const v of spotCheck) {
      const rs = db.executeSql(executor,
        `SELECT VIEW_NAME, TEXT FROM DBA_VIEWS WHERE VIEW_NAME = '${v}'`);
      expect(rs.rows.length, `${v} absente de DBA_VIEWS`).toBe(1);
      expect(String(rs.rows[0][1]).length, `${v} TEXT vide`).toBeGreaterThan(0);
      const direct = db.executeSql(executor, `SELECT * FROM ${v} WHERE rownum < 3`);
      expect(direct.isQuery, `SELECT * FROM ${v} a échoué`).toBe(true);
    }

    // DBA_VIEWS reste stable entre deux appels (pas d'effet de bord).
    const a = db.executeSql(executor, 'SELECT COUNT(*) FROM DBA_VIEWS').rows[0][0];
    const b = db.executeSql(executor, 'SELECT COUNT(*) FROM DBA_VIEWS').rows[0][0];
    expect(a).toBe(b);

    removeOracleDatabase(srv.id);
  });
});
