/**
 * DBA_OPTSTAT_OPERATIONS — recent stats-gathering operations.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_OPTSTAT_OPERATIONS',
  comment: 'Optimizer statistics operations',
  query() {
    return queryResult(
      [
        col.str('OPERATION', 64),
        col.str('TARGET', 64),
        col.date('START_TIME'),
        col.date('END_TIME'),
        col.str('STATUS', 30),
        col.str('JOB_NAME', 30),
      ],
      []
    );
  },
});
