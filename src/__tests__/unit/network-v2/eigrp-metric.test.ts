/**
 * EIGRP classic composite metric — pure arithmetic conformance
 * (RFC 7868 §5.6.2 / Cisco IOS figures).
 */
import { describe, it, expect } from 'vitest';
import {
  compositeMetric, kValuesMatch,
  EIGRP_DEFAULT_K_VALUES, EIGRP_METRIC_INFINITY,
} from '@/network/eigrp/metric';
import { defaultInterfaceDelayUs } from '@/network/hardware/Port';

describe('compositeMetric — classic IOS figures', () => {
  it('connected GigabitEthernet network costs 2816', () => {
    expect(compositeMetric({ bandwidthKbps: 1_000_000, delayUsec: 10 }))
      .toBe(2816);
  });

  it('prefix one GigE hop away costs 3072', () => {
    expect(compositeMetric({ bandwidthKbps: 1_000_000, delayUsec: 20 }))
      .toBe(3072);
  });

  it('FastEthernet path (100 Mb, 200 µs) costs 30720', () => {
    expect(compositeMetric({ bandwidthKbps: 100_000, delayUsec: 200 }))
      .toBe(30720);
  });

  it('higher bandwidth term dominates over delay for slow links', () => {
    const slow = compositeMetric({ bandwidthKbps: 10_000, delayUsec: 20 });
    const fast = compositeMetric({ bandwidthKbps: 1_000_000, delayUsec: 20 });
    expect(slow).toBeGreaterThan(fast);
  });

  it('zero/invalid bandwidth never divides by zero', () => {
    const m = compositeMetric({ bandwidthKbps: 0, delayUsec: 10 });
    expect(Number.isFinite(m)).toBe(true);
    expect(m).toBeGreaterThan(0);
  });

  it('saturates at the protocol infinity', () => {
    const m = compositeMetric({ bandwidthKbps: 1, delayUsec: 0xffffffff });
    expect(m).toBe(EIGRP_METRIC_INFINITY);
  });

  it('K2 load term increases the metric when load is high', () => {
    const k = { k1: 1, k2: 1, k3: 1, k4: 0, k5: 0 };
    const idle = compositeMetric(
      { bandwidthKbps: 100_000, delayUsec: 200, load: 1 }, k);
    const busy = compositeMetric(
      { bandwidthKbps: 100_000, delayUsec: 200, load: 250 }, k);
    expect(busy).toBeGreaterThan(idle);
  });

  it('K5 reliability factor scales the bracket when non-zero', () => {
    const k = { k1: 1, k2: 0, k3: 1, k4: 0, k5: 255 };
    const perfect = compositeMetric(
      { bandwidthKbps: 1_000_000, delayUsec: 20, reliability: 255 }, k);
    // K5/(reliability+K4) = 255/255 = 1 → same as default bracket.
    expect(perfect).toBe(3072);
  });
});

describe('kValuesMatch — adjacency gate (RFC 7868 §5.4)', () => {
  it('identical K sets match', () => {
    expect(kValuesMatch(EIGRP_DEFAULT_K_VALUES,
      { k1: 1, k2: 0, k3: 1, k4: 0, k5: 0 })).toBe(true);
  });

  it('any differing K blocks the adjacency', () => {
    expect(kValuesMatch(EIGRP_DEFAULT_K_VALUES,
      { k1: 1, k2: 1, k3: 1, k4: 0, k5: 0 })).toBe(false);
  });
});

describe('defaultInterfaceDelayUs — IOS DLY defaults per speed', () => {
  it.each([
    [10_000, 10], [1000, 10], [100, 100], [10, 1000], [1, 20_000],
  ])('%d Mbps → %d µs', (speed, delay) => {
    expect(defaultInterfaceDelayUs(speed)).toBe(delay);
  });
});
