/**
 * SshAuthThrottler — reactive fail2ban-style rate limiter.
 *
 * Subscribes to `auth_failure` events on the SshServerEventBus, tracks
 * failures per source IP inside a sliding window, and once a threshold
 * is exceeded:
 *   1. emits an `auth_throttled` event back onto the bus (the syslogger
 *      will log it; the server handler can refuse further connections)
 *   2. marks the IP as blocked until `now + blockMs`.
 *
 * The component is pure (no globals, no timers) — it relies on an
 * injectable clock for deterministic tests.
 *
 * Reactive design: the throttler never calls back into the handler. The
 * handler queries `isBlocked(ip)` before processing auth, and the bus
 * delivers the throttled-event to every subscriber (logger, UI, etc.).
 */

import type {
  ISshServerEventBus,
  SshServerEvent,
} from '../server/SshServerEvent';

export interface SshAuthThrottlerOptions {
  /** Number of failures inside `windowMs` that triggers a block. Default: 5. */
  readonly threshold?: number;
  /** Sliding-window length in milliseconds. Default: 60_000. */
  readonly windowMs?: number;
  /** Duration the IP stays blocked once tripped. Default: 300_000 (5 min). */
  readonly blockMs?: number;
  /** Injectable clock for tests. Default: Date.now. */
  readonly clock?: () => number;
}

export class SshAuthThrottler {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly clock: () => number;
  private readonly unsubscribe: () => void;
  private readonly failuresByIp = new Map<string, number[]>();
  private readonly blockUntilByIp = new Map<string, number>();

  constructor(
    private readonly bus: ISshServerEventBus,
    opts: SshAuthThrottlerOptions = {},
  ) {
    this.threshold = opts.threshold ?? 5;
    this.windowMs = opts.windowMs ?? 60_000;
    this.blockMs = opts.blockMs ?? 300_000;
    this.clock = opts.clock ?? Date.now;
    this.unsubscribe = bus.on('auth_failure', (e) => this.handle(e));
  }

  /** Detach from the bus. After dispose() the throttler is inert. */
  dispose(): void {
    this.unsubscribe();
  }

  /** True iff the IP is currently blocked. Side-effect-free apart from GC. */
  isBlocked(ip: string): boolean {
    const until = this.blockUntilByIp.get(ip);
    if (until === undefined) return false;
    if (this.clock() < until) return true;
    this.blockUntilByIp.delete(ip);
    return false;
  }

  /** Returns the timestamp (in ms) the block lifts, or null if not blocked. */
  blockedUntil(ip: string): number | null {
    const until = this.blockUntilByIp.get(ip);
    if (until === undefined) return null;
    if (this.clock() >= until) {
      this.blockUntilByIp.delete(ip);
      return null;
    }
    return until;
  }

  // ─── private ─────────────────────────────────────────────────────

  private handle(event: SshServerEvent): void {
    if (event.kind !== 'auth_failure') return;
    const ip = event.ip;
    const now = this.clock();
    const prior = this.failuresByIp.get(ip) ?? [];
    // Drop stale entries outside the window, then append.
    const fresh = prior.filter((t) => now - t < this.windowMs);
    fresh.push(now);
    this.failuresByIp.set(ip, fresh);

    if (fresh.length < this.threshold) return;
    if (this.isBlocked(ip)) return; // already throttled — don't re-emit

    const blockUntil = now + this.blockMs;
    this.blockUntilByIp.set(ip, blockUntil);
    this.bus.emit({
      kind: 'auth_throttled',
      ip,
      failuresInWindow: fresh.length,
      windowSeconds: Math.floor(this.windowMs / 1000),
      blockUntil,
      timestamp: now,
    });
  }
}
