import { OwnedScheduler, RealTimeScheduler, VirtualTimeScheduler, getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { PathClock } from './time/PathClock';

export class SystemClock {
  private overrideMs: number | null = null;
  private setAtMs = 0;
  private skewMs = 0;

  constructor(private readonly source: () => number = simulationNowMs) {}

  now(): number {
    if (this.overrideMs === null) return this.source() + this.skewMs;
    return this.overrideMs + (this.source() - this.setAtMs);
  }

  set(epochMs: number): void {
    this.overrideMs = epochMs;
    this.setAtMs = this.source();
    this.skewMs = 0;
  }

  step(deltaMs: number): void {
    if (this.overrideMs === null) this.skewMs += deltaMs;
    else this.overrideMs += deltaMs;
  }

  isSetManually(): boolean { return this.overrideMs !== null; }

  release(): void {
    this.overrideMs = null;
    this.skewMs = 0;
  }
}

function unwrapped(scheduler: IScheduler): IScheduler {
  let current = scheduler;
  while (current instanceof OwnedScheduler) current = current.underlying();
  return current;
}

function readingOf(scheduler: IScheduler): number {
  return scheduler instanceof RealTimeScheduler ? Date.now() : scheduler.now();
}

function epochOf(scheduler: IScheduler): number {
  const pinned = scheduler instanceof VirtualTimeScheduler ? scheduler.epochOrigin() : null;
  return pinned === null ? Date.now() : pinned + scheduler.now();
}

export function schedulerWallClock(
  scheduler: () => IScheduler = getDefaultScheduler,
): () => number {
  let followed = unwrapped(scheduler());
  let epochAtOrigin = epochOf(followed);
  let origin = readingOf(followed);
  let lastReading = origin;
  return () => {
    const current = unwrapped(scheduler());
    if (current !== followed) {
      epochAtOrigin += Math.max(lastReading, readingOf(followed)) - origin;
      followed = current;
      origin = readingOf(current);
      lastReading = origin;
    }
    const reading = readingOf(current);
    if (reading < lastReading) {
      epochAtOrigin += lastReading - origin;
      origin = reading;
    }
    lastReading = reading;
    return epochAtOrigin + (reading - origin) + PathClock.horizon();
  };
}

const virtualOrigins = new WeakMap<IScheduler, number>();

function virtualOriginOf(scheduler: IScheduler): number {
  const pinned = scheduler instanceof VirtualTimeScheduler ? scheduler.epochOrigin() : null;
  if (pinned !== null) return pinned;
  let origin = virtualOrigins.get(scheduler);
  if (origin === undefined) {
    origin = Date.now() - scheduler.now();
    virtualOrigins.set(scheduler, origin);
  }
  return origin;
}

export function simulationNowMs(): number {
  const scheduler = unwrapped(getDefaultScheduler());
  const base = scheduler instanceof RealTimeScheduler
    ? Date.now()
    : virtualOriginOf(scheduler) + scheduler.now();
  return Math.floor(base + PathClock.horizon());
}

export function simulationDate(): Date {
  return new Date(simulationNowMs());
}
