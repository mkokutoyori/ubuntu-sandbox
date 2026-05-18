/**
 * DBA_COL_STATISTICS — per-column runtime stats.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_COL_STATISTICS',
  comment: 'Per-column statistics',
  query({ storage }) {
    const rows: (string | number | null)[][] = [];
    for (const t of storage.getAllTables()) {
      for (const c of t.columns) {
        rows.push([
          t.schema, t.name, c.name,
          0, t.rowCount, null, null, null, null,
          new Date().toISOString(), 'NO', 'NONE',
        ]);
      }
    }
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('TABLE_NAME', 30),
        col.str('COLUMN_NAME', 30),
        col.num('NUM_DISTINCT'),
        col.num('NUM_BUCKETS'),
        col.str('LOW_VALUE', 1000),
        col.str('HIGH_VALUE', 1000),
        col.str('DENSITY', 30),
        col.num('NUM_NULLS'),
        col.date('LAST_ANALYZED'),
        col.str('STALE_STATS', 3),
        col.str('HISTOGRAM', 15),
      ],
      rows
    );
  },
});
