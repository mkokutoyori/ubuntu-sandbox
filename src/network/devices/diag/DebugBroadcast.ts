import type { IEventBus, Unsubscribe } from '@/events/EventBus';

export type DebugLineListener = (line: string) => void;

export interface TerminalDebugSource {
  hasAnyFlag(): boolean;
  subscribe(listener: DebugLineListener): () => void;
}

/** Console rate limit, in lines per second. IOS's own `logging rate-limit`. */
export const DEFAULT_DEBUG_RATE_LIMIT = 1000;

export class DebugBroadcast {
  private readonly listeners = new Set<DebugLineListener>();
  private busSubs: Unsubscribe[] = [];
  private attachedBus: IEventBus | null = null;
  private attachedDeviceId: string | null = null;

  /**
   * A debug left on under load is how you lose a real router: the console
   * cannot drain what the data plane produces, and the CPU goes to
   * formatting. IOS bounds it with `logging rate-limit`; so does this.
   * Beyond the budget the line is dropped, counted, and the count is
   * reported once the window rolls over — silence would be worse than
   * the flood, since the operator would read a truncated trace as a
   * complete one.
   */
  private rateLimit = DEFAULT_DEBUG_RATE_LIMIT;
  private windowStartedAtMs = 0;
  private linesThisWindow = 0;
  private droppedThisWindow = 0;
  private droppedTotal = 0;

  setRateLimit(linesPerSecond: number): void {
    this.rateLimit = Math.max(1, Math.floor(linesPerSecond));
  }

  /**
   * `logging on` is the master switch: `no logging on` silences every
   * channel at once, debug included. The flags stay set — the operator
   * turned the output off, not the instrumentation — so `show debug`
   * still lists what would be traced.
   */
  private outputGate: (() => boolean) | null = null;

  setOutputGate(gate: (() => boolean) | null): void { this.outputGate = gate; }

  getRateLimit(): number { return this.rateLimit; }

  /** Lines the rate limiter has dropped since the device came up. */
  getDroppedCount(): number { return this.droppedTotal; }

  subscribe(listener: DebugLineListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  fan(line: string): void {
    if (this.outputGate && !this.outputGate()) return;
    if (!this.admit()) return;
    for (const listener of this.listeners) listener(line);
  }

  /**
   * Token bucket over a rolling one-second window. Returns false when the
   * budget is spent; the first line of the next window carries the notice
   * for everything the previous one lost.
   */
  private admit(): boolean {
    const now = Date.now();
    if (now - this.windowStartedAtMs >= 1000) {
      const dropped = this.droppedThisWindow;
      this.windowStartedAtMs = now;
      this.linesThisWindow = 0;
      this.droppedThisWindow = 0;
      if (dropped > 0) this.emitThrottleNotice(dropped);
    }
    if (this.linesThisWindow >= this.rateLimit) {
      this.droppedThisWindow++;
      this.droppedTotal++;
      return false;
    }
    this.linesThisWindow++;
    return true;
  }

  /**
   * Report anything the current window has dropped, without waiting for
   * the next line. A flood that stops dead would otherwise leave its
   * notice unsent — the operator has to learn about the loss even when
   * the traffic that caused it is over.
   */
  flushDrops(): void {
    if (this.droppedThisWindow === 0) return;
    const dropped = this.droppedThisWindow;
    this.droppedThisWindow = 0;
    this.emitThrottleNotice(dropped);
  }

  private emitThrottleNotice(dropped: number): void {
    this.linesThisWindow++;
    const notice = `%SYS-3-LOGGINGRATE: ${dropped} debug message${dropped === 1 ? '' : 's'} dropped by rate limiting (${this.rateLimit} msg/sec)`;
    for (const listener of this.listeners) listener(notice);
  }

  /**
   * Returns true when the caller must (re)create its bus subscriptions:
   * either nothing was attached yet, or the bus/device changed. Existing
   * subscriptions are torn down first so a bus swap never double-delivers.
   */
  beginAttach(bus: IEventBus, deviceId: string): boolean {
    if (this.attachedBus === bus && this.attachedDeviceId === deviceId) return false;
    this.detach();
    this.attachedBus = bus;
    this.attachedDeviceId = deviceId;
    return true;
  }

  track(unsubscribe: Unsubscribe): void {
    this.busSubs.push(unsubscribe);
  }

  detach(): void {
    for (const unsub of this.busSubs) unsub();
    this.busSubs = [];
    this.attachedBus = null;
    this.attachedDeviceId = null;
  }
}
