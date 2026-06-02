/**
 * PlanCache — bounded LRU of ExecutionPlan, keyed by SQL_ID.
 *
 * Feeds V$SQL_PLAN, V$SQL_PLAN_STATISTICS_ALL, and the row underlying
 * DBMS_XPLAN.DISPLAY_CURSOR. Plans are inserted by PlanGenerator on
 * every parse and looked up by their SQL_ID.
 */

import type { ExecutionPlan } from './ExecutionPlan';

export class PlanCache {
  private readonly cache = new Map<string, ExecutionPlan>();
  /** Tracks the last-touched plan so V$SQL.LAST_LOAD_TIME is meaningful. */
  private lastSqlId: string | null = null;

  constructor(private readonly maxEntries: number = 200) {}

  put(plan: ExecutionPlan): void {
    this.cache.delete(plan.sqlId);   // re-insert at end for LRU
    this.cache.set(plan.sqlId, plan);
    this.lastSqlId = plan.sqlId;
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
  }

  get(sqlId: string): ExecutionPlan | undefined { return this.cache.get(sqlId); }
  getLast(): ExecutionPlan | undefined {
    return this.lastSqlId ? this.cache.get(this.lastSqlId) : undefined;
  }
  list(): ExecutionPlan[] { return [...this.cache.values()]; }
  clear(): void { this.cache.clear(); this.lastSqlId = null; }
}
