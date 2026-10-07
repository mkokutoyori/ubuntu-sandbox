import { builtinPackageRegistry, type IPackageRoutine, type PackageCallContext } from './PackageRegistry';
import type { SchedulerManager } from '../scheduler/SchedulerManager';
import type { JobType } from '../scheduler/SchedulerJob';

const JOB_TYPES: readonly JobType[] = ['PLSQL_BLOCK', 'STORED_PROCEDURE', 'EXECUTABLE'];

/** Normalise the job_type argument to a known DBMS_SCHEDULER job type. */
function coerceJobType(raw: string | undefined): JobType {
  const t = (raw ?? 'PLSQL_BLOCK').toUpperCase();
  return (JOB_TYPES as readonly string[]).includes(t) ? (t as JobType) : 'PLSQL_BLOCK';
}

function mgr(ctx: PackageCallContext): SchedulerManager | null {
  return ctx.services.scheduler ?? null;
}

function parseOwnerJob(jobName: string, ctx: PackageCallContext): { owner: string; jobName: string } {
  const parts = jobName.split('.');
  if (parts.length === 2) return { owner: parts[0].toUpperCase(), jobName: parts[1].toUpperCase() };
  return { owner: ctx.session.currentSchema, jobName: jobName.toUpperCase() };
}

class CreateJob implements IPackageRoutine {
  readonly fullName = 'DBMS_SCHEDULER.CREATE_JOB';
  readonly parameters = ['job_name', 'job_type', 'job_action', 'start_date', 'repeat_interval', 'end_date', 'enabled', 'comments'];
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = mgr(ctx); if (!m) return null;
    const { owner, jobName } = parseOwnerJob(args[0] ?? '', ctx);
    const jobType = coerceJobType(args[1]);
    const jobAction = args[2] ?? '';
    const startDate = m.instantOf(args[3]);
    const repeatInterval = args[4] ?? null;
    const endDate = m.instantOf(args[5]);
    const enabled = args[6] === 'TRUE' || args[6] === 'true';
    const comments = args[7] ?? '';
    m.createJob({ owner, jobName, jobType, jobAction, startDate, repeatInterval, endDate, enabled, comments });
    return `Job ${owner}.${jobName} created`;
  }
}

class DropJob implements IPackageRoutine {
  readonly fullName = 'DBMS_SCHEDULER.DROP_JOB';
  readonly parameters = ['job_name', 'force'];
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = mgr(ctx); if (!m) return null;
    const { owner, jobName } = parseOwnerJob(args[0] ?? '', ctx);
    return m.dropJob(owner, jobName) ? `Job ${owner}.${jobName} dropped` : null;
  }
}

class EnableJob implements IPackageRoutine {
  readonly fullName = 'DBMS_SCHEDULER.ENABLE';
  readonly parameters = ['name'];
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = mgr(ctx); if (!m) return null;
    const { owner, jobName } = parseOwnerJob(args[0] ?? '', ctx);
    return m.enableJob(owner, jobName) ? null : null;
  }
}

class DisableJob implements IPackageRoutine {
  readonly fullName = 'DBMS_SCHEDULER.DISABLE';
  readonly parameters = ['name', 'force'];
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = mgr(ctx); if (!m) return null;
    const { owner, jobName } = parseOwnerJob(args[0] ?? '', ctx);
    m.disableJob(owner, jobName);
    return null;
  }
}

class RunJob implements IPackageRoutine {
  readonly fullName = 'DBMS_SCHEDULER.RUN_JOB';
  readonly parameters = ['job_name', 'use_current_session'];
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = mgr(ctx); if (!m) return null;
    const { owner, jobName } = parseOwnerJob(args[0] ?? '', ctx);
    const run = m.runJob(owner, jobName, true);
    return run ? `Job run #${run.runId}: ${run.status} in ${run.durationMs}ms` : null;
  }
}

class SetAttribute implements IPackageRoutine {
  readonly fullName = 'DBMS_SCHEDULER.SET_ATTRIBUTE';
  readonly parameters = ['name', 'attribute', 'value'];
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = mgr(ctx); if (!m) return null;
    const { owner, jobName } = parseOwnerJob(args[0] ?? '', ctx);
    m.setAttribute(owner, jobName, args[1] ?? '', args[2] ?? '');
    return null;
  }
}

export class DbmsScheduler {
  static register(): void {
    builtinPackageRegistry.register(new CreateJob());
    builtinPackageRegistry.register(new DropJob());
    builtinPackageRegistry.register(new EnableJob());
    builtinPackageRegistry.register(new DisableJob());
    builtinPackageRegistry.register(new RunJob());
    builtinPackageRegistry.register(new SetAttribute());
  }
}
