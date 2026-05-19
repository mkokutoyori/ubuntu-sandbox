/**
 * DBA_TAB_PARTITIONS — table partitions, derived from the real
 * `meta.partitioning.partitions` array populated at CREATE TABLE time.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_TAB_PARTITIONS',
  comment: 'Table partitions',
  query({ storage }) {
    const rows: (string | number | null)[][] = [];
    for (const t of storage.getAllTables()) {
      const part = t.partitioning;
      if (!part) continue;
      part.partitions.forEach((p, idx) => {
        rows.push([
          t.schema, t.name, p.name, 0,
          p.highValue ?? null, idx + 1,
          p.tablespace ?? t.tablespace ?? 'USERS',
          0,
        ]);
      });
    }
    return queryResult(
      [
        col.str('TABLE_OWNER', 30),
        col.str('TABLE_NAME', 30),
        col.str('PARTITION_NAME', 30),
        col.num('SUBPARTITION_COUNT'),
        col.str('HIGH_VALUE', 4000),
        col.num('PARTITION_POSITION'),
        col.str('TABLESPACE_NAME', 30),
        col.num('NUM_ROWS'),
      ],
      rows,
    );
  },
});
