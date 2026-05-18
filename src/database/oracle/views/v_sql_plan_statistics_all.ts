/**
 * V$SQL_PLAN_STATISTICS_ALL — V$SQL_PLAN ∪ V$SQL_PLAN_STATISTICS.
 *
 * Surfaces a single composite row per cached cursor with both static
 * plan info (estimated cardinality, cost) and the event-fed runtime
 * stats (last_output_rows, last_elapsed_time).
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SQL_PLAN_STATISTICS_ALL',
  comment: 'Combined plan + runtime stats',
  query({ runtime }) {
    return queryResult(
      [
        col.str('SQL_ID', 13),
        col.num('PLAN_HASH_VALUE'),
        col.num('OPERATION_ID'),
        col.str('OPERATION', 30),
        col.str('OPTIONS', 30),
        col.num('COST'),
        col.num('CARDINALITY'),
        col.num('BYTES'),
        col.num('LAST_OUTPUT_ROWS'),
        col.num('LAST_ELAPSED_TIME'),
      ],
      [...runtime.sqlCache.values()].map(s => [
        s.sqlId, 0, 0, 'SELECT STATEMENT', '', 1,
        s.rowsProcessed, s.rowsProcessed * 200,
        s.rowsProcessed, s.elapsedMicros,
      ])
    );
  },
});
