import { DependencyGraph, unitName } from '@/network/devices/linux/systemd/DependencyGraph';
import { orderUnits } from '@/network/devices/linux/systemd/UnitOrdering';
import type { Job, JobEngineHooks, JobResult, OperationResult } from '@/network/devices/linux/systemd/JobTypes';

export interface Transaction {
  readonly jobs: readonly Job[];
  readonly conflicts: readonly string[];
  readonly requiredDeps: ReadonlyMap<string, readonly string[]>;
  readonly error?: string;
}

const EMPTY_TRANSACTION_MAPS = {
  conflicts: [] as string[],
  requiredDeps: new Map<string, readonly string[]>(),
};

export class SystemdJobEngine {
  constructor(private readonly hooks: JobEngineHooks) {}

  buildStartTransaction(unit: string): Transaction {
    const graph = this.hooks.graph();
    const closure = [...graph.activationClosure(unit)].filter((u) => this.hooks.exists(u));
    const { order, cycle } = orderUnits(closure, graph);
    if (cycle) {
      return {
        jobs: [], ...EMPTY_TRANSACTION_MAPS,
        error: `ordering cycle detected: ${cycle.join(' → ')}`,
      };
    }

    const inClosure = new Set(closure);
    const requiredDeps = new Map<string, readonly string[]>();
    for (const u of order) {
      const deps = [...graph.edges(u, 'requires'), ...graph.edges(u, 'bindsTo')]
        .filter((d) => inClosure.has(d));
      requiredDeps.set(u, deps);
    }

    const jobs: Job[] = order.map((u) => ({ unit: u, type: 'start', required: true }));
    return { jobs, conflicts: this.collectConflicts(closure, graph), requiredDeps };
  }

  start(unit: string): OperationResult {
    const transaction = this.buildStartTransaction(unit);
    if (transaction.error) return { ok: false, error: transaction.error };
    const results = this.run(transaction);
    const target = unitName(unit);
    const targetResult = results.find((r) => r.unit === target);
    if (targetResult && targetResult.outcome !== 'done' && targetResult.outcome !== 'skipped') {
      return { ok: false, error: targetResult.error ?? `failed to start ${target}` };
    }
    return { ok: true };
  }

  run(transaction: Transaction): JobResult[] {
    for (const conflict of transaction.conflicts) {
      if (this.hooks.isActive(conflict)) this.hooks.deactivate(conflict);
    }

    const results = new Map<string, JobResult>();
    for (const job of transaction.jobs) {
      const failedDep = (transaction.requiredDeps.get(job.unit) ?? [])
        .find((d) => results.get(d)?.outcome === 'failed' || results.get(d)?.outcome === 'dependency-failed');
      if (failedDep) {
        results.set(job.unit, { unit: job.unit, outcome: 'dependency-failed', error: `required dependency ${failedDep} failed` });
        continue;
      }
      if (this.hooks.isActive(job.unit)) {
        results.set(job.unit, { unit: job.unit, outcome: 'skipped' });
        continue;
      }
      const outcome = this.hooks.activate(job.unit);
      results.set(job.unit, outcome.ok
        ? { unit: job.unit, outcome: 'done' }
        : { unit: job.unit, outcome: 'failed', error: outcome.error });
    }
    return [...results.values()];
  }

  private collectConflicts(closure: readonly string[], graph: DependencyGraph): string[] {
    const inClosure = new Set(closure);
    const conflicts = new Set<string>();
    for (const u of closure) {
      for (const target of graph.edges(u, 'conflicts')) {
        if (!inClosure.has(target)) conflicts.add(target);
      }
    }
    for (const other of graph.allUnits()) {
      if (inClosure.has(other)) continue;
      for (const u of graph.edges(other, 'conflicts')) {
        if (inClosure.has(u)) conflicts.add(other);
      }
    }
    return [...conflicts].sort();
  }
}
