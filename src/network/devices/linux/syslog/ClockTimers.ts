import type { IScheduler, TimerHandle } from '@/events/Scheduler';

interface PendingTimer {
  readonly id: number;
  dueAt: number;
  readonly callback: () => void;
  readonly periodMs: number | null;
  cancelled: boolean;
}

export class ClockTimers {
  private timers: PendingTimer[] = [];
  private nextId = 1;
  private override: number | null = null;
  private armed: { handle: TimerHandle; at: number } | null = null;
  private pumping = false;

  constructor(private readonly wall: () => number, private readonly scheduler: () => IScheduler) {}

  now(): number {
    return this.override ?? this.wall();
  }

  schedule(callback: () => void, delayMs: number): () => void {
    return this.add(callback, delayMs, null);
  }

  scheduleEvery(callback: () => void, periodMs: number): () => void {
    return this.add(callback, periodMs, periodMs);
  }

  private add(callback: () => void, delayMs: number, periodMs: number | null): () => void {
    const timer: PendingTimer = { id: this.nextId++, dueAt: this.now() + Math.max(0, delayMs), callback, periodMs, cancelled: false };
    this.timers.push(timer);
    this.arm();
    return () => {
      timer.cancelled = true;
    };
  }

  pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const horizon = this.wall();
      for (;;) {
        this.timers = this.timers.filter((timer) => !timer.cancelled);
        let due: PendingTimer | undefined;
        for (const timer of this.timers) {
          if (timer.dueAt <= horizon && (due === undefined || timer.dueAt < due.dueAt || (timer.dueAt === due.dueAt && timer.id < due.id))) due = timer;
        }
        if (due === undefined) break;
        this.override = Math.max(due.dueAt, this.override ?? due.dueAt);
        if (due.periodMs === null) due.cancelled = true;
        else due.dueAt += Math.max(1, due.periodMs);
        due.callback();
      }
    } finally {
      this.override = null;
      this.pumping = false;
    }
    this.arm();
  }

  clear(): void {
    for (const timer of this.timers) timer.cancelled = true;
    this.timers = [];
    this.disarm();
  }

  private earliest(): number | null {
    let earliest: number | null = null;
    for (const timer of this.timers) {
      if (!timer.cancelled && (earliest === null || timer.dueAt < earliest)) earliest = timer.dueAt;
    }
    return earliest;
  }

  private disarm(): void {
    if (this.armed !== null) this.scheduler().clear(this.armed.handle);
    this.armed = null;
  }

  private arm(): void {
    const earliest = this.earliest();
    if (earliest === null) {
      this.disarm();
      return;
    }
    if (this.armed !== null && this.armed.at <= earliest) return;
    this.disarm();
    const delay = Math.max(0, earliest - this.wall());
    const handle = this.scheduler().setTimeout(() => {
      this.armed = null;
      this.pump();
    }, delay);
    this.armed = { handle, at: earliest };
  }
}
