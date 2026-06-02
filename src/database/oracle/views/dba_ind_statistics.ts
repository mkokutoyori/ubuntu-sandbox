/**
 * DBA_IND_STATISTICS — per-index statistics.
 * Backed by StatisticsManager when DBMS_STATS has been run.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_IND_STATISTICS',
  comment: 'Per-index statistics',
  query({ storage, instance }) {
    const stats = instance.statistics?.getAllIndexStats() ?? [];
    const byKey = new Map<string, typeof stats[number]>();
    for (const s of stats) byKey.set(`${s.owner}.${s.indexName}`, s);
    const rows: (string | number)[][] = [];
    for (const schema of storage.getSchemas()) {
      for (const idx of storage.getIndexes(schema)) {
        const s = byKey.get(`${schema}.${idx.name}`);
        if (s) {
          rows.push([
            s.owner, s.indexName, s.tableName,
            s.bLevel, s.leafBlocks, s.distinctKeys,
            s.avgLeafBlocksPerKey, s.avgDataBlocksPerKey,
            s.clusterFactor, 'NO', s.lastAnalyzed.toISOString(),
            s.numRows, s.sampleSize,
          ]);
        } else {
          rows.push([
            schema, idx.name, idx.tableName,
            0, 0, 0, 1, 0, 1, 'YES', '',
            0, 0,
          ]);
        }
      }
    }
    return queryResult(
      [
        col.str('OWNER', 128),
        col.str('INDEX_NAME', 128),
        col.str('TABLE_NAME', 128),
        col.num('BLEVEL'),
        col.num('LEAF_BLOCKS'),
        col.num('DISTINCT_KEYS'),
        col.num('AVG_LEAF_BLOCKS_PER_KEY'),
        col.num('AVG_DATA_BLOCKS_PER_KEY'),
        col.num('CLUSTERING_FACTOR'),
        col.str('STALE_STATS', 3),
        col.date('LAST_ANALYZED'),
        col.num('NUM_ROWS'),
        col.num('SAMPLE_SIZE'),
      ],
      rows,
    );
  },
});
