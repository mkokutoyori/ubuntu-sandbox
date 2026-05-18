/**
 * V$SQL_WORKAREA — sort/hash work-area usage per cursor.
 *
 * Derived from the SQL cache; each row reports the optimal/onepass/
 * multipass executions and memory usage. We don't track work-area
 * spills, so they are reported as 'OPTIMAL'.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'V$SQL_WORKAREA',
  comment: 'SQL work-area usage per cursor',
  query({ runtime }) {
    return queryResult(
      [
        col.str('SQL_ID', 13),
        col.num('CHILD_NUMBER'),
        col.str('OPERATION_TYPE', 16),
        col.num('OPTIMAL_EXECUTIONS'),
        col.num('ONEPASS_EXECUTIONS'),
        col.num('MULTIPASSES_EXECUTIONS'),
        col.num('ESTIMATED_OPTIMAL_SIZE'),
        col.num('LAST_MEMORY_USED'),
      ],
      [...runtime.sqlCache.values()].map(s => [
        s.sqlId, 0, 'SORT', s.executions, 0, 0, 65536, 65536,
      ])
    );
  },
});
