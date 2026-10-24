import type { Sleep } from './Execution';
import type { QueueSettings } from './Settings';
import type { QueuePosition, QueueStore } from './QueueStore';

export interface QueueHost {
  schedule(callback: () => void, delayMs: number): () => void;
  localHour(): number;
  nowMs(): number;
  report(text: string): void;
  endBatch?(): Generator<Sleep, void> | undefined;
}

const REQUEUE_PACE_MS = 1000;
const FLOW_CONTROL_POLL_MS = 1000;

export type ProcessOutcome = 'done' | 'requeue' | { readonly retryAfterMs: number };

export type FlowControl = 'none' | 'light' | 'full';

export interface QueueItem {
  readonly severity: number;
  readonly flowControl?: FlowControl;
  readonly rawMsg?: string;
}

export interface QueueStatistics {
  size: number;
  enqueued: number;
  sizeEnqueued: number;
  full: number;
  discardedFull: number;
  discardedNearlyFull: number;
  maxSize: number;
}

interface LedgerEntry {
  progress: QueuePosition | null;
  finished: boolean;
}

interface Worker<T> {
  batch: T[];
  index: number;
  dequeued: T[];
  requeued: T[];
  current: Generator<Sleep, ProcessOutcome> | null;
  committing: Generator<Sleep, void> | null;
  deferredSleep: Sleep | null;
  running: boolean;
  timer: (() => void) | null;
  wakeDelayMs: number;
  ledger: LedgerEntry | null;
  progress: QueuePosition | null;
  gathering: boolean;
}

interface Delayed<T> {
  readonly item: T;
  readonly mode: 'light' | 'full';
  cancel: (() => void) | null;
}

function newWorker<T>(): Worker<T> {
  return {
    batch: [], index: 0, dequeued: [], requeued: [], current: null, committing: null, deferredSleep: null,
    running: false, timer: null, wakeDelayMs: 0, ledger: null, progress: null, gathering: false,
  };
}

export interface QueueHooks {
  activity?: () => void;
  batchCompleted?: () => void;
  idle?: { readonly timeoutMs: number; check(): boolean };
}

export class WorkerQueue<T extends QueueItem> {
  private items: T[] = [];
  private readonly workers: Worker<T>[] = [];
  private stopped = false;
  private waiting: T[] = [];
  private delayed: Delayed<T>[] = [];
  private ledger: LedgerEntry[] = [];
  private updatesSincePersist = 0;
  private sampled = 0;
  private cancelWaitingDeadline: (() => void) | null = null;
  private spilling = false;
  private enqueueOnly = false;
  private cancelIdle: (() => void) | null = null;
  hooks: QueueHooks = {};
  readonly statistics: QueueStatistics = { size: 0, enqueued: 0, sizeEnqueued: 0, full: 0, discardedFull: 0, discardedNearlyFull: 0, maxSize: 0 };

  constructor(
    readonly name: string,
    readonly settings: QueueSettings,
    private readonly host: QueueHost,
    private readonly process: (item: T) => Generator<Sleep, ProcessOutcome>,
    readonly disk: QueueStore | null = null,
    readonly assist: WorkerQueue<T> | null = null,
  ) {}

  get physicalSize(): number {
    return this.items.length + this.workers.reduce((total, worker) => total + worker.batch.length, 0);
  }

  get length(): number {
    return this.items.length;
  }

  get isBlocked(): boolean {
    return this.workers.some((worker) => worker.timer !== null);
  }

  get midMessage(): boolean {
    return this.workers.some((worker) => worker.current !== null || worker.committing !== null);
  }

  pending(): readonly T[] {
    return [...this.workers.flatMap((worker) => worker.batch), ...this.items];
  }

  enqueue(item: T, flow: FlowControl = 'none'): boolean {
    if (this.stopped) return false;
    this.statistics.enqueued++;
    this.statistics.sizeEnqueued += item.rawMsg?.length ?? 0;
    const effective = this.settings.takeFlowCtlFromMsg ? (item.flowControl ?? 'none') : flow;
    if (this.flowControlDelays(effective)) {
      this.delay(item, effective as 'light' | 'full');
      return true;
    }
    return this.admission(item);
  }

