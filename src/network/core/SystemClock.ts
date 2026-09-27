import { OwnedScheduler, getDefaultScheduler, type IScheduler } from '@/events/Scheduler';

export class SystemClock {
  private overrideMs: number | null = null;
  private setAtMs = 0;

  constructor(private readonly source: () => number = () => Date.now()) {}

  now(): number {
    if (this.overrideMs === null) return this.source();
    return this.overrideMs + (this.source() - this.setAtMs);
  }

  set(epochMs: number): void {
    this.overrideMs = epochMs;
    this.setAtMs = this.source();
  }

  isSetManually(): boolean { return this.overrideMs !== null; }

  release(): void { this.overrideMs = null; }
}

function unwrapped(scheduler: IScheduler): IScheduler {
  let current = scheduler;
  while (current instanceof OwnedScheduler) current = current.underlying();
  return current;
}

export function schedulerWallClock(
  scheduler: () => IScheduler = getDefaultScheduler,
): () => number {
  let followed = unwrapped(scheduler());
  let epochAtOrigin = Date.now();
  let origin = followed.now();
  let lastReading = origin;
  return () => {
    const current = unwrapped(scheduler());
    if (current !== followed) {
      epochAtOrigin += Math.max(lastReading, followed.now()) - origin;
      followed = current;
      origin = current.now();
      lastReading = origin;
    }
    const reading = current.now();
    if (reading < lastReading) {
      epochAtOrigin += lastReading - origin;
      origin = reading;
    }
    lastReading = reading;
    return epochAtOrigin + (reading - origin);
  };
}
