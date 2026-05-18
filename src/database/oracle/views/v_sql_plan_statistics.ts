/**
 * V$SQL_PLAN_STATISTICS — runtime statistics for each plan line.
 *
 * Uses the same projection as V$SQL_PLAN_MONITOR but with cumulative
 * cardinality / I/O numbers from the event-fed SQL cache.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SQL_PLAN_STATISTICS',
  comment: 'Plan-line runtime statistics',
  query({ runtime }) {
    return queryResult(
      [
        col.str('SQL_ID', 13),
        col.num('PLAN_HASH_VALUE'),
        col.num('CHILD_NUMBER'),
        col.num('OPERATION_ID'),
        col.num('EXECUTIONS'),
        col.num('LAST_OUTPUT_ROWS'),
        col.num('LAST_CR_BUFFER_GETS'),
        col.num('LAST_CU_BUFFER_GETS'),
        col.num('LAST_DISK_READS'),
        col.num('LAST_ELAPSED_TIME'),
      ],
      [...runtime.sqlCache.values()].map(s => [
        s.sqlId, 0, 0, 0, s.executions, s.rowsProcessed,
        s.bufferGets, 0, s.diskReads, s.elapsedMicros,
      ])
    );
  },
});
