import { builtinPackageRegistry, type IPackageRoutine, type PackageCallContext } from './PackageRegistry';
import type { SchedulerManager } from '../scheduler/SchedulerManager';

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
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = mgr(ctx); if (!m) return null;
    const { owner, jobName } = parseOwnerJob(args[0] ?? '', ctx);
    const jobType = (args[1] ?? 'PLSQL_BLOCK').toUpperCase() as 'PLSQL_BLOCK';
    const jobAction = args[2] ?? '';
    const startDate = args[3] ? new Date(args[3]) : null;
    const repeatInterval = args[4] ?? null;
    const endDate = args[5] ? new Date(args[5]) : null;
    const enabled = args[6] === 'TRUE' || args[6] === 'true';
    const comments = args[7] ?? '';
    m.createJob({ owner, jobName, jobType, jobAction, startDate, repeatInterval, endDate, enabled, comments });
    return `Job ${owner}.${jobName} created`;
  }
}

class DropJob implements IPackageRoutine {
  readonly fullName = 'DBMS_SCHEDULER.DROP_JOB';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = mgr(ctx); if (!m) return null;
    const { owner, jobName } = parseOwnerJob(args[0] ?? '', ctx);
    return m.dropJob(owner, jobName) ? `Job ${owner}.${jobName} dropped` : null;
  }
}

class EnableJob implements IPackageRoutine {
  readonly fullName = 'DBMS_SCHEDULER.ENABLE';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = mgr(ctx); if (!m) return null;
    const { owner, jobName } = parseOwnerJob(args[0] ?? '', ctx);
    return m.enableJob(owner, jobName) ? null : null;
  }
}

class DisableJob implements IPackageRoutine {
  readonly fullName = 'DBMS_SCHEDULER.DISABLE';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = mgr(ctx); if (!m) return null;
    const { owner, jobName } = parseOwnerJob(args[0] ?? '', ctx);
    m.disableJob(owner, jobName);
    return null;
  }
}

class RunJob implements IPackageRoutine {
  readonly fullName = 'DBMS_SCHEDULER.RUN_JOB';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const m = mgr(ctx); if (!m) return null;
    const { owner, jobName } = parseOwnerJob(args[0] ?? '', ctx);
    const run = m.runJob(owner, jobName, true);
    return run ? `Job run #${run.runId}: ${run.status} in ${run.durationMs}ms` : null;
  }
}

class SetAttribute implements IPackageRoutine {
  readonly fullName = 'DBMS_SCHEDULER.SET_ATTRIBUTE';
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
