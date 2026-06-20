/**
 * HostClock — a simulated monotonic clock for a host, in milliseconds.
 *
 * Drives time-dependent OS behaviour (background job completion, CPU-time
 * accrual, timers) deterministically: time only moves when something
 * advances it (`advance`), never on its own and never backwards. This lets
 * the simulator model "things running in the background" over time without
 * depending on the wall clock.
 */
export class HostClock {
  private ms: number;

  constructor(epochMs = 0) {
    this.ms = epochMs;
  }

  /** Current simulated time in milliseconds. */
  now(): number {
    return this.ms;
  }

  /** Advance the clock by a positive delta; returns the new time. */
  advance(deltaMs: number): number {
    if (deltaMs > 0) this.ms += deltaMs;
    return this.ms;
  }

  /** Jump the clock forward to `target` if it is in the future. */
  advanceTo(target: number): number {
    if (target > this.ms) this.ms = target;
    return this.ms;
  }

  /** Milliseconds elapsed since a past instant returned by {@link now}. */
  elapsedSince(instant: number): number {
    return Math.max(0, this.ms - instant);
  }

  reset(): void {
    this.ms = 0;
  }
}
