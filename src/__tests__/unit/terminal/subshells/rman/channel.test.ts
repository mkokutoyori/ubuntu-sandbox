/**
 * ReactiveChannelPool — N-channel pool with per-channel parallelism.
 *
 * Verifies allocate/release semantics, allocations$ / releases$ streams,
 * NO_CHANNEL_AVAILABLE saturation, and getStats() counters.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ReactiveChannelPool } from '@/terminal/subshells/rman/channel/ReactiveChannelPool';
import { DEFAULT_CHANNEL_CONFIGS } from '@/terminal/subshells/rman/channel/defaults';
import type { RmanEvent } from '@/terminal/subshells/rman/core/types';

describe('ReactiveChannelPool', () => {
  let pool: ReactiveChannelPool;
  beforeEach(() => { pool = new ReactiveChannelPool(DEFAULT_CHANNEL_CONFIGS); });

  it('allocate returns ok with a frozen ChannelHandle and emits CHANNEL_ALLOCATED', () => {
    const events: Extract<RmanEvent, { type: 'CHANNEL_ALLOCATED' }>[] = [];
    pool.allocations$.subscribe(e => events.push(e));
    const r = pool.allocate();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe('ORA_DISK_1');
      expect(r.value.deviceType).toBe('DISK');
      expect(Object.isFrozen(r.value)).toBe(true);
    }
    expect(events.length).toBe(1);
    expect(events[0].channelId).toBe('ORA_DISK_1');
  });

  it('saturating the default pool returns err NO_CHANNEL_AVAILABLE', () => {
    pool.allocate(); // ORA_DISK has parallelism=1 by default
    const r = pool.allocate();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NO_CHANNEL_AVAILABLE');
  });

  it('release frees the slot and emits CHANNEL_RELEASED', () => {
    const events: Extract<RmanEvent, { type: 'CHANNEL_RELEASED' }>[] = [];
    pool.releases$.subscribe(e => events.push(e));
    const a = pool.allocate();
    if (!a.ok) throw new Error('allocate failed');
    pool.release(a.value);
    expect(events[0].channelId).toBe(a.value.id);
    // After release, a new allocate works again
    const b = pool.allocate();
    expect(b.ok).toBe(true);
  });

  it('release is idempotent for unknown handles', () => {
    const r = pool.release({ id: 'never', deviceType: 'DISK', sid: 0, allocatedAt: 0 });
    expect(r.ok).toBe(true);
  });

  it('getStats reflects allocations and releases', () => {
    const a = pool.allocate();
    expect(pool.getStats().totalAllocated).toBe(1);
    expect(pool.getStats().currentBusy).toBe(1);
    if (a.ok) pool.release(a.value);
    expect(pool.getStats().totalReleased).toBe(1);
    expect(pool.getStats().currentBusy).toBe(0);
  });

  it('a pool with parallelism=4 hands out 4 distinct channels', () => {
    const cfg = [{ id: 'ORA_DISK', deviceType: 'DISK' as const, parallelism: 4, maxOpenFiles: 64, sid: 100 }];
    const p4 = new ReactiveChannelPool(cfg);
    const ids = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const r = p4.allocate();
      if (r.ok) ids.add(r.value.id);
    }
    expect(ids.size).toBe(4);
    expect(p4.allocate().ok).toBe(false); // 5th is saturation
  });
});