  private admission(item: T): boolean {
    const settings = this.settings;
    const size = this.physicalSize;
    if (settings.discardMark > 0 && size >= settings.discardMark && item.severity >= settings.discardSeverity) {
      this.statistics.discardedNearlyFull++;
      return false;
    }
    if (this.isFull() || this.waiting.length > 0) {
      this.statistics.full++;
      if (settings.timeoutEnqueue === 0) return this.discardFull();
      this.waiting.push(item);
      if (this.waiting.length === 1) this.armWaitingDeadline();
      return true;
    }
    this.add(item);
    return true;
  }

  private isFull(): boolean {
    return (this.settings.size > 0 && this.physicalSize >= this.settings.size) || this.disk?.exceedsDiskSpace() === true;
  }

  private add(item: T): void {
    const settings = this.settings;
    if (settings.samplingInterval > 0) {
      this.sampled = (this.sampled + 1) % settings.samplingInterval;
      if (this.sampled !== 0) return;
    }
    this.items.push(item);
    this.noteSize();
    this.store(item, false);
    this.hooks.activity?.();
    this.disarmIdle();
    this.adviseWorkers();
  }

  private noteSize(): void {
    const size = this.physicalSize;
    this.statistics.size = size;
    this.statistics.maxSize = Math.max(this.statistics.maxSize, size);
  }

  private store(item: T, internal: boolean): void {
    if (this.disk === null) return;
    const failure = this.disk.append(item as never, internal);
    if (failure !== null) this.host.report(`queue '${this.name}': error writing the disk queue: ${failure}`);
    if (this.disk.takePendingPersist()) this.persist(true);
    this.countUpdates(1);
  }

  private countUpdates(count: number): void {
    if (this.disk?.managesCheckpoints === true) return;
    this.updatesSincePersist += count;
    const interval = this.settings.checkpointInterval;
    if (interval > 0 && this.updatesSincePersist >= interval) {
      this.persist(true);
      this.updatesSincePersist = 0;
    }
  }

  private persist(checkpoint: boolean): void {
    if (this.disk !== null && !this.disk.persist(checkpoint, this.physicalSize)) {
      this.host.report(`queue '${this.name}': could not write the queue info file ${this.disk.infoFile}`);
    }
  }

  restore(items: readonly T[]): void {
    for (const item of items) this.items.push(item);
    this.noteSize();
    this.adviseWorkers();
  }

  closeStore(): void {
    if (this.disk === null) return;
    this.persist(false);
    this.disk.close(this.physicalSize);
  }

  private flowControlDelays(flow: FlowControl): boolean {
    const settings = this.settings;
    if (flow === 'full') return settings.fullDelayMark >= 0 && this.physicalSize >= settings.fullDelayMark;
    if (flow === 'light') return settings.lightDelayMark >= 0 && this.physicalSize >= settings.lightDelayMark;
    return false;
  }

  private delay(item: T, mode: 'light' | 'full'): void {
    const entry: Delayed<T> = { item, mode, cancel: null };
    this.delayed.push(entry);
    entry.cancel = this.host.schedule(() => this.pollDelayed(entry), FLOW_CONTROL_POLL_MS);
  }

  private pollDelayed(entry: Delayed<T>): void {
    entry.cancel = null;
    if (entry.mode === 'light' || !this.flowControlDelays('full')) this.release(entry);
    else entry.cancel = this.host.schedule(() => this.pollDelayed(entry), FLOW_CONTROL_POLL_MS);
  }

  private release(entry: Delayed<T>): void {
    const at = this.delayed.indexOf(entry);
    if (at < 0) return;
    this.delayed.splice(at, 1);
    entry.cancel?.();
    entry.cancel = null;
    if (!this.stopped) this.admission(entry.item);
  }

