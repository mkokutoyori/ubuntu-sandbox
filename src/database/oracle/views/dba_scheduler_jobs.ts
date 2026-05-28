import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

function isoDurationFromMs(ms: number): string {
  if (ms <= 0) return '+000 00:00:00';
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return `+${String(days).padStart(3, '0')} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function jobGuid(owner: string, jobName: string): string {
  let h = 0;
  const seed = `${owner}.${jobName}`;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h + seed.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16).padStart(32, '0').toUpperCase().slice(0, 32);
}

registerView({
  name: 'DBA_SCHEDULER_JOBS',
  comment: 'DBMS_SCHEDULER jobs',
  query({ instance }) {
    const jobs = instance.scheduler?.getAllJobs() ?? [];
    return queryResult(
      [
        col.str('OWNER', 30),
        col.str('JOB_NAME', 30),
        col.str('JOB_SUBNAME', 30),
        col.str('JOB_STYLE', 16),
        col.str('JOB_CREATOR', 30),
        col.str('CLIENT_ID', 64),
        col.str('GLOBAL_UID', 32),
        col.str('PROGRAM_OWNER', 30),
        col.str('PROGRAM_NAME', 30),
        col.str('JOB_TYPE', 16),
        col.str('JOB_ACTION', 4000),
        col.num('NUMBER_OF_ARGUMENTS'),
        col.str('SCHEDULE_OWNER', 30),
        col.str('SCHEDULE_NAME', 30),
        col.str('SCHEDULE_TYPE', 12),
        col.date('START_DATE'),
        col.str('REPEAT_INTERVAL', 4000),
        col.date('END_DATE'),
        col.str('JOB_CLASS', 30),
        col.str('ENABLED', 5),
        col.str('AUTO_DROP', 5),
        col.str('RESTART_ON_RECOVERY', 5),
        col.str('RESTART_ON_FAILURE', 5),
        col.str('STATE', 15),
        col.num('JOB_PRIORITY'),
        col.num('RUN_COUNT'),
        col.num('MAX_RUNS'),
        col.num('FAILURE_COUNT'),
        col.num('MAX_FAILURES'),
        col.num('RETRY_COUNT'),
        col.date('LAST_START_DATE'),
        col.str('LAST_RUN_DURATION', 64),
        col.date('NEXT_RUN_DATE'),
        col.str('COMMENTS', 240),
      ],
      jobs.map(j => [
        j.owner, j.jobName, null, 'REGULAR', j.owner, null, jobGuid(j.owner, j.jobName),
        null, j.programName, j.jobType, j.jobAction, 0,
        null, j.scheduleName, j.repeatInterval ? 'PLSQL' : 'ONCE',
        j.startDate ? j.startDate.toISOString() : null,
        j.repeatInterval,
        j.endDate ? j.endDate.toISOString() : null,
        j.jobClass,
        j.enabled ? 'TRUE' : 'FALSE',
        'FALSE', 'FALSE', 'FALSE',
        j.state, 3, j.runCount, j.maxRuns, j.failureCount, j.maxFailures, 0,
        j.lastStartDate ? j.lastStartDate.toISOString() : null,
        isoDurationFromMs(j.lastRunDurationMs),
        j.nextRunDate ? j.nextRunDate.toISOString() : null,
        j.comments,
      ]),
    );
  },
});
