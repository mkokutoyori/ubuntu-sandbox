/**
 * TcpCongestionControl — RFC 5681 slow start / congestion avoidance /
 * fast retransmit / fast recovery (PRD-TCP.md P5).
 *
 * A Strategy object owned one-per-`TcpSocket`, deliberately independent
 * of `TcpStack` so a future replacement (a different congestion
 * algorithm) never has to touch the state machine — `TcpStack` only calls
 * `onNewAck`/`onDuplicateAck`/`onRtoTimeout` and reads `cwnd`.
 *
 * This targets RFC 5681's real *algorithm*, not byte-exact parity with a
 * modern Linux/BSD stack (no CUBIC/BBR, no ECN) — consistent with every
 * other PRD in this repo's "real protocol, not bit-exact" stance.
 */

/** RFC 5681 §3.1 — IW = min(4×MSS, max(2×MSS, 4380 bytes)). */
export function initialCongestionWindow(mss: number): number {
  return Math.min(4 * mss, Math.max(2 * mss, 4380));
}

export class TcpCongestionControl {
  cwnd: number;
  ssthresh: number = Number.MAX_SAFE_INTEGER;
  private dupAckCount = 0;
  private inFastRecovery = false;

  constructor(private readonly mss: number) {
    this.cwnd = initialCongestionWindow(mss);
  }

  get phase(): 'slow-start' | 'congestion-avoidance' | 'fast-recovery' {
    if (this.inFastRecovery) return 'fast-recovery';
    return this.cwnd < this.ssthresh ? 'slow-start' : 'congestion-avoidance';
  }

  /**
   * A fresh ACK acknowledged `ackedBytes` of genuinely new data.
   * RFC 5681 §3.1: slow start grows cwnd by up to one MSS per ACK;
   * congestion avoidance grows it by roughly MSS²/cwnd per ACK (the
   * standard "increase by 1 MSS per RTT" approximation, byte-counted).
   */
  onNewAck(ackedBytes: number): void {
    if (this.inFastRecovery) {
      // RFC 5681 §3.2 (NewReno-less variant): a new ACK ends fast
      // recovery — deflate straight back to ssthresh.
      this.cwnd = this.ssthresh;
      this.inFastRecovery = false;
    }
    this.dupAckCount = 0;
    if (this.cwnd < this.ssthresh) {
      this.cwnd += Math.min(ackedBytes, this.mss);
    } else {
      this.cwnd += Math.max(1, Math.floor((this.mss * this.mss) / this.cwnd));
    }
  }

  /**
   * A duplicate ACK arrived (same ack number as before, no new data).
   * Returns true exactly when this is the 3rd one — the caller should
   * fast-retransmit the oldest unacked segment right now, without
   * waiting for the RTO timer (RFC 5681 §3.2).
   */
  onDuplicateAck(flightSizeBytes: number): boolean {
    if (this.inFastRecovery) {
      this.cwnd += this.mss; // further inflation while recovering
      return false;
    }
    this.dupAckCount++;
    if (this.dupAckCount < 3) return false;
    this.ssthresh = Math.max(Math.floor(flightSizeBytes / 2), 2 * this.mss);
    this.cwnd = this.ssthresh + 3 * this.mss;
    this.inFastRecovery = true;
    return true;
  }

  /** RFC 5681 §3.1 — an RTO fired: collapse to slow start from scratch. */
  onRtoTimeout(flightSizeBytes: number): void {
    this.ssthresh = Math.max(Math.floor(flightSizeBytes / 2), 2 * this.mss);
    this.cwnd = this.mss;
    this.inFastRecovery = false;
    this.dupAckCount = 0;
  }
}
