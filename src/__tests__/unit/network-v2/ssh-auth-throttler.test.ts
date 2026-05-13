/**
 * SshAuthThrottler — reactive fail2ban-like rate limiter.
 *
 * Subscribes to `auth_failure` events on the SshServerEventBus, tracks
 * failures per source IP within a sliding window, and emits an
 * `auth_throttled` event (also blocking subsequent attempts) once the
 * threshold is exceeded.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SshServerEventBus,
  type SshServerEvent,
} from '@/network/protocols/ssh/server/SshServerEvent';
import { SshAuthThrottler } from '@/network/protocols/ssh/security/SshAuthThrottler';

describe('SshAuthThrottler — reactive fail2ban-like', () => {
  let bus: SshServerEventBus;
  let throttler: SshAuthThrottler;
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    bus = new SshServerEventBus();
    now = 1_000_000;
    throttler = new SshAuthThrottler(bus, {
      threshold: 3,
      windowMs: 60_000,
      blockMs: 300_000,
      clock,
    });
  });

  const failure = (ip: string) =>
    bus.emit({ kind: 'auth_failure', user: 'a', reason: 'wrong_password', ip });

  it('does not block before threshold', () => {
    failure('1.1.1.1');
    failure('1.1.1.1');
    expect(throttler.isBlocked('1.1.1.1')).toBe(false);
  });

  it('blocks IP after threshold failures within the window', () => {
    failure('1.1.1.1');
    failure('1.1.1.1');
    failure('1.1.1.1');
    expect(throttler.isBlocked('1.1.1.1')).toBe(true);
  });

  it('emits auth_throttled event once on block', () => {
    const events: SshServerEvent[] = [];
    bus.on('auth_throttled', (e) => events.push(e));

    failure('1.1.1.1');
    failure('1.1.1.1');
    failure('1.1.1.1');
    failure('1.1.1.1'); // already blocked, must not emit a second time

    expect(events.length).toBe(1);
    const e = events[0] as Extract<SshServerEvent, { kind: 'auth_throttled' }>;
    expect(e.ip).toBe('1.1.1.1');
    expect(e.failuresInWindow).toBeGreaterThanOrEqual(3);
    expect(e.windowSeconds).toBe(60);
    expect(e.blockUntil).toBe(now + 300_000);
  });

  it('tracks IPs independently', () => {
    failure('1.1.1.1');
    failure('1.1.1.1');
    failure('1.1.1.1');
    expect(throttler.isBlocked('1.1.1.1')).toBe(true);
    expect(throttler.isBlocked('2.2.2.2')).toBe(false);
  });

  it('expires old failures outside the sliding window', () => {
    failure('1.1.1.1');
    failure('1.1.1.1');
    now += 70_000; // past 60s window
    failure('1.1.1.1');
    // only the most recent failure is in-window → still under threshold
    expect(throttler.isBlocked('1.1.1.1')).toBe(false);
  });

  it('unblocks after blockMs elapses', () => {
    failure('1.1.1.1');
    failure('1.1.1.1');
    failure('1.1.1.1');
    expect(throttler.isBlocked('1.1.1.1')).toBe(true);
    now += 301_000;
    expect(throttler.isBlocked('1.1.1.1')).toBe(false);
  });

  it('re-blocks after a new wave of failures post-unblock', () => {
    failure('1.1.1.1');
    failure('1.1.1.1');
    failure('1.1.1.1');
    now += 301_000;
    expect(throttler.isBlocked('1.1.1.1')).toBe(false);

    failure('1.1.1.1');
    failure('1.1.1.1');
    failure('1.1.1.1');
    expect(throttler.isBlocked('1.1.1.1')).toBe(true);
  });

  it('stops reacting after dispose()', () => {
    throttler.dispose();
    failure('1.1.1.1');
    failure('1.1.1.1');
    failure('1.1.1.1');
    expect(throttler.isBlocked('1.1.1.1')).toBe(false);
  });

  it('reports the block-until timestamp', () => {
    failure('1.1.1.1');
    failure('1.1.1.1');
    failure('1.1.1.1');
    expect(throttler.blockedUntil('1.1.1.1')).toBe(now + 300_000);
    expect(throttler.blockedUntil('2.2.2.2')).toBeNull();
  });
});
