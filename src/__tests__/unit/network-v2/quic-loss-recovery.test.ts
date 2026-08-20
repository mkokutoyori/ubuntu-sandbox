/**
 * PRD-QUIC.md §5 P4 — loss recovery (RFC 9002 §5/§6): RTT smoothing, packet-
 * and time-threshold loss detection, lost-data retransmission (the
 * original frames are handed back, not the packet itself resent), and PTO
 * with exponential backoff.
 */
import { describe, it, expect } from 'vitest';
import {
  LossDetectionState, onPacketSent, onAckReceived, detectLostPackets,
  updateRtt, computePtoDuration, onPtoExpired,
} from '@/network/quic/lossRecovery';
import type { QuicFrame } from '@/network/quic/frames';

describe('updateRtt (RFC 9002 §5.3)', () => {
  it('the first sample sets smoothedRtt/minRtt directly and rttVar to half', () => {
    const state = new LossDetectionState();
    updateRtt(state, 100, 0);
    expect(state.smoothedRtt).toBe(100);
    expect(state.minRtt).toBe(100);
    expect(state.rttVar).toBe(50);
  });

  it('subsequent samples smooth toward the new value', () => {
    const state = new LossDetectionState();
    updateRtt(state, 100, 0);
    updateRtt(state, 140, 0);
    // smoothed = 7/8*100 + 1/8*140 = 105
    expect(state.smoothedRtt).toBeCloseTo(105, 5);
    expect(state.minRtt).toBe(100);
  });

  it('subtracts ack delay from the sample when it does not exceed min_rtt-relative bound', () => {
    const state = new LossDetectionState();
    updateRtt(state, 100, 0);
    updateRtt(state, 150, 10, 25);
    // adjustedRtt = 150 - 10 = 140 (150-100=50 >= 10)
    expect(state.smoothedRtt).toBeCloseTo(7 / 8 * 100 + 1 / 8 * 140, 5);
  });
});

describe('Loss detection — packet threshold (RFC 9002 §6.1)', () => {
  it('marks a packet lost once it is kPacketThreshold behind the largest acked', () => {
    const state = new LossDetectionState();
    const now = 1000;
    for (let pn = 1; pn <= 5; pn++) {
      onPacketSent(state, 'application', pn, 100, true, [{ type: 'PING' }], now);
    }
    // Acking packet 5 (far ahead) without packet 1 makes packet 1 >=3 behind -> lost by packet threshold, immediately (no time needed).
    const outcome = onAckReceived(state, 'application', [5], 0, now + 1);
    expect(outcome.lostPackets.map((p) => p.packetNumber)).toContain(1);
    expect(outcome.lostPackets.map((p) => p.packetNumber)).not.toContain(4);
  });

  it('returns the original frames of a lost packet for retransmission', () => {
    const state = new LossDetectionState();
    const now = 1000;
    const frames: QuicFrame[] = [{ type: 'STREAM', streamId: 0, offset: 0, length: 3, fin: false, data: new Uint8Array([1, 2, 3]) }];
    onPacketSent(state, 'application', 1, 50, true, frames, now);
    onPacketSent(state, 'application', 2, 50, true, [], now);
    onPacketSent(state, 'application', 3, 50, true, [], now);
    onPacketSent(state, 'application', 4, 50, true, [], now);
    const outcome = onAckReceived(state, 'application', [4], 0, now + 1);
    const lost = outcome.lostPackets.find((p) => p.packetNumber === 1);
    expect(lost?.frames).toEqual(frames);
  });
});

describe('Loss detection — time threshold (RFC 9002 §6.1)', () => {
  it('marks an old unacked packet lost after kTimeThreshold × RTT has elapsed', () => {
    const state = new LossDetectionState();
    updateRtt(state, 100, 0); // smoothedRtt = 100 -> lossDelay = 9/8*100 = 112.5ms
    const now = 1000;
    onPacketSent(state, 'application', 1, 50, true, [], now);
    onPacketSent(state, 'application', 2, 50, true, [], now + 50);
    // Ack packet 2 (establishes largestAckedPacket) without acking 1.
    onAckReceived(state, 'application', [2], 0, now + 60);
    // Not yet past loss delay from packet 1's send time.
    expect(detectLostPackets(state, 'application', now + 60)).toHaveLength(0);
    // Now well past 112.5ms since packet 1 was sent.
    const lost = detectLostPackets(state, 'application', now + 200);
    expect(lost.map((p) => p.packetNumber)).toEqual([1]);
  });

  it('does not mark a packet lost before either threshold is met', () => {
    const state = new LossDetectionState();
    updateRtt(state, 100, 0);
    const now = 1000;
    onPacketSent(state, 'application', 1, 50, true, [], now);
    onPacketSent(state, 'application', 2, 50, true, [], now);
    const outcome = onAckReceived(state, 'application', [2], 0, now + 1);
    expect(outcome.lostPackets).toHaveLength(0);
  });
});

describe('PTO — Probe Timeout (RFC 9002 §6.2)', () => {
  it('grows exponentially with ptoCount', () => {
    const state = new LossDetectionState();
    updateRtt(state, 100, 0);
    const pto0 = computePtoDuration(state);
    onPtoExpired(state);
    const pto1 = computePtoDuration(state);
    onPtoExpired(state);
    const pto2 = computePtoDuration(state);
    expect(pto1).toBeCloseTo(pto0 * 2, 5);
    expect(pto2).toBeCloseTo(pto0 * 4, 5);
  });

  it('resets ptoCount to zero once an ACK makes progress', () => {
    const state = new LossDetectionState();
    onPtoExpired(state);
    onPtoExpired(state);
    expect(state.ptoCount).toBe(2);
    onPacketSent(state, 'application', 1, 50, true, [], 0);
    onAckReceived(state, 'application', [1], 0, 10);
    expect(state.ptoCount).toBe(0);
  });
});

describe('onAckReceived — acked packets are removed from the in-flight set', () => {
  it('an acked packet is not later reported as lost', () => {
    const state = new LossDetectionState();
    const now = 1000;
    onPacketSent(state, 'application', 1, 50, true, [], now);
    onPacketSent(state, 'application', 2, 50, true, [], now);
    onPacketSent(state, 'application', 3, 50, true, [], now);
    onPacketSent(state, 'application', 4, 50, true, [], now);
    const outcome = onAckReceived(state, 'application', [1, 4], 0, now + 1);
    expect(outcome.newlyAcked.sort()).toEqual([1, 4]);
    expect(outcome.lostPackets.map((p) => p.packetNumber)).not.toContain(1);
  });
});
