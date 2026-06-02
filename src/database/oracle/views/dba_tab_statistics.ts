/**
 * DBA_TAB_STATISTICS — table optimizer statistics.
 *
 * Backed by StatisticsManager when DBMS_STATS has been run; falls back
 * to a row-count-driven estimate so the view is never empty on a
 * fresh database (matches Oracle behaviour: tables that have never
 * been analyzed still appear with default values).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_TAB_STATISTICS',
  comment: 'Table statistics',
  query({ storage, instance }) {
    const stats = instance.statistics;
    const rows: (string | number | null)[][] = [];
    for (const t of storage.getAllTables()) {
      const s = stats?.getTableStats(t.schema, t.name);
      if (s) {
        rows.push([
          s.owner, s.tableName, s.numRows, s.blocks, s.avgRowLen,
          s.lastAnalyzed.toISOString(), s.stale ? 'YES' : 'NO',
          s.statType, s.sampleSize, s.emptyBlocks, s.chainCount,
        ]);
      } else {
        rows.push([
          t.schema, t.name, t.rowCount, Math.ceil(t.rowCount * 200 / 8192),
          200, null, 'NO', 'GLOBAL', null, null, null,
        ]);
      }
    }
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('TABLE_NAME', 128),
        col.num('NUM_ROWS'),
        col.num('BLOCKS'),
        col.num('AVG_ROW_LEN'),
        col.date('LAST_ANALYZED'),
        col.str('STALE_STATS', 3),
        col.str('STATTYPE_LOCKED', 15),
        col.num('SAMPLE_SIZE'),
        col.num('EMPTY_BLOCKS'),
        col.num('CHAIN_CNT'),
      ],
      rows,
    );
  },
});
