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
