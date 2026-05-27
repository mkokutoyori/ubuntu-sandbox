import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_SCHEDULER_JOB_LOG',
  comment: 'Scheduler job log entries',
  query({ instance }) {
    const runs = instance.scheduler?.getAllRuns() ?? [];
    return queryResult(
      [
        col.num('LOG_ID'),
        col.date('LOG_DATE'),
        col.str('OWNER', 128),
        col.str('JOB_NAME', 128),
        col.str('STATUS', 30),
        col.str('USER_NAME', 128),
        col.str('OPERATION', 30),
        col.str('ADDITIONAL_INFO', 4000),
      ],
      runs.map(r => [
        r.runId, r.endedAt.toISOString(), r.owner, r.jobName, r.status,
        r.owner, 'RUN', r.errorMessage,
      ]),
    );
  },
});
