import type { PacketNumberSpace } from './types';
import type { QuicFrame } from './frames';

// RFC 9002 §5/§6 constants.
const K_PACKET_THRESHOLD = 3;
const K_TIME_THRESHOLD = 9 / 8;
const K_GRANULARITY_MS = 1;
const K_INITIAL_RTT_MS = 333;

export interface SentPacketInfo {
  sentAt: number;
  size: number;
  ackEliciting: boolean;
  frames: QuicFrame[];
}

export interface SpaceState {
  largestAckedPacket: number | null;
  lossTime: number | null;
  sentPackets: Map<number, SentPacketInfo>;
}

function emptySpaceState(): SpaceState {
  return { largestAckedPacket: null, lossTime: null, sentPackets: new Map() };
}

export class LossDetectionState {
  bySpace: Record<PacketNumberSpace, SpaceState> = {
    initial: emptySpaceState(),
    handshake: emptySpaceState(),
    application: emptySpaceState(),
  };
  smoothedRtt = K_INITIAL_RTT_MS;
  rttVar = K_INITIAL_RTT_MS / 2;
  minRtt = Infinity;
  ptoCount = 0;
}

export function onPacketSent(
  state: LossDetectionState, space: PacketNumberSpace, packetNumber: number,
  size: number, ackEliciting: boolean, frames: QuicFrame[], now: number,
): void {
  state.bySpace[space].sentPackets.set(packetNumber, { sentAt: now, size, ackEliciting, frames });
}

// RFC 9002 §5.3 — smoothed RTT / RTT variance update.
export function updateRtt(state: LossDetectionState, latestRtt: number, ackDelay: number, maxAckDelay = 25): void {
  if (state.minRtt === Infinity) {
    state.minRtt = latestRtt;
    state.smoothedRtt = latestRtt;
    state.rttVar = latestRtt / 2;
    return;
  }
  state.minRtt = Math.min(state.minRtt, latestRtt);
  const adjustedAckDelay = Math.min(ackDelay, maxAckDelay);
  const adjustedRtt = latestRtt - state.minRtt >= adjustedAckDelay ? latestRtt - adjustedAckDelay : latestRtt;
  state.rttVar = 0.75 * state.rttVar + 0.25 * Math.abs(state.smoothedRtt - adjustedRtt);
  state.smoothedRtt = (7 / 8) * state.smoothedRtt + (1 / 8) * adjustedRtt;
}

export interface LostPacket {
  packetNumber: number;
  frames: QuicFrame[];
}

// RFC 9002 §6.1 — a sent-but-unacked packet at or before the largest
// acknowledged one is lost if it's kPacketThreshold packets behind, or if
// enough time (kTimeThreshold × max RTT) has passed since it was sent.
export function detectLostPackets(state: LossDetectionState, space: PacketNumberSpace, now: number): LostPacket[] {
  const spaceState = state.bySpace[space];
  if (spaceState.largestAckedPacket === null) return [];

  const lossDelay = Math.max(K_TIME_THRESHOLD * Math.max(state.smoothedRtt, state.minRtt === Infinity ? state.smoothedRtt : state.minRtt), K_GRANULARITY_MS);
  const lost: LostPacket[] = [];
  let earliestLossTime: number | null = null;

  for (const [pn, info] of spaceState.sentPackets) {
    if (pn > spaceState.largestAckedPacket) continue;
    const packetThresholdLost = spaceState.largestAckedPacket - pn >= K_PACKET_THRESHOLD;
    const lossTimeForThis = info.sentAt + lossDelay;
    const timeThresholdLost = lossTimeForThis <= now;
    if (packetThresholdLost || timeThresholdLost) {
      lost.push({ packetNumber: pn, frames: info.frames });
    } else if (earliestLossTime === null || lossTimeForThis < earliestLossTime) {
      earliestLossTime = lossTimeForThis;
    }
  }

  for (const { packetNumber } of lost) spaceState.sentPackets.delete(packetNumber);
  spaceState.lossTime = earliestLossTime;
  return lost;
}

export interface AckOutcome {
  newlyAcked: number[];
  lostPackets: LostPacket[];
}

/** Processes an ACK: takes an RTT sample from the largest newly-acked packet, removes acked entries, and runs loss detection. */
export function onAckReceived(
  state: LossDetectionState, space: PacketNumberSpace,
  ackedPacketNumbers: number[], ackDelay: number, now: number,
): AckOutcome {
  const spaceState = state.bySpace[space];
  if (ackedPacketNumbers.length === 0) return { newlyAcked: [], lostPackets: [] };
  const largestAcked = Math.max(...ackedPacketNumbers);

  const isNewLargest = spaceState.largestAckedPacket === null || largestAcked > spaceState.largestAckedPacket;
  const largestAckedInfo = spaceState.sentPackets.get(largestAcked);
  if (isNewLargest && largestAckedInfo) {
    updateRtt(state, now - largestAckedInfo.sentAt, ackDelay);
  }
  if (isNewLargest) spaceState.largestAckedPacket = largestAcked;

  const newlyAcked: number[] = [];
  for (const pn of ackedPacketNumbers) {
    if (spaceState.sentPackets.delete(pn)) newlyAcked.push(pn);
  }

  const lostPackets = detectLostPackets(state, space, now);
  if (newlyAcked.length > 0) state.ptoCount = 0;

  return { newlyAcked, lostPackets };
}

// RFC 9002 §6.2 — Probe Timeout duration, doubling with ptoCount.
export function computePtoDuration(state: LossDetectionState, maxAckDelay = 25): number {
  const base = state.smoothedRtt + Math.max(4 * state.rttVar, K_GRANULARITY_MS) + maxAckDelay;
  return base * 2 ** state.ptoCount;
}

export function onPtoExpired(state: LossDetectionState): void {
  state.ptoCount += 1;
}
