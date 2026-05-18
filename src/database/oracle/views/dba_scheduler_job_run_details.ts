/**
 * DBA_SCHEDULER_JOB_RUN_DETAILS — completed scheduler job runs.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_SCHEDULER_JOB_RUN_DETAILS',
  comment: 'Scheduler job run details',
  query() {
    return queryResult(
      [
        col.num('LOG_ID'),
        col.date('LOG_DATE'),
        col.str('OWNER', 30),
        col.str('JOB_NAME', 30),
        col.str('STATUS', 30),
        col.num('ERROR#'),
        col.str('ADDITIONAL_INFO', 4000),
        col.str('RUN_DURATION', 30),
      ],
      []
    );
  },
});
