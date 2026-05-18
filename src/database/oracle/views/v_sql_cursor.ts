/**
 * V$SQL_CURSOR — internal cursor state for diagnostics.
 *
 * One row per cached cursor (event-fed via oracle.sql.parsed). Each
 * cursor is reported as OPEN in our simulator.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SQL_CURSOR',
  comment: 'Internal cursor state',
  query({ runtime }) {
    return queryResult(
      [
        col.num('CURNO'),
        col.str('SQL_ID', 13),
        col.str('PARENT_HANDLE', 16),
        col.str('CHILD_HANDLE', 16),
        col.num('CHILD_NUMBER'),
        col.str('PARENT_LOCK', 8),
        col.str('CHILD_LOCK', 8),
        col.str('CHILD_PIN', 8),
        col.str('STATUS', 12),
      ],
      [...runtime.sqlCache.values()].map((s, idx) => [
        idx, s.sqlId, `00${idx.toString(16)}`, `01${idx.toString(16)}`,
        0, 'NONE', 'NONE', 'NONE', 'OPEN',
      ])
    );
  },
});
