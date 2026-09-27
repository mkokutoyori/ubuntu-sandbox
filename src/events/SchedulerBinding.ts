import { OwnedScheduler, type IScheduler } from './Scheduler';

function clockOf(scheduler: IScheduler): IScheduler {
  return scheduler instanceof OwnedScheduler ? clockOf(scheduler.underlying()) : scheduler;
}

export class SchedulerBinding {
  private bound: IScheduler;

  constructor(
    private readonly current: () => IScheduler,
    private readonly onRebind: (shiftMs: number) => void,
  ) {
    this.bound = clockOf(current());
  }

  now(): number {
    return this.bound.now();
  }

  follow(): void {
    const scheduler = clockOf(this.current());
    if (scheduler === this.bound) return;
    const shiftMs = scheduler.now() - this.bound.now();
    this.bound = scheduler;
    this.onRebind(shiftMs);
  }
}
