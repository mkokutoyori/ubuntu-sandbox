/**
 * DBA_OPTSTAT_OPERATION_TASKS — per-task detail for stats operations.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_OPTSTAT_OPERATION_TASKS',
  comment: 'Stats operation per-task detail',
  query() {
    return queryResult(
      [
        col.str('OPERATION', 64),
        col.str('TARGET_OBJN', 64),
        col.str('OPERATION_TYPE', 32),
        col.date('START_TIME'),
        col.date('END_TIME'),
        col.str('STATUS', 30),
      ],
      []
    );
  },
});
