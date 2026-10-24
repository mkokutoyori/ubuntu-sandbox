import type { Sleep } from './Execution';
import type { QueueSettings } from './Settings';

export interface QueueHost {
  schedule(callback: () => void, delayMs: number): () => void;
  localHour(): number;
  nowMs(): number;
  report(text: string): void;
  endBatch?(): Generator<Sleep, void> | undefined;
}

const REQUEUE_PACE_MS = 1000;

export type ProcessOutcome = 'done' | 'requeue' | { readonly retryAfterMs: number };

export interface QueueStatistics {
  size: number;
  enqueued: number;
  full: number;
  discardedFull: number;
  discardedNearlyFull: number;
  maxSize: number;
}

export class WorkerQueue<T extends { readonly severity: number }> {
  private items: T[] = [];
  private dequeued: T[] = [];
  private requeued: T[] = [];
  private running = false;
  private cancelTimer: (() => void) | null = null;
  private stopped = false;
  readonly statistics: QueueStatistics = { size: 0, enqueued: 0, full: 0, discardedFull: 0, discardedNearlyFull: 0, maxSize: 0 };

  constructor(
    readonly name: string,
    readonly settings: QueueSettings,
    private readonly host: QueueHost,
    private readonly process: (item: T) => Generator<Sleep, ProcessOutcome>,
  ) {}

  get length(): number {
    return this.items.length;
  }

  get isBlocked(): boolean {
    return this.cancelTimer !== null;
  }

  pending(): readonly T[] {
    return [...this.dequeued, ...this.requeued, ...this.items];
  }

  enqueue(item: T): boolean {
    const settings = this.settings;
    if (this.stopped) return false;
    const discardMark = settings.discardMark ?? Math.floor(settings.size * 0.98);
    if (this.items.length >= discardMark && item.severity >= settings.discardSeverity) {
      this.statistics.discardedNearlyFull++;
      return false;
    }
    if (this.items.length >= settings.size) {
      this.statistics.full++;
      this.statistics.discardedFull++;
      this.host.report(`queue '${this.name}': queue full - ${this.items.length} messages in queue, message discarded`);
      return false;
    }
    this.items.push(item);
    this.statistics.enqueued++;
    this.statistics.size = this.items.length;
    this.statistics.maxSize = Math.max(this.statistics.maxSize, this.items.length);
    this.drain();
    return true;
  }

  private withinDequeueWindow(): number {
    const { dequeueTimeBegin: begin, dequeueTimeEnd: end } = this.settings;
    if (begin === 0 && end === 25) return 0;
    const hour = this.host.localHour();
    const inside = begin <= end ? hour >= begin && hour < end : hour >= begin || hour < end;
    if (inside) return 0;
    const hoursUntil = (begin - hour + 24) % 24;
    return hoursUntil * 3_600_000;
  }

  private wake(delayMs: number): void {
    this.cancelTimer?.();
    this.cancelTimer = this.host.schedule(() => {
      this.cancelTimer = null;
      this.running = false;
      this.drain();
    }, delayMs);
  }

  private current: Generator<Sleep, ProcessOutcome> | null = null;
  private committing: Generator<Sleep, void> | null = null;
  private deferredSleep: Sleep | null = null;

  private endBatch(): Sleep | null {
    if (this.committing === null) {
      const started = this.host.endBatch?.();
      if (started === undefined) return this.releaseBatch();
      this.committing = started;
    }
    const step = this.committing.next();
    if (step.done === true) {
      this.committing = null;
      return this.releaseBatch();
    }
    return step.value;
  }

  private releaseBatch(): Sleep | null {
    this.dequeued = [];
    if (this.requeued.length === 0) return null;
    for (const item of this.requeued) {
      this.items.push(item);
      this.statistics.enqueued++;
    }
    this.requeued = [];
    this.statistics.size = this.items.length;
    return { sleepMs: REQUEUE_PACE_MS };
  }

  private pauseFor(sleep: Sleep): void {
    this.running = false;
    this.wake(sleep.sleepMs);
  }

  drain(): void {
    if (this.running || this.cancelTimer !== null || this.stopped) return;
    this.running = true;
    let batched = 0;
    for (;;) {
      if (this.committing !== null) {
        const pause = this.endBatch();
        if (pause !== null) {
          this.pauseFor(pause);
          return;
        }
      }
      if (this.deferredSleep !== null) {
        const sleep = this.deferredSleep;
        this.deferredSleep = null;
        this.pauseFor(sleep);
        return;
      }
      if (this.current === null) {
        if (this.items.length === 0) break;
        const waitForWindow = this.withinDequeueWindow();
        if (waitForWindow > 0) {
          this.running = false;
          this.wake(waitForWindow);
          return;
        }
        this.current = this.process(this.items[0]);
      }
      const step = this.current.next();
      if (step.done !== true) {
        const sleep = step.value;
        this.deferredSleep = sleep;
        const pause = this.endBatch();
        if (pause === null) this.deferredSleep = null;
        this.pauseFor(pause ?? sleep);
        return;
      }
      this.current = null;
      const outcome = step.value;
      if (outcome === 'done' || outcome === 'requeue') {
        (outcome === 'done' ? this.dequeued : this.requeued).push(this.items.shift() as T);
        this.statistics.size = this.items.length;
        batched++;
        const batchEnded = this.items.length === 0 || batched >= this.settings.dequeueBatchSize;
        if (batchEnded) {
          batched = 0;
          const pause = this.endBatch();
          if (pause !== null) {
            this.pauseFor(pause);
            return;
          }
        }
        if (this.settings.dequeueSlowdown > 0 && batchEnded) {
          this.running = false;
          this.wake(Math.max(1, Math.ceil(this.settings.dequeueSlowdown / 1000)));
          return;
        }
      } else {
        const pause = this.endBatch();
        if (pause !== null) {
          this.pauseFor(pause);
          return;
        }
        this.running = false;
        this.wake(Math.max(1, outcome.retryAfterMs));
        return;
      }
    }
    this.running = false;
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
  }

  discardAll(): void {
    this.items = [];
    this.dequeued = [];
    this.requeued = [];
    this.current = null;
    this.statistics.size = 0;
  }
}
