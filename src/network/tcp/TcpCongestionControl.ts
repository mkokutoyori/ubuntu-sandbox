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
 * modern Linux/BSD stack (no CUBIC/BBR) — consistent with every
 * other PRD in this repo's "real protocol, not bit-exact" stance.
 */

export function initialCongestionWindow(mss: number): number {
  if (mss > 2190) return 2 * mss;
  if (mss > 1095) return 3 * mss;
  return 4 * mss;
}

export const TCP_CONGESTION_ALGORITHM = 'reno';

export class TcpCongestionControl {
  readonly algorithm = TCP_CONGESTION_ALGORITHM;
  cwnd: number;
  ssthresh: number = Number.MAX_SAFE_INTEGER;
  private dupAckCount = 0;
  private inFastRecovery = false;
  private inflatesOnDuplicates = false;

  constructor(private mss: number) {
    this.cwnd = initialCongestionWindow(mss);
  }

  initialize(mss: number, handshakeLost = false): void {
    this.mss = mss;
    this.cwnd = handshakeLost ? mss : initialCongestionWindow(mss);
    this.ssthresh = Number.MAX_SAFE_INTEGER;
    this.dupAckCount = 0;
    this.inFastRecovery = false;
    this.inflatesOnDuplicates = false;
  }

  get duplicateAcks(): number { return this.dupAckCount; }

  restartAfterIdle(): void {
    this.cwnd = Math.min(this.cwnd, initialCongestionWindow(this.mss));
  }

  setSegmentSize(mss: number): void {
    if (mss >= this.mss) return;
    this.cwnd = Math.max(mss, Math.floor((this.cwnd * mss) / this.mss));
    this.mss = mss;
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
    this.leaveFastRecovery();
    this.dupAckCount = 0;
    if (this.cwnd < this.ssthresh) {
      this.cwnd += Math.min(ackedBytes, this.mss);
    } else {
      this.cwnd += Math.max(1, Math.floor((this.mss * this.mss) / this.cwnd));
    }
  }

  noteDuplicateAck(): number {
    this.dupAckCount += 1;
    return this.dupAckCount;
  }

  resetDuplicateAcks(): void {
    this.dupAckCount = 0;
  }

  enterFastRecovery(flightSizeBytes: number, inflate: boolean): void {
    this.ssthresh = Math.max(Math.floor(flightSizeBytes / 2), 2 * this.mss);
    this.cwnd = inflate ? this.ssthresh + 3 * this.mss : this.ssthresh;
    this.inFastRecovery = true;
    this.inflatesOnDuplicates = inflate;
  }

  onRecoveryDuplicateAck(): void {
    if (this.inFastRecovery && this.inflatesOnDuplicates) this.cwnd += this.mss;
  }

  onPartialAck(ackedBytes: number): void {
    if (!this.inFastRecovery || !this.inflatesOnDuplicates) return;
    this.cwnd = Math.max(0, this.cwnd - ackedBytes);
    if (ackedBytes >= this.mss) this.cwnd += this.mss;
  }

  leaveFastRecovery(): void {
    if (!this.inFastRecovery) return;
    this.cwnd = this.ssthresh;
    this.inFastRecovery = false;
    this.inflatesOnDuplicates = false;
  }

  onCongestionEcho(): void {
    this.ssthresh = Math.max(Math.floor(this.cwnd / 2), 2 * this.mss);
    this.cwnd = Math.min(this.cwnd, this.ssthresh);
    this.dupAckCount = 0;
  }

  /** RFC 5681 §3.1 — an RTO fired: collapse to slow start from scratch. */
  onRtoTimeout(flightSizeBytes: number): void {
    this.ssthresh = Math.max(Math.floor(flightSizeBytes / 2), 2 * this.mss);
    this.cwnd = this.mss;
    this.inFastRecovery = false;
    this.inflatesOnDuplicates = false;
    this.dupAckCount = 0;
  }
}
