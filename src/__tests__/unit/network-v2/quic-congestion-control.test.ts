/**
 * PRD-QUIC.md §5 P5 — congestion control (RFC 9002 §7): simplified
 * NewReno. Window grows in slow start until the threshold, transitions to
 * additive congestion avoidance, halves on a detected loss (with a
 * recovery period preventing double reduction), and the minimum window is
 * available for persistent congestion.
 */
import { describe, it, expect } from 'vitest';
import {
  createCongestionState, isInSlowStart, canSend,
  onPacketSent, onPacketAcked, onCongestionEvent, onPacketsLost, onPersistentCongestion,
} from '@/network/quic/congestionControl';

describe('createCongestionState', () => {
  it('starts in slow start with an initial window and no bytes in flight', () => {
    const state = createCongestionState();
    expect(isInSlowStart(state)).toBe(true);
    expect(state.bytesInFlight).toBe(0);
    expect(state.congestionWindow).toBeGreaterThan(0);
    expect(canSend(state)).toBe(true);
  });
});

describe('Slow start growth', () => {
  it('grows the window by the full acked size per ACK', () => {
    const state = createCongestionState();
    const before = state.congestionWindow;
    onPacketSent(state, 1000);
    onPacketAcked(state, 0, 1000);
    expect(state.congestionWindow).toBe(before + 1000);
    expect(state.bytesInFlight).toBe(0);
  });

  it('stays in slow start while below the threshold', () => {
    const state = createCongestionState();
    for (let i = 0; i < 5; i++) {
      onPacketSent(state, 500);
      onPacketAcked(state, 0, 500);
    }
    expect(isInSlowStart(state)).toBe(true);
  });
});

describe('Transition to congestion avoidance after a loss sets the threshold', () => {
  it('grows additively (much less than the full acked size) once past the threshold', () => {
    const state = createCongestionState();
    onPacketSent(state, 5000);
    onCongestionEvent(state, 0, 100); // sets slowStartThreshold = congestionWindow/2
    expect(isInSlowStart(state)).toBe(false);

    const windowBefore = state.congestionWindow;
    onPacketAcked(state, 200, 1000); // sentTime(200) > recoveryStartTime(100) -> not in recovery, grows
    const grown = state.congestionWindow - windowBefore;
    expect(grown).toBeGreaterThan(0);
    expect(grown).toBeLessThan(1000); // additive growth, not the full acked size
  });
});

describe('Loss reduces the window and opens a recovery period', () => {
  it('halves the congestion window down to at least the minimum', () => {
    const state = createCongestionState();
    const before = state.congestionWindow;
    onCongestionEvent(state, 0, 100);
    expect(state.congestionWindow).toBeCloseTo(before * 0.5, 5);
    expect(state.congestionRecoveryStartTime).toBe(100);
  });

  it('does not reduce the window again for a second loss within the same recovery period', () => {
    const state = createCongestionState();
    onCongestionEvent(state, 0, 100);
    const afterFirst = state.congestionWindow;
    onCongestionEvent(state, 50, 150); // sentTime 50 <= recoveryStartTime 100 -> still in the same period
    expect(state.congestionWindow).toBe(afterFirst);
  });

  it('an ACK for a packet sent before the recovery period does not grow the window', () => {
    const state = createCongestionState();
    onCongestionEvent(state, 100, 100);
    const afterLoss = state.congestionWindow;
    onPacketAcked(state, 50, 1000); // sentTime 50 <= recoveryStartTime 100 -> in recovery, no growth
    expect(state.congestionWindow).toBe(afterLoss);
  });

  it('an ACK for a packet sent after the recovery period resumes normal growth', () => {
    const state = createCongestionState();
    onCongestionEvent(state, 100, 100);
    const afterLoss = state.congestionWindow;
    onPacketAcked(state, 150, 1000); // sentTime 150 > recoveryStartTime 100 -> growth resumes
    expect(state.congestionWindow).toBeGreaterThan(afterLoss);
  });

  it('onPacketsLost removes lost bytes from flight and triggers one congestion event for the batch', () => {
    const state = createCongestionState();
    onPacketSent(state, 3000);
    const before = state.congestionWindow;
    onPacketsLost(state, [{ sentTime: 10, size: 1000 }, { sentTime: 20, size: 2000 }], 100);
    expect(state.bytesInFlight).toBe(0);
    expect(state.congestionWindow).toBeCloseTo(before * 0.5, 5);
  });
});

describe('Persistent congestion', () => {
  it('drops the window to the minimum and clears the recovery period', () => {
    const state = createCongestionState();
    onCongestionEvent(state, 0, 100);
    onPersistentCongestion(state);
    expect(state.congestionWindow).toBe(2400); // kMinimumWindow = 2 * 1200
    expect(state.congestionRecoveryStartTime).toBeNull();
    expect(isInSlowStart(state)).toBe(true); // window below the still-set threshold
  });
});

describe('canSend', () => {
  it('is false once bytesInFlight reaches the congestion window', () => {
    const state = createCongestionState();
    onPacketSent(state, state.congestionWindow);
    expect(canSend(state)).toBe(false);
  });
});
