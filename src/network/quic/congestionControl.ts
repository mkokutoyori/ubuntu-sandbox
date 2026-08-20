// RFC 9002 §7 — a simplified NewReno congestion controller: real slow
// start / congestion avoidance / recovery transitions and formulas, no
// CUBIC/BBR (out of scope, cf. PRD-QUIC.md §2.2). Persistent-congestion
// *detection* is left to the caller (RTT/sent-time bookkeeping outside
// this module's scope) — onPersistentCongestion() applies its effect
// once the caller decides it has occurred.
const K_MAX_DATAGRAM_SIZE = 1200;
const K_INITIAL_WINDOW = Math.min(10 * K_MAX_DATAGRAM_SIZE, Math.max(2 * K_MAX_DATAGRAM_SIZE, 14720));
const K_MINIMUM_WINDOW = 2 * K_MAX_DATAGRAM_SIZE;
const K_LOSS_REDUCTION_FACTOR = 0.5;

export interface CongestionState {
  congestionWindow: number;
  bytesInFlight: number;
  slowStartThreshold: number;
  congestionRecoveryStartTime: number | null;
}

export function createCongestionState(): CongestionState {
  return {
    congestionWindow: K_INITIAL_WINDOW,
    bytesInFlight: 0,
    slowStartThreshold: Infinity,
    congestionRecoveryStartTime: null,
  };
}

export function isInSlowStart(state: CongestionState): boolean {
  return state.congestionWindow < state.slowStartThreshold;
}

export function isInRecovery(state: CongestionState, sentTime: number): boolean {
  return state.congestionRecoveryStartTime !== null && sentTime <= state.congestionRecoveryStartTime;
}

export function canSend(state: CongestionState): boolean {
  return state.bytesInFlight < state.congestionWindow;
}

export function onPacketSent(state: CongestionState, size: number): void {
  state.bytesInFlight += size;
}

// RFC 9002 §7.3.1 — slow start grows by the full acked size; congestion
// avoidance grows additively, proportional to acked size over the window.
export function onPacketAcked(state: CongestionState, ackedPacketSentTime: number, ackedSize: number): void {
  state.bytesInFlight = Math.max(0, state.bytesInFlight - ackedSize);
  if (isInRecovery(state, ackedPacketSentTime)) return;

  if (isInSlowStart(state)) {
    state.congestionWindow += ackedSize;
  } else {
    state.congestionWindow += (K_MAX_DATAGRAM_SIZE * ackedSize) / state.congestionWindow;
  }
}

// RFC 9002 §7.3.2 — on a new congestion event, halve the window (down to
// the minimum) and start a recovery period; a second loss already inside
// that same recovery period does not reduce the window again.
export function onCongestionEvent(state: CongestionState, sentTime: number, now: number): void {
  if (isInRecovery(state, sentTime)) return;
  state.congestionRecoveryStartTime = now;
  state.slowStartThreshold = state.congestionWindow * K_LOSS_REDUCTION_FACTOR;
  state.congestionWindow = Math.max(state.slowStartThreshold, K_MINIMUM_WINDOW);
}

export interface LostPacketAccounting {
  sentTime: number;
  size: number;
}

export function onPacketsLost(state: CongestionState, lostPackets: LostPacketAccounting[], now: number): void {
  if (lostPackets.length === 0) return;
  for (const p of lostPackets) state.bytesInFlight = Math.max(0, state.bytesInFlight - p.size);
  const largestLostSentTime = Math.max(...lostPackets.map((p) => p.sentTime));
  onCongestionEvent(state, largestLostSentTime, now);
}

/** Applied once the caller (outside this module) has determined persistent congestion has occurred. */
export function onPersistentCongestion(state: CongestionState): void {
  state.congestionWindow = K_MINIMUM_WINDOW;
  state.congestionRecoveryStartTime = null;
}
