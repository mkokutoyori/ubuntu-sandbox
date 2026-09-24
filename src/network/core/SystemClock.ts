import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';

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

export function schedulerWallClock(
  scheduler: () => IScheduler = getDefaultScheduler,
): () => number {
  let followed = scheduler();
  let epochAtOrigin = Date.now();
  let origin = followed.now();
  return () => {
    const current = scheduler();
    if (current !== followed) {
      epochAtOrigin += followed.now() - origin;
      followed = current;
      origin = current.now();
    }
    return epochAtOrigin + (current.now() - origin);
  };
}
