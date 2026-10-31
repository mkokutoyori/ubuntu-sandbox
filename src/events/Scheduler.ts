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
  cancelled?: true;
}

function before(a: VirtualTask, b: VirtualTask): boolean {
  return a.due < b.due || (a.due === b.due && a.seq < b.seq);
}

function drainRunnableWork(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof globalThis.setImmediate === 'function') {
      globalThis.setImmediate(resolve);
    } else if (typeof globalThis.MessageChannel === 'function') {
      const channel = new globalThis.MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
      channel.port2.postMessage(null);
    } else {
      globalThis.setTimeout(resolve, 0);
    }
  });
}

export class VirtualTimeScheduler implements IScheduler {
  private currentTime = 0;
  private pinnedEpochOrigin: number | null = null;

  setEpochOrigin(epochMsAtZero: number): void {
    this.pinnedEpochOrigin = epochMsAtZero - this.currentTime;
  }

  epochOrigin(): number | null {
    return this.pinnedEpochOrigin;
  }

  private nextHandle = 1;
  private nextSeq = 1;
  private heap: VirtualTask[] = [];
  private readonly live = new Map<TimerHandle, VirtualTask>();
  private readonly unsettledWork = new Set<Promise<unknown>>();
  private drivingUnsettledWork = false;

  now(): number {
    return this.currentTime;
  }

  setTimeout(fn: () => void, delayMs: number): TimerHandle {
    const handle = this.nextHandle++;
    this.enqueue({
      handle,
      due: this.currentTime + Math.max(0, delayMs),
      fn,
      seq: this.nextSeq++,
    });
    return handle;
  }

  setInterval(fn: () => void, periodMs: number): TimerHandle {
    const handle = this.nextHandle++;
    const period = Math.max(1, periodMs);
    this.enqueue({
      handle,
      due: this.currentTime + period,
      period,
      fn,
      seq: this.nextSeq++,
    });
    return handle;
  }

  clear(handle: TimerHandle): void {
    this.removeTask(handle);
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
    const next = this.peekLive();
    return next === null ? null : Math.max(0, next.due - this.currentTime);
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
    const tracked: Promise<T> = work.finally(() => { this.unsettledWork.delete(tracked); });
    this.unsettledWork.add(tracked);
    if (this.drivingUnsettledWork) return tracked;
    this.drivingUnsettledWork = true;
    try {
      for (let turn = 0; turn < maxTurns && this.unsettledWork.size > 0; turn++) {
        await drainRunnableWork();
        if (this.unsettledWork.size === 0) break;
        const due = this.msUntilNextTask();
        if (due !== null) this.advance(due);
        else await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      }
    } finally {
      this.drivingUnsettledWork = false;
    }
    return tracked;
  }

  async advanceBy(ms: number): Promise<void> {
    if (ms < 0) throw new Error('VirtualTimeScheduler.advanceBy: ms must be ≥ 0');
    const target = this.currentTime + ms;
    while (this.currentTime < target) {
      await drainRunnableWork();
      const due = this.msUntilNextTask();
      const step = due === null ? target - this.currentTime : Math.min(due, target - this.currentTime);
      this.advance(Math.max(step, 0));
    }
    await drainRunnableWork();
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
        this.siftDown(0);
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
  }

  jump(ms: number): void {
    if (ms < 0) throw new Error('VirtualTimeScheduler.jump: ms must be ≥ 0');
    const target = this.currentTime + ms;
    for (const task of this.live.values()) {
      if (task.due < target) task.due = target;
    }
    this.rebuildHeap();
    this.advance(ms);
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
        this.siftDown(0);
      } else {
        this.removeTask(next.handle);
      }
      try {
        next.fn();
      } catch (e) {
        console.error('[VirtualTimeScheduler] task threw:', e);
      }
    }
  }

  /** Drop every pending task and reset the clock. */
  reset(): void {
    this.heap = [];
    this.live.clear();
    this.currentTime = 0;
    this.nextSeq = 1;
  }

  /** Number of currently-pending tasks (for tests). */
  pendingCount(): number {
    return this.live.size;
  }

  // ────────────────────────────────────────────────────────────────────────

  private pickNextDue(maxTime: number): VirtualTask | null {
    const next = this.peekLive();
    return next !== null && next.due <= maxTime ? next : null;
  }

  private removeTask(handle: TimerHandle): void {
    const task = this.live.get(handle);
    if (task === undefined) return;
    task.cancelled = true;
    this.live.delete(handle);
    if (this.heap.length > 2 * this.live.size + 64) this.rebuildHeap();
  }

  private enqueue(task: VirtualTask): void {
    this.live.set(task.handle, task);
    this.heap.push(task);
    this.siftUp(this.heap.length - 1);
  }

  private peekLive(): VirtualTask | null {
    while (this.heap.length > 0 && this.heap[0].cancelled === true) this.popTop();
    return this.heap.length === 0 ? null : this.heap[0];
  }

  private popTop(): void {
    const last = this.heap.pop() as VirtualTask;
    if (this.heap.length === 0) return;
    this.heap[0] = last;
    this.siftDown(0);
  }

  private rebuildHeap(): void {
    this.heap = [...this.live.values()];
    for (let index = (this.heap.length >> 1) - 1; index >= 0; index--) this.siftDown(index);
  }

  private siftUp(start: number): void {
    const heap = this.heap;
    let index = start;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!before(heap[index], heap[parent])) break;
      [heap[index], heap[parent]] = [heap[parent], heap[index]];
      index = parent;
    }
  }

  private siftDown(start: number): void {
    const heap = this.heap;
    const length = heap.length;
    let index = start;
    for (;;) {
      const left = 2 * index + 1;
      const right = left + 1;
      let smallest = index;
      if (left < length && before(heap[left], heap[smallest])) smallest = left;
      if (right < length && before(heap[right], heap[smallest])) smallest = right;
      if (smallest === index) break;
      [heap[index], heap[smallest]] = [heap[smallest], heap[index]];
      index = smallest;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Default singleton fallback.
// ──────────────────────────────────────────────────────────────────────────

let defaultSchedulerInstance: IScheduler | null = null;

export class OwnedScheduler implements IScheduler {
  private readonly owned = new Map<TimerHandle, { scheduler: IScheduler; handle: TimerHandle }>();
  private nextToken = 1;

  constructor(private readonly resolve: () => IScheduler) {}

  underlying(): IScheduler {
    return this.resolve();
  }

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

export function __setDefaultScheduler(scheduler: IScheduler | null): void {
  defaultSchedulerInstance = scheduler;
}
