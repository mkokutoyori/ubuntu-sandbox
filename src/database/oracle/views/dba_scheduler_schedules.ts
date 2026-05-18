/**
 * DBA_SCHEDULER_SCHEDULES — DBMS_SCHEDULER schedules.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_SCHEDULER_SCHEDULES',
  comment: 'DBMS_SCHEDULER schedules',
  query() {
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('SCHEDULE_NAME', 30),
        col.str('SCHEDULE_TYPE', 12),
        col.date('START_DATE'),
        col.date('END_DATE'),
        col.str('REPEAT_INTERVAL', 4000),
        col.str('COMMENTS', 240),
      ],
      []
    );
  },
});
