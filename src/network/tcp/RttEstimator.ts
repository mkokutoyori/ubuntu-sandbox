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
 * `currentRto()`/`backoff()`'s contract never changed across
 * P1 → P4, so `TcpStack.ts` only gained the one new `sample()` call site.
 */

export const TCP_INITIAL_RTO_MS = 1000;
export const TCP_MAX_RTO_MS = 60_000;
export const TCP_R1_RETRANSMITS = 3;
export const TCP_DATA_R2_MS = 100_000;
export const TCP_SYN_R2_MS = 180_000;
export const TCP_RTO_AFTER_SYN_RETRANSMIT_MS = 3_000;
export const TCP_CLOCK_GRANULARITY_MS = 1;

export interface RtoFloor {
  readonly granularityMs: number;
  readonly minRtoMs: number;
}

export const RFC_RTO_FLOOR: RtoFloor = {
  granularityMs: TCP_CLOCK_GRANULARITY_MS,
  minRtoMs: TCP_INITIAL_RTO_MS,
};

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
    private readonly floor: RtoFloor = RFC_RTO_FLOOR,
  ) {
    this.rtoMs = initialRtoMs;
  }

  /** The RTO to arm the retransmission timer with right now. */
  currentRto(): number {
    return this.rtoMs;
  }

  /** Whether `sample()` has ever actually run (test/observability convenience). */
  hasMeasurement(): boolean {
    return this.srttMs !== null;
  }

  /** A retransmission timer fired — double the RTO (capped), per RFC 6298 §5.5 (Karn's algorithm: back off regardless of SRTT until a clean sample arrives). */
  backoff(): number {
    this.rtoMs = Math.min(this.rtoMs * 2, this.maxRtoMs);
    return this.rtoMs;
  }

  holdAtLeast(minimumMs: number): void {
    this.rtoMs = Math.max(this.rtoMs, minimumMs);
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
    const raw = this.srttMs! + Math.max(this.floor.granularityMs, RTT_K * this.rttvarMs!);
    return Math.min(Math.max(raw, this.floor.minRtoMs), this.maxRtoMs);
  }
}

export function worstCaseRetransmitWindowMs(giveUpAfterMs: number = TCP_SYN_R2_MS): number {
  return giveUpAfterMs;
}
