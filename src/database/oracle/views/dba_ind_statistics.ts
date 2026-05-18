/**
 * DBA_IND_STATISTICS — per-index runtime stats.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_IND_STATISTICS',
  comment: 'Per-index statistics',
  query({ storage }) {
    const rows: (string | number)[][] = [];
    for (const schema of storage.getSchemas()) {
      for (const idx of storage.getIndexes(schema)) {
        rows.push([
          schema, idx.name, idx.tableName,
          0, 0, 0, 1, 0, 1, 'YES', new Date().toISOString(),
        ]);
      }
    }
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('INDEX_NAME', 30),
        col.str('TABLE_NAME', 30),
        col.num('BLEVEL'),
        col.num('LEAF_BLOCKS'),
        col.num('DISTINCT_KEYS'),
        col.num('AVG_LEAF_BLOCKS_PER_KEY'),
        col.num('AVG_DATA_BLOCKS_PER_KEY'),
        col.num('CLUSTERING_FACTOR'),
        col.str('STALE_STATS', 3),
        col.date('LAST_ANALYZED'),
      ],
      rows
    );
  },
});
