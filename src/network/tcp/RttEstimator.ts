/**
 * RttEstimator — per-connection Retransmission Timeout (RTO) tracker
 * (PRD-TCP.md P1/P4, RFC 6298).
 *
 * P1 keeps this deliberately simple: a fixed initial RTO with exponential
 * backoff on repeated timeouts, reset on fresh progress — RFC 6298's
 * "before the first RTT measurement" case. P4 extends `sample()` to feed
 * real SRTT/RTTVAR measurements (Karn's algorithm: only clock-sample a
 * segment that was never retransmitted, since an ACK for a retransmitted
 * segment is ambiguous about which transmission it acknowledges) without
 * changing `currentRto()`/`backoff()`/`reset()`'s contract, so `TcpStack.ts`
 * never needs to change across P1 → P4.
 */

export const TCP_INITIAL_RTO_MS = 1000;
export const TCP_MAX_RTO_MS = 60_000;
export const TCP_MAX_RETRANSMITS = 5;

export class RttEstimator {
  private rtoMs: number;

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

  /** A retransmission timer fired — double the RTO (capped), per RFC 6298 §5.5. */
  backoff(): number {
    this.rtoMs = Math.min(this.rtoMs * 2, this.maxRtoMs);
    return this.rtoMs;
  }

  /** New data was acknowledged (real progress) — drop back to the base estimate. */
  reset(): void {
    this.rtoMs = this.initialRtoMs;
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
