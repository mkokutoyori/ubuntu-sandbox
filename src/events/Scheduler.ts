/**
 * Scheduler abstraction.
 *
 * See `docs/REFONTE-REACTIVE-EVENT-DRIVEN.md` §8.3.
 *
 * Two implementations:
 *  - `RealTimeScheduler`: delegates to `globalThis.setTimeout/setInterval`
 *    and uses `performance.now()` for monotonic time.
 *  - `VirtualTimeScheduler`: deterministic, advanced manually via
 *    `advance(ms)`. Used by tests (replaces `vi.useFakeTimers`) and by the
 *    runtime pause/play/×N controls envisioned in the refactor.
 *
 * The `delay(ms)` helper returns a Promise that resolves once the virtual
 * (or real) clock has advanced by the requested amount — this is the
 * critical piece that `vi.useFakeTimers` does not provide for
 * `await`-based protocol logic.
 */

export type TimerHandle = number;

export interface IScheduler {
  /** Returns current time in milliseconds (real or virtual). */
  now(): number;

  setTimeout(fn: () => void, delayMs: number): TimerHandle;
  setInterval(fn: () => void, periodMs: number): TimerHandle;
  clear(handle: TimerHandle): void;

  /** Promise wrapper around setTimeout. */
  delay(ms: number): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────────
// Real-time scheduler (production)
// ──────────────────────────────────────────────────────────────────────────

export class RealTimeScheduler implements IScheduler {
  private nextHandle = 1;
  private readonly handles = new Map<TimerHandle, { kind: 'timeout' | 'interval'; native: ReturnType<typeof setTimeout> }>();

  now(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  setTimeout(fn: () => void, delayMs: number): TimerHandle {
    const handle = this.nextHandle++;
    const native = globalThis.setTimeout(() => {
      this.handles.delete(handle);
      try {
        fn();
      } catch (e) {
        console.error('[RealTimeScheduler] timeout callback threw:', e);
      }
    }, delayMs);
    this.handles.set(handle, { kind: 'timeout', native });
    return handle;
  }

  setInterval(fn: () => void, periodMs: number): TimerHandle {
    const handle = this.nextHandle++;
    const native = globalThis.setInterval(() => {
      try {
        fn();
      } catch (e) {
        console.error('[RealTimeScheduler] interval callback threw:', e);
      }
    }, periodMs);
    this.handles.set(handle, { kind: 'interval', native });
    return handle;
  }

  clear(handle: TimerHandle): void {
    const entry = this.handles.get(handle);
    if (!entry) return;
    if (entry.kind === 'timeout') {
      globalThis.clearTimeout(entry.native as ReturnType<typeof setTimeout>);
    } else {
      globalThis.clearInterval(entry.native as ReturnType<typeof setInterval>);
    }
    this.handles.delete(handle);
  }

  delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimeout(resolve, ms));
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Virtual-time scheduler (tests + runtime time-control)
// ──────────────────────────────────────────────────────────────────────────

interface VirtualTask {
  handle: TimerHandle;
  /** Absolute virtual time at which the task is due. */
  due: number;
  /** Period in ms for intervals; undefined for timeouts. */
  period?: number;
  fn: () => void;
  /** Insertion order to break ties deterministically. */
  seq: number;
  cancelled: boolean;
}

export class VirtualTimeScheduler implements IScheduler {
  private currentTime = 0;
  private nextHandle = 1;
  private nextSeq = 1;
  private readonly tasks: VirtualTask[] = [];

  now(): number {
    return this.currentTime;
  }

  setTimeout(fn: () => void, delayMs: number): TimerHandle {
    const handle = this.nextHandle++;
    this.tasks.push({
      handle,
      due: this.currentTime + Math.max(0, delayMs),
      fn,
      seq: this.nextSeq++,
      cancelled: false,
    });
    return handle;
  }

  setInterval(fn: () => void, periodMs: number): TimerHandle {
    const handle = this.nextHandle++;
    const period = Math.max(1, periodMs);
    this.tasks.push({
      handle,
      due: this.currentTime + period,
      period,
      fn,
      seq: this.nextSeq++,
      cancelled: false,
    });
    return handle;
  }

  clear(handle: TimerHandle): void {
    for (const t of this.tasks) {
      if (t.handle === handle) t.cancelled = true;
    }
  }

  delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimeout(resolve, ms));
  }

  /**
   * Milliseconds until the earliest pending task, or null when none is
   * armed. A driver that steps by a fixed amount cannot measure a wait
   * shorter than its own step, so the virtual clock ends up reporting the
   * driver's cadence rather than the code's; advancing by exactly this
   * makes the clock read the delays that were actually requested.
   */
  msUntilNextTask(): number | null {
    let soonest: number | null = null;
    for (const t of this.tasks) {
      if (t.cancelled) continue;
      const due = Math.max(0, t.due - this.currentTime);
      if (soonest === null || due < soonest) soonest = due;
    }
    return soonest;
  }

