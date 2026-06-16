import type { StreamAttachment, StreamAttachOptions } from '@/shell/input';
import { LineAssembler } from './LineAssembler';
import type {
  AsyncJobContext, AsyncJobHandle, AsyncJobSink, AsyncJobSpec,
} from './types';

export interface AsyncRuntimeBindings {
  addLine(text: string, type?: string): void;
  addLines(texts: string[], type?: string): void;
  notify(): void;
  attachStream(opts: StreamAttachOptions): StreamAttachment;
}

interface RunningJob {
  readonly id: string;
  readonly spec: AsyncJobSpec;
  readonly controller: AbortController;
  readonly assembler: LineAssembler;
  readonly cancelHandlers: Array<() => void>;
  readonly startedAt: number;
  ctx: AsyncJobContext;
  attachment: StreamAttachment | null;
  running: boolean;
}

export class TerminalAsyncRuntime {
  private readonly jobs = new Map<string, RunningJob>();
  private foreground: RunningJob | null = null;
  private seq = 1;

  constructor(private readonly bindings: AsyncRuntimeBindings) {}

  get hasForegroundJob(): boolean {
    return this.foreground !== null && this.foreground.running;
  }

  get hasBackgroundJobs(): boolean {
    for (const job of this.jobs.values()) {
      if (job.running && job.spec.mode === 'background') return true;
    }
    return false;
  }

  listJobs(): AsyncJobHandle[] {
    return [...this.jobs.values()].map((job) => this.toHandle(job));
  }

  start(spec: AsyncJobSpec): AsyncJobHandle | null {
    if (spec.mode === 'foreground' && this.foreground && this.foreground.running) {
      return null;
    }

    const id = `j${this.seq++}`;
    const controller = new AbortController();
    const job: RunningJob = {
      id,
      spec,
      controller,
      assembler: new LineAssembler(),
      cancelHandlers: [],
      startedAt: Date.now(),
      ctx: null as unknown as AsyncJobContext,
      attachment: null,
      running: true,
    };
    job.ctx = this.buildContext(job);

    if (spec.prepare && spec.prepare(job.ctx) === false) {
      controller.abort();
      return null;
    }

    this.jobs.set(id, job);

    if (spec.mode === 'foreground') {
      this.foreground = job;
      job.attachment = this.bindings.attachStream({
        description: spec.label ?? spec.command,
        sink: { write: () => {} },
        onCancel: () => this.onStreamCancelled(job),
      });
    }

    this.bindings.notify();

    Promise.resolve()
      .then(() => spec.run(job.ctx))
      .then(() => this.completeJob(job))
      .catch((err) => {
        if (job.running) {
          this.bindings.addLine(String((err as Error)?.message ?? err), 'error');
        }
        this.stopJob(job, true);
        this.bindings.notify();
      });

    return this.toHandle(job);
  }

  interruptForeground(): boolean {
    const job = this.foreground;
    if (!job || !job.running) return false;
    const rest = job.assembler.flush();
    if (rest !== null) this.bindings.addLine(rest);
    this.bindings.addLine('^C');
    this.stopJob(job, true);
    this.runInterruptHook(job);
    this.bindings.notify();
    return true;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    this.stopJob(job, true);
    this.bindings.notify();
    return true;
  }

  cancelWhere(predicate: (handle: AsyncJobHandle) => boolean): number {
    let count = 0;
    for (const job of [...this.jobs.values()]) {
      if (job.running && predicate(this.toHandle(job))) {
        this.stopJob(job, true);
        count++;
      }
    }
    if (count > 0) this.bindings.notify();
    return count;
  }

  cancelAll(): void {
    for (const job of [...this.jobs.values()]) this.stopJob(job, true);
    this.bindings.notify();
  }

  private completeJob(job: RunningJob): void {
    if (!job.running) return;
    const rest = job.assembler.flush();
    if (rest !== null) this.bindings.addLine(rest);
    this.stopJob(job, true);
    this.bindings.notify();
  }

  private stopJob(job: RunningJob, runCancelHandlers: boolean): void {
    if (!job.running) return;
    job.running = false;
    if (runCancelHandlers) {
      for (const handler of job.cancelHandlers) {
        try { handler(); } catch { /* */ }
      }
    }
    job.controller.abort();
    this.jobs.delete(job.id);
    if (this.foreground === job) this.foreground = null;
    job.attachment?.cancel();
  }

  private onStreamCancelled(job: RunningJob): void {
    if (!job.running) return;
    this.stopJob(job, true);
    this.bindings.notify();
  }

  private runInterruptHook(job: RunningJob): void {
    try { job.spec.onInterrupt?.(job.ctx); } catch { /* */ }
  }

  private buildContext(job: RunningJob): AsyncJobContext {
    const sink: AsyncJobSink = {
      line: (text, type) => this.bindings.addLine(text, type ?? 'normal'),
      lines: (texts, type) => this.bindings.addLines([...texts], type ?? 'normal'),
      write: (chunk, type) => {
        for (const ln of job.assembler.push(chunk)) this.bindings.addLine(ln, type ?? 'normal');
      },
      warn: (text) => this.bindings.addLine(text, 'warning'),
      error: (text) => this.bindings.addLine(text, 'error'),
    };
    return {
      sink,
      signal: job.controller.signal,
      cancelled: () => job.controller.signal.aborted,
      onCancel: (handler) => { job.cancelHandlers.push(handler); },
      delay: (ms) => this.abortableDelay(job.controller.signal, ms),
    };
  }

  private abortableDelay(signal: AbortSignal, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      const onAbort = () => { clearTimeout(timer); cleanup(); resolve(); };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort);
    });
  }

  private toHandle(job: RunningJob): AsyncJobHandle {
    return {
      id: job.id,
      mode: job.spec.mode,
      kind: job.spec.kind,
      command: job.spec.command,
      label: job.spec.label ?? job.spec.command,
      startedAt: job.startedAt,
      get running() { return job.running; },
      cancel: () => this.cancel(job.id),
    };
  }
}
