export interface TimerSpec {
  unit: string;
  activates: string;
  onActiveSec?: number;
  onBootSec?: number;
  onUnitActiveSec?: number;
  onCalendar?: string;
}

export interface TimerEntry {
  unit: string;
  activates: string;
  next: Date | null;
  last: Date | null;
}

interface ArmedTimer {
  spec: TimerSpec;
  next: Date | null;
  last: Date | null;
}

export class TimerScheduler {
  private readonly armed = new Map<string, ArmedTimer>();

  arm(spec: TimerSpec, now: Date): void {
    this.armed.set(spec.unit, { spec, next: this.initialElapse(spec, now), last: null });
  }

  disarm(unit: string): void {
    this.armed.delete(unit);
  }

  isArmed(unit: string): boolean {
    return this.armed.has(unit);
  }

  due(now: Date): string[] {
    const fired: string[] = [];
    for (const timer of this.armed.values()) {
      if (timer.next === null || now.getTime() < timer.next.getTime()) continue;
      fired.push(timer.spec.activates);
      timer.last = timer.next;
      timer.next = this.nextElapse(timer.spec, timer.next);
    }
    return fired;
  }

  entries(): TimerEntry[] {
    return [...this.armed.values()]
      .map((t) => ({ unit: t.spec.unit, activates: t.spec.activates, next: t.next, last: t.last }))
      .sort((a, b) => a.unit.localeCompare(b.unit));
  }

  private initialElapse(spec: TimerSpec, now: Date): Date | null {
    const candidates: number[] = [];
    const span = spec.onActiveSec ?? spec.onBootSec ?? spec.onUnitActiveSec;
    if (span !== undefined) candidates.push(now.getTime() + span * 1000);
    const calendar = nextCalendarElapse(spec.onCalendar, now);
    if (calendar !== null) candidates.push(calendar.getTime());
    return candidates.length > 0 ? new Date(Math.min(...candidates)) : null;
  }

  private nextElapse(spec: TimerSpec, firedAt: Date): Date | null {
    const candidates: number[] = [];
    if (spec.onUnitActiveSec !== undefined) {
      candidates.push(firedAt.getTime() + spec.onUnitActiveSec * 1000);
    }
    const calendar = nextCalendarElapse(spec.onCalendar, firedAt);
    if (calendar !== null) candidates.push(calendar.getTime());
    return candidates.length > 0 ? new Date(Math.min(...candidates)) : null;
  }
}

function nextCalendarElapse(expression: string | undefined, after: Date): Date | null {
  if (!expression) return null;
  const next = new Date(after);
  switch (expression) {
    case 'minutely':
      next.setSeconds(0, 0);
      next.setMinutes(next.getMinutes() + 1);
      return next;
    case 'hourly':
      next.setMinutes(0, 0, 0);
      next.setHours(next.getHours() + 1);
      return next;
    case 'daily':
      next.setHours(0, 0, 0, 0);
      next.setDate(next.getDate() + 1);
      return next;
    default:
      return null;
  }
}
