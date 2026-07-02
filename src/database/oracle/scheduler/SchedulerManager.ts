import type { OracleDatabase } from '../OracleDatabase';
import { SchedulerJob, SchedulerJobRun, type SchedulerJobInit } from './SchedulerJob';

export class SchedulerManager {
  private jobs = new Map<string, SchedulerJob>();
  private runs: SchedulerJobRun[] = [];
  private nextRunId = 1;
  private maxRunHistory = 2000;

  constructor(private readonly db: OracleDatabase) {}

  createJob(init: SchedulerJobInit): SchedulerJob {
    const job = new SchedulerJob(init);
    this.jobs.set(`${job.owner}.${job.jobName}`, job);
    return job;
  }

  dropJob(owner: string, jobName: string): boolean {
    return this.jobs.delete(`${owner.toUpperCase()}.${jobName.toUpperCase()}`);
  }

  enableJob(owner: string, jobName: string): boolean {
    const j = this.lookup(owner, jobName);
    if (!j) return false;
    j.enable();
    return true;
  }

  disableJob(owner: string, jobName: string): boolean {
    const j = this.lookup(owner, jobName);
    if (!j) return false;
    j.disable();
    return true;
  }

  setAttribute(owner: string, jobName: string, attribute: string, value: string | Date | number | boolean): boolean {
    const j = this.lookup(owner, jobName);
    if (!j) return false;
    const attr = attribute.toUpperCase();
    switch (attr) {
      case 'JOB_ACTION':       j.jobAction = String(value); break;
      case 'REPEAT_INTERVAL':  j.repeatInterval = value === null ? null : String(value); break;
      case 'START_DATE':       j.startDate = value instanceof Date ? value : new Date(String(value)); break;
      case 'END_DATE':         j.endDate = value instanceof Date ? value : new Date(String(value)); break;
      case 'ENABLED':          if (value) j.enable(); else j.disable(); break;
      case 'COMMENTS':         j.comments = String(value); break;
      case 'MAX_RUN_DURATION': j.maxRunDuration = Number(value); break;
      case 'MAX_RUNS':         j.maxRuns = Number(value); break;
      case 'MAX_FAILURES':     j.maxFailures = Number(value); break;
    }
    return true;
  }

  runJob(owner: string, jobName: string, useCurrentSession: boolean = true): SchedulerJobRun | null {
    const j = this.lookup(owner, jobName);
    if (!j) return null;
    const startedAt = new Date();
    j.recordStart(startedAt);
    let status: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED';
    let errorCode = 0;
    let errorMessage: string | null = null;
    let output = '';
    try {
      if (j.jobType === 'EXECUTABLE') {
        const res = this.db.instance.runOsCommand(j.jobAction);
        if (!res) {
          status = 'FAILED';
          errorCode = 27370;
          errorMessage = 'ORA-27370: job slave failed to launch a job of type EXECUTABLE';
        } else {
          output = res.output;
          if (res.exitCode !== 0) {
            status = 'FAILED';
            errorCode = 27369;
            errorMessage = `ORA-27369: job of type EXECUTABLE failed with exit code: ${res.exitCode}`;
          }
        }
      } else {
        const { executor } = this.db.connectAsSysdba();
        try {
          // A scheduler job runs in its owner's schema with the owner's
          // privileges (real Oracle), so unqualified object names resolve
          // there — not in SYS. The slave still connects internally as
          // SYSDBA; we only retarget the execution context.
          const ctx = (executor as unknown as { context?: { currentUser: string; currentSchema: string } }).context;
          if (ctx) { ctx.currentUser = j.owner; ctx.currentSchema = j.owner; }
          // STORED_PROCEDURE jobs carry a bare procedure/package name in
          // job_action — Oracle invokes it as a call. PLSQL_BLOCK jobs
          // already carry an executable statement / anonymous block.
          const action = j.jobType === 'STORED_PROCEDURE'
            ? `BEGIN ${j.jobAction.replace(/;\s*$/, '')}; END;`
            : j.jobAction;
          const result = this.db.executeSql(executor, action);
          output = result.message ?? '';
          // PL/SQL / SQL errors surface in the result message (ORA-/PLS-),
          // not as thrown exceptions, so the slave must inspect it: a job
          // whose action raised an error is FAILED, not SUCCEEDED.
          const oraErr = /\b(?:ORA|PLS)-(\d{4,5})\b/.exec(output);
          if (oraErr) {
            status = 'FAILED';
            errorCode = parseInt(oraErr[1], 10);
            errorMessage = output;
          }
        } finally {
          const sid = (executor as unknown as { _sessionId?: string })._sessionId;
          if (sid) this.db.disconnect(parseInt(sid, 10));
        }
      }
    } catch (e: unknown) {
      status = 'FAILED';
      errorMessage = e instanceof Error ? e.message : String(e);
      const m = errorMessage.match(/ORA-(\d+)/);
      errorCode = m ? parseInt(m[1], 10) : 600;
    }
    const endedAt = new Date();
    j.recordEnd(endedAt, status === 'SUCCEEDED');
    const run = new SchedulerJobRun({
      runId: this.nextRunId++, owner: j.owner, jobName: j.jobName,
      status, startedAt, endedAt, errorCode, errorMessage, output,
    });
    this.runs.push(run);
    if (this.runs.length > this.maxRunHistory) this.runs.splice(0, this.runs.length - this.maxRunHistory);
    this.db.instance.getBus().publish({
      topic: 'oracle.scheduler.job-run' as never,
      payload: {
        deviceId: this.db.instance.getDeviceId(),
        sid: this.db.instance.config.sid,
        owner: j.owner, jobName: j.jobName, runId: run.runId,
        status, durationMs: run.durationMs, timestamp: endedAt,
      } as never,
    });
    void useCurrentSession;
    return run;
  }

  sweep(now: Date = new Date()): number {
    let executed = 0;
    for (const j of this.jobs.values()) {
      if (!j.enabled) continue;
      if (j.state === 'RUNNING' || j.state === 'BROKEN') continue;
      if (!j.nextRunDate) continue;
      if (j.nextRunDate.getTime() > now.getTime()) continue;
      if (j.endDate && j.endDate.getTime() < now.getTime()) continue;
      if (j.maxRuns && j.runCount >= j.maxRuns) continue;
      this.runJob(j.owner, j.jobName);
      executed++;
    }
    return executed;
  }

  getJob(owner: string, jobName: string): SchedulerJob | undefined { return this.lookup(owner, jobName); }
  getAllJobs(): readonly SchedulerJob[] { return [...this.jobs.values()]; }
  getAllRuns(): readonly SchedulerJobRun[] { return this.runs; }
  getRunsForJob(owner: string, jobName: string): SchedulerJobRun[] {
    const o = owner.toUpperCase(), j = jobName.toUpperCase();
    return this.runs.filter(r => r.owner === o && r.jobName === j);
  }

  private lookup(owner: string, jobName: string): SchedulerJob | undefined {
    return this.jobs.get(`${owner.toUpperCase()}.${jobName.toUpperCase()}`);
  }
}
