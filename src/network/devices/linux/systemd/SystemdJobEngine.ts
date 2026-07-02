import { unitName } from '@/network/devices/linux/systemd/DependencyGraph';
import { orderUnits } from '@/network/devices/linux/systemd/UnitOrdering';
import type { Job, JobEngineHooks, JobResult, OperationResult } from '@/network/devices/linux/systemd/JobTypes';

export interface Transaction {
  readonly jobs: readonly Job[];
  readonly error?: string;
}

export class SystemdJobEngine {
  constructor(private readonly hooks: JobEngineHooks) {}

  buildStartTransaction(unit: string): Transaction {
    const graph = this.hooks.graph();
    const closure = [...graph.activationClosure(unit)].filter((u) => this.hooks.exists(u));
    const { order, cycle } = orderUnits(closure, graph);
    if (cycle) {
      return { jobs: [], error: `ordering cycle detected: ${cycle.join(' → ')}` };
    }
    const jobs: Job[] = order.map((u) => ({ unit: u, type: 'start', required: true }));
    return { jobs };
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
    const results: JobResult[] = [];
    for (const job of transaction.jobs) {
      if (this.hooks.isActive(job.unit)) {
        results.push({ unit: job.unit, outcome: 'skipped' });
        continue;
      }
      const outcome = this.hooks.activate(job.unit);
      results.push(outcome.ok
        ? { unit: job.unit, outcome: 'done' }
        : { unit: job.unit, outcome: 'failed', error: outcome.error });
    }
    return results;
  }
}
