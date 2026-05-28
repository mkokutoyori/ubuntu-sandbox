export type JobType = 'PLSQL_BLOCK' | 'STORED_PROCEDURE' | 'EXECUTABLE';
export type JobState = 'DISABLED' | 'SCHEDULED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'BROKEN' | 'STOPPED';
export type JobRunStatus = 'SUCCEEDED' | 'FAILED' | 'STOPPED';

export interface SchedulerJobInit {
  owner: string;
  jobName: string;
  jobType?: JobType;
  jobAction: string;
  startDate?: Date | null;
  repeatInterval?: string | null;
  endDate?: Date | null;
  enabled?: boolean;
  comments?: string;
  jobClass?: string;
  programName?: string | null;
  scheduleName?: string | null;
  maxRunDuration?: number | null;
  maxRuns?: number | null;
  maxFailures?: number | null;
}

export class SchedulerJob {
  readonly owner: string;
  readonly jobName: string;
  readonly jobType: JobType;
  jobAction: string;
  readonly createdAt: Date;
  startDate: Date | null;
  repeatInterval: string | null;
  endDate: Date | null;
  enabled: boolean;
  state: JobState;
  comments: string;
  jobClass: string;
  programName: string | null;
  scheduleName: string | null;
  maxRunDuration: number | null;
  maxRuns: number | null;
  maxFailures: number | null;
  runCount: number = 0;
  failureCount: number = 0;
  lastStartDate: Date | null = null;
  lastEndDate: Date | null = null;
  lastRunDurationMs: number = 0;
  nextRunDate: Date | null;

  constructor(init: SchedulerJobInit) {
    this.owner = init.owner.toUpperCase();
    this.jobName = init.jobName.toUpperCase();
    this.jobType = init.jobType ?? 'PLSQL_BLOCK';
    this.jobAction = init.jobAction;
    this.createdAt = new Date();
    this.startDate = init.startDate ?? null;
    this.repeatInterval = init.repeatInterval ?? null;
    this.endDate = init.endDate ?? null;
    this.enabled = init.enabled ?? false;
    this.state = this.enabled ? 'SCHEDULED' : 'DISABLED';
    this.comments = init.comments ?? '';
    this.jobClass = (init.jobClass ?? 'DEFAULT_JOB_CLASS').toUpperCase();
    this.programName = init.programName ? init.programName.toUpperCase() : null;
    this.scheduleName = init.scheduleName ? init.scheduleName.toUpperCase() : null;
    this.maxRunDuration = init.maxRunDuration ?? null;
    this.maxRuns = init.maxRuns ?? null;
    this.maxFailures = init.maxFailures ?? null;
    this.nextRunDate = this.enabled ? (init.startDate ?? new Date()) : null;
  }

  enable(): void {
    this.enabled = true;
    if (this.state === 'DISABLED') this.state = 'SCHEDULED';
    if (this.nextRunDate === null) this.nextRunDate = this.startDate ?? new Date();
  }

  disable(): void {
    this.enabled = false;
    this.state = 'DISABLED';
  }

  recordStart(at: Date): void {
    this.state = 'RUNNING';
    this.lastStartDate = at;
  }

  recordEnd(at: Date, success: boolean): void {
    this.lastEndDate = at;
    this.lastRunDurationMs = this.lastStartDate ? at.getTime() - this.lastStartDate.getTime() : 0;
    this.runCount++;
    if (success) {
      this.state = this.enabled && this.repeatInterval ? 'SCHEDULED' : 'COMPLETED';
    } else {
      this.failureCount++;
      this.state = this.maxFailures && this.failureCount >= this.maxFailures ? 'BROKEN' : (this.repeatInterval ? 'SCHEDULED' : 'FAILED');
    }
    this.nextRunDate = this.computeNextRun();
  }

  private computeNextRun(): Date | null {
    if (!this.enabled || !this.repeatInterval) return null;
    const m = this.repeatInterval.toUpperCase().match(/FREQ\s*=\s*(DAILY|HOURLY|MINUTELY|WEEKLY|MONTHLY)/);
    if (!m) return new Date(Date.now() + 60_000);
    const base = (this.lastEndDate ?? new Date()).getTime();
    const interval = m[1] === 'MINUTELY' ? 60_000
      : m[1] === 'HOURLY' ? 3_600_000
      : m[1] === 'DAILY' ? 86_400_000
      : m[1] === 'WEEKLY' ? 7 * 86_400_000
      : 30 * 86_400_000;
    return new Date(base + interval);
  }
}

export class SchedulerJobRun {
  readonly runId: number;
  readonly owner: string;
  readonly jobName: string;
  readonly status: JobRunStatus;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly durationMs: number;
  readonly errorCode: number;
  readonly errorMessage: string | null;
  readonly output: string;

  constructor(init: {
    runId: number; owner: string; jobName: string;
    status: JobRunStatus; startedAt: Date; endedAt: Date;
    errorCode?: number; errorMessage?: string | null; output?: string;
  }) {
    this.runId = init.runId;
    this.owner = init.owner.toUpperCase();
    this.jobName = init.jobName.toUpperCase();
    this.status = init.status;
    this.startedAt = init.startedAt;
    this.endedAt = init.endedAt;
    this.durationMs = init.endedAt.getTime() - init.startedAt.getTime();
    this.errorCode = init.errorCode ?? 0;
    this.errorMessage = init.errorMessage ?? null;
    this.output = init.output ?? '';
  }
}
