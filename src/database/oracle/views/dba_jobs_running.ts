/**
 * DBA_JOBS_RUNNING — currently-executing DBMS_JOB jobs.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_JOBS_RUNNING',
  comment: 'Currently-executing DBMS_JOB jobs',
  query() {
    return queryResult(
      [
        col.num('SID'),
        col.num('JOB'),
        col.date('FAILURES'),
        col.date('LAST_DATE'),
        col.str('LAST_SEC', 8),
        col.date('THIS_DATE'),
        col.str('THIS_SEC', 8),
        col.str('INSTANCE', 16),
      ],
      []
    );
  },
});
