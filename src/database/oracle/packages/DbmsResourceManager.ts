/**
 * DBMS_RESOURCE_MANAGER — Oracle's Resource Manager control package.
 *
 * Implemented routines (signatures match the Oracle 19c PL/SQL
 * Packages and Types reference; bracketed args are optional):
 *
 *   CREATE_PENDING_AREA
 *   SUBMIT_PENDING_AREA
 *   CLEAR_PENDING_AREA
 *   CREATE_CONSUMER_GROUP(consumer_group, comment, cpu_mth)
 *   DELETE_CONSUMER_GROUP(consumer_group)
 *   CREATE_PLAN(plan, comment, cpu_mth)
 *   DELETE_PLAN(plan)
 *   CREATE_PLAN_DIRECTIVE(plan, group_or_subplan, comment,
 *                         mgmt_p1, active_sess_pool, queueing_p1,
 *                         switch_time, switch_group, max_idle_time,
 *                         max_est_exec_time)
 *   DELETE_PLAN_DIRECTIVE(plan, group_or_subplan)
 *
 * Real Oracle requires a "pending area" workflow; the simulator
 * accepts the calls but applies changes immediately (matching the
 * effective behaviour DBAs observe once they SUBMIT_PENDING_AREA).
 */

import { builtinPackageRegistry, type IPackageRoutine, type PackageCallContext } from './PackageRegistry';
import { ConsumerGroup, ResourcePlan, PlanDirective } from '../resource/ResourceManager';
import type { ResourceManager } from '../resource/ResourceManager';

function rm(ctx: PackageCallContext): ResourceManager | null {
  return ctx.services.resourceManager ?? null;
}

class CreateConsumerGroup implements IPackageRoutine {
  readonly fullName = 'DBMS_RESOURCE_MANAGER.CREATE_CONSUMER_GROUP';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const r = rm(ctx); if (!r) return null;
    const [name, comment, cpu] = [args[0] ?? '', args[1] ?? '', (args[2] ?? 'ROUND-ROBIN').toUpperCase()];
    if (!name) return null;
    const cpuMethod = cpu === 'RATIO' ? 'RATIO' : 'EMPHASIS';
    r.createConsumerGroup(new ConsumerGroup(name.toUpperCase(), cpuMethod, comment));
    return `Consumer group ${name.toUpperCase()} created`;
  }
}

class DeleteConsumerGroup implements IPackageRoutine {
  readonly fullName = 'DBMS_RESOURCE_MANAGER.DELETE_CONSUMER_GROUP';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const r = rm(ctx); if (!r) return null;
    return r.dropConsumerGroup(args[0] ?? '') ? `Group ${args[0]} dropped` : null;
  }
}

class CreatePlan implements IPackageRoutine {
  readonly fullName = 'DBMS_RESOURCE_MANAGER.CREATE_PLAN';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const r = rm(ctx); if (!r) return null;
    const [name, comment, cpu] = [args[0] ?? '', args[1] ?? '', (args[2] ?? 'EMPHASIS').toUpperCase()];
    if (!name) return null;
    r.createPlan(new ResourcePlan(name.toUpperCase(), cpu === 'RATIO' ? 'RATIO' : 'EMPHASIS', 'ACTIVE', comment));
    return `Plan ${name.toUpperCase()} created`;
  }
}

class DeletePlan implements IPackageRoutine {
  readonly fullName = 'DBMS_RESOURCE_MANAGER.DELETE_PLAN';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const r = rm(ctx); if (!r) return null;
    return r.dropPlan(args[0] ?? '') ? `Plan ${args[0]} dropped` : null;
  }
}

class CreatePlanDirective implements IPackageRoutine {
  readonly fullName = 'DBMS_RESOURCE_MANAGER.CREATE_PLAN_DIRECTIVE';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const r = rm(ctx); if (!r) return null;
    const [plan, group, comment, mgmtP1, activeSess, queueing, switchT, switchG, maxIdle, maxEst]
      = [args[0] ?? '', args[1] ?? '', args[2] ?? '', args[3], args[4], args[5], args[6], args[7], args[8], args[9]];
    if (!plan || !group) return null;
    r.createPlanDirective(new PlanDirective(
      plan.toUpperCase(), group.toUpperCase(), 'CONSUMER_GROUP',
      mgmtP1 ? parseInt(mgmtP1, 10) : 0,
      activeSess ? parseInt(activeSess, 10) : null,
      queueing ? parseInt(queueing, 10) : null,
      switchT ? parseInt(switchT, 10) : null,
      switchG ? switchG.toUpperCase() : null,
      maxIdle ? parseInt(maxIdle, 10) : null,
      maxEst ? parseInt(maxEst, 10) : null,
      comment,
    ));
    return `Directive ${plan}.${group} created`;
  }
}

class DeletePlanDirective implements IPackageRoutine {
  readonly fullName = 'DBMS_RESOURCE_MANAGER.DELETE_PLAN_DIRECTIVE';
  invoke(args: string[], ctx: PackageCallContext): string | null {
    const r = rm(ctx); if (!r) return null;
    return r.dropPlanDirective(args[0] ?? '', args[1] ?? '') ? 'Directive dropped' : null;
  }
}

class CreatePendingArea implements IPackageRoutine {
  readonly fullName = 'DBMS_RESOURCE_MANAGER.CREATE_PENDING_AREA';
  invoke(): string | null { return null; }
}
class SubmitPendingArea implements IPackageRoutine {
  readonly fullName = 'DBMS_RESOURCE_MANAGER.SUBMIT_PENDING_AREA';
  invoke(): string | null { return null; }
}
class ClearPendingArea implements IPackageRoutine {
  readonly fullName = 'DBMS_RESOURCE_MANAGER.CLEAR_PENDING_AREA';
  invoke(): string | null { return null; }
}

export class DbmsResourceManager {
  static register(): void {
    builtinPackageRegistry.register(new CreateConsumerGroup());
    builtinPackageRegistry.register(new DeleteConsumerGroup());
    builtinPackageRegistry.register(new CreatePlan());
    builtinPackageRegistry.register(new DeletePlan());
    builtinPackageRegistry.register(new CreatePlanDirective());
    builtinPackageRegistry.register(new DeletePlanDirective());
    builtinPackageRegistry.register(new CreatePendingArea());
    builtinPackageRegistry.register(new SubmitPendingArea());
    builtinPackageRegistry.register(new ClearPendingArea());
  }
}
