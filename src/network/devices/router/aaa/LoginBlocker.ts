import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { NetworkOsAccountEventEnvelope } from './NetworkOsAccount';

export interface LoginBlockerOptions {
  deviceId: string;
  bus: IEventBus;
  attempts: number;
  withinSeconds: number;
  blockSeconds: number;
  now?: () => number;
}

/**
 * `login block-for` real IOS semantics: quiet-mode is a single DEVICE-WIDE
 * gate, not a per-source lockout. Once `attempts` failed logins occur
 * ANYWHERE on the device within `withinSeconds` — across every source IP,
 * every username, real or nonexistent — the router blocks ALL new login
 * attempts from ANY source (barring the `login quiet-mode access-class`
 * whitelist, enforced by the caller, not this class) until `blockSeconds`
 * elapses. A single aggregate failure history models this; the `ip`
 * parameters kept on several methods are accepted for call-site
 * compatibility (some callers still want to report per-source figures
 * from other logs) but do not partition the block itself.
 */
export class LoginBlocker {
  private readonly deviceId: string;
  private readonly attempts: number;
  private readonly withinMs: number;
  private readonly blockMs: number;
  private failureTimes: number[] = [];
  private blockedUntil: number = 0;
  private readonly subs: Unsubscribe[] = [];
  private readonly now: () => number;

  constructor(opts: LoginBlockerOptions) {
    this.deviceId = opts.deviceId;
    this.attempts = opts.attempts;
    this.withinMs = opts.withinSeconds * 1000;
    this.blockMs = opts.blockSeconds * 1000;
    this.now = opts.now ?? Date.now;
    this.subs.push(opts.bus.subscribe('router.aaa.account.login.failure', this.onFailure));
  }

  detach(): void { for (const s of this.subs) s(); this.subs.length = 0; }

  private onFailure = (e: { topic: string; payload: unknown }) => {
    const env = e as unknown as NetworkOsAccountEventEnvelope;
    if (env.payload.deviceId !== this.deviceId) return;
    const at = env.payload.at ?? this.now();
    this.failureTimes = this.failureTimes.filter(t => at - t <= this.withinMs);
    this.failureTimes.push(at);
    if (this.failureTimes.length >= this.attempts) {
      this.blockedUntil = at + this.blockMs;
    }
  };

  /** Device-wide quiet-mode state — auto-expires once `blockedUntil` passes. */
  private refresh(at: number): void {
    if (this.blockedUntil && at >= this.blockedUntil) {
      this.blockedUntil = 0;
      this.failureTimes = [];
    }
  }

  isBlocked(_ip?: string, at: number = this.now()): boolean {
    this.refresh(at);
    return this.blockedUntil !== 0 && at < this.blockedUntil;
  }

  remainingFailuresBeforeBlock(_ip?: string, at: number = this.now()): number {
    this.refresh(at);
    const recent = this.failureTimes.filter(t => at - t <= this.withinMs).length;
    return Math.max(0, this.attempts - recent);
  }

  /** Seconds left in the active device-wide quiet-mode block (0 if not blocked). */
  remainingBlockSeconds(_ip?: string, at: number = this.now()): number {
    this.refresh(at);
    if (!this.blockedUntil || at >= this.blockedUntil) return 0;
    return Math.ceil((this.blockedUntil - at) / 1000);
  }

  /** Failures recorded within the current rolling window, device-wide. */
  currentWindowFailureCount(_ip?: string, at: number = this.now()): number {
    return this.failureTimes.filter(t => at - t <= this.withinMs).length;
  }

  /**
   * Seconds until the current rolling failure window fully ages out (i.e.
   * until its oldest still-counted failure falls outside `withinSeconds`).
   * 0 once there are no failures in the window.
   */
  windowRemainingSeconds(_ip?: string, at: number = this.now()): number {
    this.refresh(at);
    const inWindow = this.failureTimes.filter(t => at - t <= this.withinMs);
    if (inWindow.length === 0) return 0;
    const oldest = Math.min(...inWindow);
    return Math.max(0, Math.ceil((this.withinMs - (at - oldest)) / 1000));
  }

  /** True while the device is currently in quiet-mode. */
  isQuietModeActive(at: number = this.now()): boolean {
    return this.isBlocked(undefined, at);
  }

  /** Seconds remaining on the active device-wide block. */
  quietModeRemainingSeconds(at: number = this.now()): number {
    return this.remainingBlockSeconds(undefined, at);
  }

  reset(): void {
    this.failureTimes = [];
    this.blockedUntil = 0;
  }
}
