import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

registerView({
  name: 'DBA_SCHEDULER_JOB_RUN_DETAILS',
  comment: 'Scheduler job run details',
  query({ instance }) {
    const runs = instance.scheduler?.getAllRuns() ?? [];
    return queryResult(
      [
        col.num('LOG_ID'),
        col.date('LOG_DATE'),
        col.str('OWNER', 128),
        col.str('JOB_NAME', 128),
        col.str('STATUS', 30),
        col.num('ERROR#'),
        col.date('REQ_START_DATE'),
        col.date('ACTUAL_START_DATE'),
        col.num('RUN_DURATION_MS'),
        col.str('ADDITIONAL_INFO', 4000),
        col.str('OUTPUT', 4000),
      ],
      runs.map(r => [
        r.runId, r.endedAt.toISOString(), r.owner, r.jobName, r.status,
        r.errorCode, r.startedAt.toISOString(), r.startedAt.toISOString(),
        r.durationMs, r.errorMessage, r.output,
      ]),
    );
  },
});
