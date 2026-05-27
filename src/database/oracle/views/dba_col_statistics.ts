/**
 * DBA_COL_STATISTICS — per-column statistics.
 *
 * Backed by StatisticsManager when DBMS_STATS has been run; falls
 * back to NUM_DISTINCT=0 / NUM_NULLS=row_count default for tables
 * that have never been analyzed.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_COL_STATISTICS',
  comment: 'Per-column statistics',
  query({ storage, instance }) {
    const stats = instance.statistics;
    const allCol = stats?.getAllColumnStats() ?? [];
    const byKey = new Map<string, typeof allCol[number]>();
    for (const c of allCol) byKey.set(`${c.owner}.${c.tableName}.${c.columnName}`, c);
    const rows: (string | number | null)[][] = [];
    for (const t of storage.getAllTables()) {
      for (const c of t.columns) {
        const s = byKey.get(`${t.schema}.${t.name}.${c.name.toUpperCase()}`);
        if (s) {
          rows.push([
            s.owner, s.tableName, s.columnName,
            s.numDistinct, s.numBuckets, s.lowValue, s.highValue,
            s.density.toFixed(6), s.numNulls,
            s.lastAnalyzed.toISOString(), 'NO', s.histogram, s.avgColLen,
          ]);
        } else {
          rows.push([
            t.schema, t.name, c.name,
            0, 0, null, null, '0', t.rowCount,
            null, 'NO', 'NONE', c.dataType.precision ?? 4,
          ]);
        }
      }
    }
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('TABLE_NAME', 128),
        col.str('COLUMN_NAME', 128),
        col.num('NUM_DISTINCT'),
        col.num('NUM_BUCKETS'),
        col.str('LOW_VALUE', 1000),
        col.str('HIGH_VALUE', 1000),
        col.str('DENSITY', 30),
        col.num('NUM_NULLS'),
        col.date('LAST_ANALYZED'),
        col.str('STALE_STATS', 3),
        col.str('HISTOGRAM', 15),
        col.num('AVG_COL_LEN'),
      ],
      rows,
    );
  },
});
