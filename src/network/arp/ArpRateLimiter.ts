/**
 * ArpRateLimiter — per-port token bucket for DAI rate limiting.
 *
 * Cisco IOS measures ARP rate in packets-per-second with a configurable
 * burst interval. When the count in the current window exceeds the
 * configured limit, the port is err-disabled. We model the same
 * semantics with a sliding-window counter keyed by `(port, intervalSec)`.
 */
export interface ArpRateState {
  windowStartMs: number;
  count: number;
}

export class ArpRateLimiter {
  private readonly state = new Map<string, ArpRateState>();

  /**
   * Consume one token. Returns:
   *   - `{ ok: true, observedPps }` if the packet is within budget.
   *   - `{ ok: false, observedPps, limit }` if the burst was exceeded;
   *     the caller is expected to err-disable the port and increment
   *     the rate-limit drop counter.
   */
  consume(port: string, limitPps: number, burstSec: number, nowMs: number = Date.now()):
    { ok: true; observedPps: number } | { ok: false; observedPps: number; limit: number }
  {
    if (limitPps <= 0) return { ok: true, observedPps: 0 };

    const burstMs = Math.max(1, burstSec) * 1000;
    let s = this.state.get(port);
    if (!s || nowMs - s.windowStartMs >= burstMs) {
      s = { windowStartMs: nowMs, count: 0 };
      this.state.set(port, s);
    }
    s.count += 1;

    const elapsedSec = Math.max((nowMs - s.windowStartMs) / 1000, 1 / 1000);
    const observedPps = s.count / Math.min(elapsedSec, Math.max(burstSec, 1));

    const burstLimit = limitPps * Math.max(burstSec, 1);
    if (s.count > burstLimit) {
      return { ok: false, observedPps, limit: limitPps };
    }
    return { ok: true, observedPps };
  }

  reset(port: string): void {
    this.state.delete(port);
  }

  clear(): void {
    this.state.clear();
  }
}
