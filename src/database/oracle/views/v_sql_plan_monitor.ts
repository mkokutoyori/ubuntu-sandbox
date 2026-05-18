/**
 * V$SQL_PLAN_MONITOR — per-line plan monitoring for the cursors shown
 * in V$SQL_MONITOR. We don't generate real plans, so we emit a single
 * placeholder root SELECT STATEMENT per monitored cursor.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SQL_PLAN_MONITOR',
  comment: 'Per-plan-step monitoring',
  query({ runtime }) {
    const sorted = [...runtime.sqlCache.values()]
      .sort((a, b) => b.lastLoadTime - a.lastLoadTime)
      .slice(0, 50);
    return queryResult(
      [
        col.str('SQL_ID', 13),
        col.num('SQL_EXEC_ID'),
        col.num('PLAN_LINE_ID'),
        col.str('PLAN_OPERATION', 30),
        col.str('PLAN_OPTIONS', 30),
        col.num('STARTS'),
        col.num('OUTPUT_ROWS'),
      ],
      sorted.map((s, idx) => [
        s.sqlId, idx + 1, 0, 'SELECT STATEMENT', '', s.executions, s.rowsProcessed,
      ])
    );
  },
});
