/**
 * DBA_SCHEDULER_JOB_LOG — scheduler job log entries.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_SCHEDULER_JOB_LOG',
  comment: 'Scheduler job log entries',
  query() {
    return queryResult(
      [
        col.num('LOG_ID'),
        col.date('LOG_DATE'),
        col.str('OWNER', 30),
        col.str('JOB_NAME', 30),
        col.str('STATUS', 30),
        col.str('USER_NAME', 30),
        col.str('ADDITIONAL_INFO', 4000),
      ],
      []
    );
  },
});