  /**
   * Run `work` to completion, advancing to each next due task as the code
   * asks for it. Under a virtual clock nothing moves unless it is advanced,
   * so awaiting a call that sleeps inside — `ping` between two echoes, say
   * — otherwise deadlocks until the caller's own timeout. This is the
   * fast-forward the ×N control needs anyway, so it lives here rather than
   * being copied into every test that hits the problem.
   *
   * Microtasks are drained before each step because the code under way arms
   * its next timer in a continuation; advancing first would step past a
   * task not yet scheduled. The turn budget bounds a promise that never
   * settles — a failing test beats a hanging run.
   */
  async advanceUntilSettled<T>(work: Promise<T>, maxTurns = 10_000): Promise<T> {
    let settled = false;
    const tracked = work.then(
      (v) => { settled = true; return v; },
      (e) => { settled = true; throw e; },
    );
    for (let turn = 0; turn < maxTurns && !settled; turn++) {
      await Promise.resolve();
      await Promise.resolve();
      if (settled) break;
      const due = this.msUntilNextTask();
      if (due !== null) this.advance(due);
    }
    return tracked;
  }

  /**
   * Advance the virtual clock by `ms` and run every task whose due time
   * falls within the window. Tasks scheduled by other tasks during the
   * advance are processed in chronological order within the same window.
   */
  advance(ms: number): void {
    if (ms < 0) throw new Error('VirtualTimeScheduler.advance: ms must be ≥ 0');
    const target = this.currentTime + ms;

    // Loop because tasks may schedule new ones during execution.
    while (true) {
      const due = this.pickNextDue(target);
      if (!due) break;

      this.currentTime = due.due;

      // Reschedule intervals before running the body so that any
      // exception in the body does not skip the next tick.
      if (due.period !== undefined) {
        due.due = this.currentTime + due.period;
        due.seq = this.nextSeq++;
      } else {
        this.removeTask(due.handle);
      }

      try {
        due.fn();
      } catch (e) {
        console.error('[VirtualTimeScheduler] task threw:', e);
      }
    }

    this.currentTime = target;
    this.purgeCancelled();
  }

  /**
   * Run every pending task immediately (without advancing time beyond the
   * latest due). Useful for tests that want to flush all microtasks.
   */
  runAll(): void {
    while (true) {
      const next = this.pickNextDue(Number.POSITIVE_INFINITY);
      if (!next) break;
      this.currentTime = next.due;
      if (next.period !== undefined) {
        next.due = this.currentTime + next.period;
      } else {
        this.removeTask(next.handle);
      }
      try {
        next.fn();
      } catch (e) {
        console.error('[VirtualTimeScheduler] task threw:', e);
      }
    }
    this.purgeCancelled();
  }

  /** Drop every pending task and reset the clock. */
  reset(): void {
    this.tasks.length = 0;
    this.currentTime = 0;
    this.nextSeq = 1;
  }

  /** Number of currently-pending tasks (for tests). */
  pendingCount(): number {
    return this.tasks.filter((t) => !t.cancelled).length;
  }

  // ────────────────────────────────────────────────────────────────────────

  private pickNextDue(maxTime: number): VirtualTask | null {
    let best: VirtualTask | null = null;
    for (const t of this.tasks) {
      if (t.cancelled) continue;
      if (t.due > maxTime) continue;
      if (!best || t.due < best.due || (t.due === best.due && t.seq < best.seq)) {
        best = t;
      }
    }
    return best;
  }

  private removeTask(handle: TimerHandle): void {
    const idx = this.tasks.findIndex((t) => t.handle === handle);
    if (idx >= 0) this.tasks.splice(idx, 1);
  }

  private purgeCancelled(): void {
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      if (this.tasks[i].cancelled) this.tasks.splice(i, 1);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Default singleton fallback.
// ──────────────────────────────────────────────────────────────────────────

let defaultSchedulerInstance: IScheduler | null = null;
let defaultSchedulerGeneration = 0;

export class OwnedScheduler implements IScheduler {
  private readonly owned = new Map<TimerHandle, { scheduler: IScheduler; handle: TimerHandle }>();
  private nextToken = 1;

  constructor(private readonly resolve: () => IScheduler) {}

  now(): number {
    return this.resolve().now();
  }

  setTimeout(fn: () => void, delayMs: number): TimerHandle {
    const scheduler = this.resolve();
    const token = this.nextToken++;
    const handle = scheduler.setTimeout(() => {
      this.owned.delete(token);
      fn();
    }, delayMs);
    this.owned.set(token, { scheduler, handle });
    return token;
  }

  setInterval(fn: () => void, periodMs: number): TimerHandle {
    const scheduler = this.resolve();
    const token = this.nextToken++;
    this.owned.set(token, { scheduler, handle: scheduler.setInterval(fn, periodMs) });
    return token;
  }

  clear(token: TimerHandle): void {
    const entry = this.owned.get(token);
    if (!entry) return;
    entry.scheduler.clear(entry.handle);
    this.owned.delete(token);
  }

  delay(ms: number): Promise<void> {
    return new Promise((resolve) => this.setTimeout(resolve, ms));
  }

  clearAll(): void {
    for (const entry of this.owned.values()) entry.scheduler.clear(entry.handle);
    this.owned.clear();
  }

  pendingCount(): number {
    return this.owned.size;
  }
}

export function getDefaultScheduler(): IScheduler {
  if (!defaultSchedulerInstance) {
    defaultSchedulerInstance = new RealTimeScheduler();
  }
  return defaultSchedulerInstance;
}

export function defaultSchedulerGeneration_(): number {
  return defaultSchedulerGeneration;
}

export function __setDefaultScheduler(scheduler: IScheduler | null): void {
  defaultSchedulerInstance = scheduler;
  defaultSchedulerGeneration++;
}
