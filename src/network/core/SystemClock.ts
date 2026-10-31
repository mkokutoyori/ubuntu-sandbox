import { OwnedScheduler, RealTimeScheduler, VirtualTimeScheduler, getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { PathClock } from './time/PathClock';

export class SystemClock {
  private overrideMs: number | null = null;
  private setAtMs = 0;
  private skewMs = 0;
  private readonly stepListeners: Array<(deltaMs: number) => void> = [];

  constructor(private readonly source: () => number = simulationNowMs) {}

  now(): number {
    if (this.overrideMs === null) return this.source() + this.skewMs;
    return this.overrideMs + (this.source() - this.setAtMs);
  }

  onStep(listener: (deltaMs: number) => void): void {
    this.stepListeners.push(listener);
  }

  set(epochMs: number): void {
    const before = this.now();
    this.overrideMs = epochMs;
    this.setAtMs = this.source();
    this.skewMs = 0;
    this.notifyStep(this.now() - before);
  }

  step(deltaMs: number): void {
    if (this.overrideMs === null) this.skewMs += deltaMs;
    else this.overrideMs += deltaMs;
    this.notifyStep(deltaMs);
  }

  isSetManually(): boolean { return this.overrideMs !== null; }

  release(): void {
    const before = this.now();
    this.overrideMs = null;
    this.skewMs = 0;
    this.notifyStep(this.now() - before);
  }

  private notifyStep(deltaMs: number): void {
    if (deltaMs === 0) return;
    for (const listener of this.stepListeners) listener(deltaMs);
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
  return scheduler instanceof VirtualTimeScheduler ? virtualOriginOf(scheduler) + scheduler.now() : Date.now();
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

const MS_PER_UTC_DAY = 86_400_000;

export function millisecondsSinceUtcMidnight(epochMs: number): number {
  return Math.floor(epochMs) % MS_PER_UTC_DAY;
}

export function simulationDate(): Date {
  return new Date(simulationNowMs());
}
