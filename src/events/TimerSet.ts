/**
 * TimerSet — small helper that owns a collection of scheduler timers
 * and guarantees that each `clear()` lands on the same scheduler that
 * scheduled the timer, even if the engine swaps schedulers between
 * allocation and cancellation.
 *
 * Used by every protocol engine (OSPF, RIP, DHCP, IPSec, NAT, …) that
 * was migrated away from native `setTimeout/setInterval` in Phase 4 of
 * the reactive refactor.
 *
 * Usage:
 * ```ts
 * const timers = new TimerSet(() => this.getScheduler());
 * const handle = timers.setTimeout(() => doStuff(), 1000);
 * // …later…
 * timers.clear(handle);          // uses the *original* scheduler
 * timers.clearAll();             // disposes everything
 * ```
 */

import type { IScheduler, TimerHandle } from './Scheduler';

interface OwnedTimer {
  scheduler: IScheduler;
  handle: TimerHandle;
}

export class TimerSet {
  private readonly entries = new Map<symbol, OwnedTimer>();

  constructor(private readonly schedulerProvider: () => IScheduler) {}

  /** Schedule a one-shot timer; returns a handle scoped to this set. */
  setTimeout(fn: () => void, delayMs: number): symbol {
    const scheduler = this.schedulerProvider();
    const token = Symbol('timer');
    const handle = scheduler.setTimeout(() => {
      this.entries.delete(token);
      fn();
    }, delayMs);
    this.entries.set(token, { scheduler, handle });
    return token;
  }

  /** Schedule a recurring timer; returns a handle scoped to this set. */
  setInterval(fn: () => void, periodMs: number): symbol {
    const scheduler = this.schedulerProvider();
    const token = Symbol('interval');
    const handle = scheduler.setInterval(fn, periodMs);
    this.entries.set(token, { scheduler, handle });
    return token;
  }

  /** Cancel a single timer using the scheduler that scheduled it. */
  clear(token: symbol | null | undefined): void {
    if (!token) return;
    const owned = this.entries.get(token);
    if (!owned) return;
    owned.scheduler.clear(owned.handle);
    this.entries.delete(token);
  }

  /** Cancel every timer this set owns. */
  clearAll(): void {
    for (const owned of this.entries.values()) {
      owned.scheduler.clear(owned.handle);
    }
    this.entries.clear();
  }

  /** Number of currently-pending timers (test convenience). */
  size(): number {
    return this.entries.size;
  }
}
