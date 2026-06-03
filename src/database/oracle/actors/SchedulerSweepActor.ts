/**
 * SchedulerSweepActor — Oracle CJQ0-style background sweeper.
 *
 * Real Oracle runs `cjq0` (Coordinator Job Queue 0) every second, scanning
 * SYS.SCHEDULER$_JOB for any job whose `next_run_date` is in the past
 * and dispatching it to a slave (Jnnn) for execution. The simulator's
 * SchedulerManager already knows how to run a single due job and roll
 * the nextRunDate forward; this actor only owns the periodic tick.
 */

import type { IScheduler, TimerHandle } from '@/events/Scheduler';
import { getDefaultScheduler } from '@/events/Scheduler';
import type { SchedulerManager } from '../scheduler/SchedulerManager';

const DEFAULT_TICK_MS = 1_000;

export class SchedulerSweepActor {
  private handle: TimerHandle | null = null;

  constructor(
    private readonly mgr: SchedulerManager,
    private readonly scheduler: IScheduler = getDefaultScheduler(),
    private readonly tickMs: number = DEFAULT_TICK_MS,
  ) {}

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler.setInterval(() => {
      try { this.mgr.sweep(); } catch { /* swallow per-tick */ }
    }, this.tickMs);
  }

  stop(): void {
    if (this.handle === null) return;
    this.scheduler.clear(this.handle);
    this.handle = null;
  }
}
