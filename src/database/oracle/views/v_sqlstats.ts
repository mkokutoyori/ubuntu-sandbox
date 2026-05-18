/**
 * V$SQLSTATS — per-SQL_ID execution stats.
 *
 * Pure projection of `runtime.sqlCache`, populated by `oracle.sql.parsed`
 * and updated by `oracle.sql.executed`.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SQLSTATS',
  comment: 'Aggregated SQL statistics by SQL_ID',
  query({ runtime }) {
    return queryResult(
      [
        col.str('SQL_ID', 13),
        col.num('PLAN_HASH_VALUE'),
        col.num('PARSE_CALLS'),
        col.num('EXECUTIONS'),
        col.num('FETCHES'),
        col.num('ELAPSED_TIME'),
        col.num('CPU_TIME'),
        col.num('BUFFER_GETS'),
        col.num('DISK_READS'),
        col.num('ROWS_PROCESSED'),
        col.str('PARSING_SCHEMA_NAME', 30),
        col.date('LAST_ACTIVE_TIME'),
      ],
      [...runtime.sqlCache.values()].map(s => [
        s.sqlId, 0, s.executions, s.executions, s.executions,
        s.elapsedMicros, s.cpuMicros, s.bufferGets, s.diskReads, s.rowsProcessed,
        s.parsingSchema, new Date(s.lastLoadTime).toISOString(),
      ])
    );
  },
});
