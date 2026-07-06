/**
 * RttEstimator — per-connection Retransmission Timeout (RTO) tracker
 * (PRD-TCP.md P1/P4, RFC 6298).
 *
 * Starts out with a fixed initial RTO and exponential backoff on repeated
 * timeouts (RFC 6298's "before the first RTT measurement" case). Once
 * `sample()` is fed a real, Karn-eligible round-trip time (P4 — the caller
 * must only clock a segment that was never retransmitted, since an ACK
 * covering a retransmitted segment cannot tell which transmission it
 * actually acknowledges), the RTO tracks real SRTT/RTTVAR instead.
 * `currentRto()`/`backoff()`/`reset()`'s contract never changed across
 * P1 → P4, so `TcpStack.ts` only gained the one new `sample()` call site.
 */

export const TCP_INITIAL_RTO_MS = 1000;
export const TCP_MAX_RTO_MS = 60_000;
export const TCP_MAX_RETRANSMITS = 5;

/** RFC 6298 §2.3 smoothing constants. */
const RTT_ALPHA = 1 / 8;
const RTT_BETA = 1 / 4;
/** RFC 6298 §2.3 — RTO = SRTT + max(G, K×RTTVAR); K = 4. */
const RTT_K = 4;

export class RttEstimator {
  private rtoMs: number;
  private srttMs: number | null = null;
  private rttvarMs: number | null = null;

  constructor(
    private readonly initialRtoMs: number = TCP_INITIAL_RTO_MS,
    private readonly maxRtoMs: number = TCP_MAX_RTO_MS,
  ) {
    this.rtoMs = initialRtoMs;
  }

  /** The RTO to arm the retransmission timer with right now. */
  currentRto(): number {
    return this.rtoMs;
  }

  /** A retransmission timer fired — double the RTO (capped), per RFC 6298 §5.5 (Karn's algorithm: back off regardless of SRTT until a clean sample arrives). */
  backoff(): number {
    this.rtoMs = Math.min(this.rtoMs * 2, this.maxRtoMs);
    return this.rtoMs;
  }

  /** New data was acknowledged (real progress) — drop back to the SRTT-based estimate (or the fixed base, before any sample exists). */
  reset(): void {
    this.rtoMs = this.srttMs === null ? this.initialRtoMs : this.computeRtoFromSrtt();
  }

  /**
   * Feed a genuine round-trip sample (RFC 6298 §2). Callers must apply
   * Karn's algorithm themselves — only clock a segment that was never
   * retransmitted, since an ACK covering a retransmitted segment cannot
   * tell which transmission it actually acknowledges.
   */
  sample(rttMs: number): void {
    if (this.srttMs === null || this.rttvarMs === null) {
      // RFC 6298 §2.2 — first measurement.
      this.srttMs = rttMs;
      this.rttvarMs = rttMs / 2;
    } else {
      // RFC 6298 §2.3 — subsequent measurements.
      this.rttvarMs = (1 - RTT_BETA) * this.rttvarMs + RTT_BETA * Math.abs(this.srttMs - rttMs);
      this.srttMs = (1 - RTT_ALPHA) * this.srttMs + RTT_ALPHA * rttMs;
    }
    this.rtoMs = this.computeRtoFromSrtt();
  }

  private computeRtoFromSrtt(): number {
    const raw = this.srttMs! + Math.max(1, RTT_K * this.rttvarMs!);
    // RFC 6298 §2.4 — round up to at least 1 second.
    return Math.min(Math.max(raw, TCP_INITIAL_RTO_MS), this.maxRtoMs);
  }
}

/**
 * Worst-case elapsed time before a connection with no way to recover gives
 * up (RTO fires `TCP_MAX_RETRANSMITS + 1` times — the queue is retransmitted
 * once per fired timer, and only the retransmission *after* the count
 * exceeds the max aborts the connection — before `_teardown(..., 'timeout')`
 * runs). Tests fast-forwarding a `VirtualTimeScheduler` (or vitest fake
 * timers) past a hopeless connection attempt should advance by at least
 * this much, not by hand-summing the backoff series (easy to be off by one
 * term, since the final firing that pushes past the limit still needs to
 * be *reached* before it can be judged as "too many").
 */
export function worstCaseRetransmitWindowMs(
  initialRtoMs: number = TCP_INITIAL_RTO_MS,
  maxRtoMs: number = TCP_MAX_RTO_MS,
  maxRetransmits: number = TCP_MAX_RETRANSMITS,
): number {
  let total = 0;
  let rto = initialRtoMs;
  for (let i = 0; i <= maxRetransmits; i++) {
    total += rto;
    rto = Math.min(rto * 2, maxRtoMs);
  }
  return total;
}
