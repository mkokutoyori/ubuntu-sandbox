/**
 * DBA_HIST_SQLSTAT — historical per-SQL execution stats per snapshot.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_HIST_SQLSTAT',
  comment: 'Historical SQL execution stats',
  query({ runtime }) {
    const now = Date.now();
    const elapsedHours = Math.max(1, Math.floor((now - runtime.startedAt) / 3_600_000));
    const buckets = Math.min(elapsedHours, 50);
    const rows: (string | number)[][] = [];
    const sqlValues = [...runtime.sqlCache.values()];
    for (let b = 0; b < buckets; b++) {
      const snapId = elapsedHours - b;
      sqlValues.forEach(s => {
        rows.push([
          snapId, s.sqlId, 0,
          s.executions, s.elapsedMicros, s.cpuMicros,
          s.bufferGets, s.diskReads, s.rowsProcessed,
        ]);
      });
    }
    return queryResult(
      [
        col.num('SNAP_ID'),
        col.str('SQL_ID', 13),
        col.num('PLAN_HASH_VALUE'),
        col.num('EXECUTIONS_DELTA'),
        col.num('ELAPSED_TIME_DELTA'),
        col.num('CPU_TIME_DELTA'),
        col.num('BUFFER_GETS_DELTA'),
        col.num('DISK_READS_DELTA'),
        col.num('ROWS_PROCESSED_DELTA'),
      ],
      rows
    );
  },
});
