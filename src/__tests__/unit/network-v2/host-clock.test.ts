import { describe, it, expect } from 'vitest';
import { HostClock } from '@/network/devices/host/lifecycle/HostClock';

describe('HostClock — simulated monotonic clock', () => {
  it('starts at zero', () => {
    expect(new HostClock().now()).toBe(0);
  });

  it('starts at the provided epoch', () => {
    expect(new HostClock(5000).now()).toBe(5000);
  });

  it('advances by a positive delta and returns the new time', () => {
    const c = new HostClock();
    expect(c.advance(1000)).toBe(1000);
    expect(c.advance(500)).toBe(1500);
    expect(c.now()).toBe(1500);
  });

  it('never moves backwards (ignores non-positive deltas)', () => {
    const c = new HostClock(100);
    expect(c.advance(-50)).toBe(100);
    expect(c.advance(0)).toBe(100);
    expect(c.now()).toBe(100);
  });

  it('reset returns to zero', () => {
    const c = new HostClock();
    c.advance(9999);
    c.reset();
    expect(c.now()).toBe(0);
  });

  it('elapsedSince reports the delta from a past instant', () => {
    const c = new HostClock();
    const t0 = c.now();
    c.advance(2500);
    expect(c.elapsedSince(t0)).toBe(2500);
  });
});