  private broadcastBelowMarks(): void {
    const { fullDelayMark, lightDelayMark } = this.settings;
    const size = this.physicalSize;
    for (const entry of [...this.delayed]) {
      if (entry.mode === 'full' && size < Math.floor(fullDelayMark / 2)) this.release(entry);
      else if (entry.mode === 'light' && size < Math.floor(lightDelayMark / 2)) this.release(entry);
    }
  }

  private discardFull(): false {
    this.statistics.discardedFull++;
    this.host.report(`queue '${this.name}': queue full - ${this.physicalSize} messages in queue, message discarded`);
    return false;
  }

  private armWaitingDeadline(): void {
    this.cancelWaitingDeadline = this.host.schedule(() => {
      this.cancelWaitingDeadline = null;
      this.waiting.shift();
      this.discardFull();
      if (this.waiting.length > 0) this.armWaitingDeadline();
    }, this.settings.timeoutEnqueue);
  }

  private admitWaiting(): void {
    while (this.waiting.length > 0 && !this.isFull()) {
      this.cancelWaitingDeadline?.();
      this.cancelWaitingDeadline = null;
      this.add(this.waiting.shift() as T);
      if (this.waiting.length > 0) this.armWaitingDeadline();
    }
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

  private desiredWorkers(): number {
    if (this.items.length === 0) return 0;
    const minimum = this.settings.workerThreadMinimumMessages;
    const wanted = minimum <= 0 ? 1 : Math.floor(this.items.length / minimum) + 1;
    return Math.min(wanted, Math.max(1, this.settings.workerThreads));
  }

  private adviseWorkers(): void {
    if (this.enqueueOnly) return;
    const minimum = this.settings.minDequeueBatchSize;
    if (minimum > 0 && this.items.length >= minimum) {
      for (const worker of this.workers) {
        if (!worker.gathering || worker.timer === null) continue;
        worker.timer();
        this.wakeUp(worker);
      }
    }
    if (this.assist !== null && !this.spilling && this.settings.highWatermark > 0 && this.items.length >= this.settings.highWatermark) this.spillToAssist();
    const wanted = this.desiredWorkers();
    let active = this.workers.filter((worker) => worker.running || worker.timer !== null || worker.committing !== null || worker.batch.length > 0).length;
    for (const worker of this.workers) {
      if (active >= wanted) break;
      if (worker.running || worker.timer !== null || worker.committing !== null || worker.batch.length > 0) continue;
      active++;
      this.drain(worker);
    }
    while (active < wanted && this.workers.length < Math.max(1, this.settings.workerThreads)) {
      const worker = newWorker<T>();
      this.workers.push(worker);
      active++;
      this.drain(worker);
    }
  }

  private spillToAssist(): void {
    const assist = this.assist as WorkerQueue<T>;
    const low = Math.max(0, this.settings.lowWatermark);
    this.spilling = true;
    while (this.physicalSize > low && this.items.length > 0) {
      const taken = this.items.splice(0, Math.max(1, Math.min(this.settings.dequeueBatchSize, this.items.length)));
      for (const item of taken) assist.enqueue(item);
      this.afterRemoval(taken.length);
    }
    this.spilling = false;
  }

  moveAllToAssist(): void {
    if (this.assist === null) return;
    this.assist.enqueueOnly = true;
    const remaining = [...this.workers.flatMap((worker) => worker.batch), ...this.items];
    this.items = [];
    for (const worker of this.workers) {
      worker.batch = [];
      worker.index = 0;
    }
    for (const item of remaining) this.assist.enqueue(item);
    this.noteSize();
  }

  private afterRemoval(count: number): void {
    this.noteSize();
    this.countUpdates(count);
    this.admitWaiting();
    this.broadcastBelowMarks();
  }

  private wakeUp(worker: Worker<T>): void {
    worker.timer = null;
    worker.wakeDelayMs = 0;
    worker.running = false;
    this.drain(worker);
  }

  private wake(worker: Worker<T>, delayMs: number): void {
    worker.timer?.();
    worker.wakeDelayMs = delayMs;
    worker.timer = this.host.schedule(() => this.wakeUp(worker), delayMs);
  }

  private pauseFor(worker: Worker<T>, sleep: Sleep): void {
    worker.running = false;
    this.wake(worker, sleep.sleepMs);
  }

  runWorkerFor(budgetMs: number, onlyMidMessage: boolean): void {
    for (const worker of this.workers) {
      let remaining = budgetMs;
      while (worker.timer !== null && worker.wakeDelayMs <= remaining && (!onlyMidMessage || worker.current !== null || worker.committing !== null)) {
        remaining -= worker.wakeDelayMs;
        worker.timer();
        this.wakeUp(worker);
      }
    }
  }

  doubleCapacity(): void {
    this.settings.size *= 2;
    if (this.settings.highWatermark > 0) this.settings.highWatermark *= 2;
  }

  private endBatch(worker: Worker<T>): Sleep | null {
    if (worker.committing === null) {
      const started = this.host.endBatch?.();
      if (started === undefined) return this.releaseBatch(worker);
      worker.committing = started;
    }
    const step = worker.committing.next();
    if (step.done === true) {
      worker.committing = null;
      return this.releaseBatch(worker);
    }
    return step.value;
  }

  private commitProgress(worker: Worker<T>, finished: boolean): void {
    if (worker.ledger === null) return;
    worker.ledger.progress = worker.progress ?? worker.ledger.progress;
    worker.ledger.finished = finished;
    if (finished) worker.ledger = null;
    if (this.disk === null) return;
    let pointer: QueuePosition | null = null;
    while (this.ledger.length > 0) {
      const entry = this.ledger[0];
      pointer = entry.progress ?? pointer;
      if (!entry.finished) break;
      this.ledger.shift();
    }
    if (pointer === null) return;
    const deleted = this.disk.commit(pointer);
    if (deleted > 0 && !this.disk.managesCheckpoints) this.persist(true);
    if (finished) this.hooks.batchCompleted?.();
  }

  private releaseBatch(worker: Worker<T>): Sleep | null {
    const processed = worker.dequeued.length + worker.requeued.length;
    const finished = worker.index >= worker.batch.length;
    this.commitProgress(worker, finished);
    worker.batch.splice(0, processed);
    worker.index = 0;
    const requeued = worker.requeued;
    worker.dequeued = [];
    worker.requeued = [];
    this.afterRemoval(processed);
    if (requeued.length === 0) return null;
    for (const item of requeued) {
      this.items.push(item);
      this.statistics.enqueued++;
      this.store(item, true);
    }
    this.noteSize();
    return { sleepMs: REQUEUE_PACE_MS };
  }

  private dequeueBatch(worker: Worker<T>): void {
    const settings = this.settings;
    const taken = this.items.splice(0, Math.max(1, Math.min(settings.dequeueBatchSize, this.items.length)));
    const before = this.physicalSize + taken.length;
    const kept: T[] = [];
    for (const item of taken) {
      if (settings.discardMark > 0 && before >= settings.discardMark && item.severity >= settings.discardSeverity) {
        this.statistics.discardedNearlyFull++;
        continue;
      }
      kept.push(item);
    }
    worker.batch = kept;
    worker.index = 0;
    worker.progress = null;
    if (this.disk !== null) {
      for (let at = taken.length - 1; at >= 0; at--) {
        const position = this.disk.positionOf(taken[at]);
        if (position === undefined) continue;
        this.disk.markDequeued(position);
        break;
      }
    }
    if (this.disk !== null && kept.length > 0) {
      worker.ledger = { progress: null, finished: false };
      this.ledger.push(worker.ledger);
    }
    this.broadcastBelowMarks();
  }

  private drain(worker: Worker<T>): void {
    if (worker.running || worker.timer !== null || this.stopped) return;
    worker.running = true;
    for (;;) {
      if (worker.committing !== null) {
        const pause = this.endBatch(worker);
        if (pause !== null) {
          this.pauseFor(worker, pause);
          return;
        }
      }
      if (worker.deferredSleep !== null) {
        const sleep = worker.deferredSleep;
        worker.deferredSleep = null;
        this.pauseFor(worker, sleep);
        return;
      }
      if (worker.current === null) {
        if (worker.index >= worker.batch.length) {
          if (worker.batch.length > 0 || worker.dequeued.length > 0 || worker.requeued.length > 0) {
            const pause = this.endBatch(worker);
            if (pause !== null) {
              this.pauseFor(worker, pause);
              return;
            }
            if (this.settings.dequeueSlowdown > 0) {
              worker.running = false;
              this.wake(worker, Math.max(1, Math.ceil(this.settings.dequeueSlowdown / 1000)));
              return;
            }
            continue;
          }
          if (this.items.length === 0) {
            this.armIdle();
            break;
          }
          const waitForWindow = this.withinDequeueWindow();
          if (waitForWindow > 0) {
            worker.running = false;
            this.wake(worker, waitForWindow);
            return;
          }
          const minimum = this.settings.minDequeueBatchSize;
          if (minimum > 0 && this.items.length < minimum && !worker.gathering) {
            worker.gathering = true;
            worker.running = false;
            this.wake(worker, this.settings.minDequeueBatchTimeout);
            return;
          }
          worker.gathering = false;
          this.dequeueBatch(worker);
          if (worker.batch.length === 0) continue;
        }
        worker.current = this.process(worker.batch[worker.index]);
      }
      const step = worker.current.next();
      if (step.done !== true) {
        const sleep = step.value;
        worker.deferredSleep = sleep;
        const pause = this.endBatch(worker);
        if (pause === null) worker.deferredSleep = null;
        this.pauseFor(worker, pause ?? sleep);
        return;
      }
      worker.current = null;
      const outcome = step.value;
      if (outcome === 'done' || outcome === 'requeue') {
        const finished = worker.batch[worker.index];
        if (this.disk !== null) worker.progress = this.disk.positionOf(finished as never) ?? worker.progress;
        (outcome === 'done' ? worker.dequeued : worker.requeued).push(finished);
        worker.index++;
      } else {
        const pause = this.endBatch(worker);
        if (pause !== null) {
          this.pauseFor(worker, pause);
          return;
        }
        worker.running = false;
        this.wake(worker, Math.max(1, outcome.retryAfterMs));
        return;
      }
    }
    worker.running = false;
  }

  private armIdle(): void {
    const idle = this.hooks.idle;
    if (idle === undefined || this.cancelIdle !== null || this.stopped) return;
    this.cancelIdle = this.host.schedule(() => this.idleFired(), idle.timeoutMs);
  }

  private disarmIdle(): void {
    this.cancelIdle?.();
    this.cancelIdle = null;
  }

  private idleFired(): void {
    this.cancelIdle = null;
    const idle = this.hooks.idle;
    if (idle === undefined || this.stopped) return;
    if (idle.check()) {
      if (this.workers.every((worker) => !worker.running && worker.timer === null && worker.batch.length === 0)) this.workers.length = 0;
      return;
    }
    this.armIdle();
  }

  get workerCount(): number {
    return this.workers.length;
  }

  stop(): void {
    this.disarmIdle();
    this.stopped = true;
    for (const worker of this.workers) {
      worker.timer?.();
      worker.timer = null;
    }
    for (const entry of this.delayed) entry.cancel?.();
    this.delayed = [];
    this.dropWaiting();
  }

  private dropWaiting(): void {
    this.cancelWaitingDeadline?.();
    this.cancelWaitingDeadline = null;
    this.waiting = [];
  }

  discardAll(): void {
    this.items = [];
    for (const worker of this.workers) {
      worker.batch = [];
      worker.index = 0;
      worker.dequeued = [];
      worker.requeued = [];
      worker.current = null;
    }
    this.dropWaiting();
    this.statistics.size = 0;
  }
}
