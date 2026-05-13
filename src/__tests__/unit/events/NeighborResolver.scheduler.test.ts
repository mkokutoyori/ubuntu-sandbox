import { describe, it, expect, vi } from 'vitest';
import { NeighborResolver } from '@/network/core/NeighborResolver';
import { MACAddress } from '@/network/core/types';
import { VirtualTimeScheduler } from '@/events/Scheduler';

const mac = (s: string) => MACAddress.parse(s);

describe('NeighborResolver with VirtualTimeScheduler (Phase 4a)', () => {
  it('resolves immediately on cache hit (no scheduler interaction)', async () => {
    const scheduler = new VirtualTimeScheduler();
    const r = new NeighborResolver<string>('ARP', 1000, 0, scheduler);
    r.learn('10.0.0.1', mac('00:11:22:33:44:55'), 'eth0');

    const m = await r.resolve('10.0.0.1', 'eth0', () => {});
    expect(m.toString()).toBe(mac('00:11:22:33:44:55').toString());
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('resolves on learn() after a pending solicitation', async () => {
    const scheduler = new VirtualTimeScheduler();
    const r = new NeighborResolver<string>('ARP', 1000, 0, scheduler);
    const sendSolicitation = vi.fn();

    const promise = r.resolve('10.0.0.2', 'eth0', sendSolicitation);
    expect(scheduler.pendingCount()).toBe(1);
    expect(sendSolicitation).toHaveBeenCalledWith('10.0.0.2', 'eth0');

    r.learn('10.0.0.2', mac('aa:bb:cc:dd:ee:ff'), 'eth0');
    const m = await promise;
    expect(m.toString()).toBe(mac('aa:bb:cc:dd:ee:ff').toString());
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('rejects after timeout via the virtual scheduler', async () => {
    const scheduler = new VirtualTimeScheduler();
    const r = new NeighborResolver<string>('ARP', 500, 0, scheduler);

    const promise = r.resolve('10.0.0.3', 'eth0', () => {});
    scheduler.advance(500);

    await expect(promise).rejects.toMatch(/timeout/i);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('does not duplicate solicitations while one is in flight', () => {
    const scheduler = new VirtualTimeScheduler();
    const r = new NeighborResolver<string>('ARP', 1000, 0, scheduler);
    const sendSolicitation = vi.fn();

    void r.resolve('10.0.0.4', 'eth0', sendSolicitation);
    void r.resolve('10.0.0.4', 'eth0', sendSolicitation);
    void r.resolve('10.0.0.4', 'eth0', sendSolicitation);

    expect(sendSolicitation).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingCount()).toBe(3); // three timeout timers
  });

  it('clear() rejects every pending and frees timers', async () => {
    const scheduler = new VirtualTimeScheduler();
    const r = new NeighborResolver<string>('ARP', 1000, 0, scheduler);
    const promise = r.resolve('10.0.0.5', 'eth0', () => {});

    r.clear();
    await expect(promise).rejects.toMatch(/cleared/);
    expect(scheduler.pendingCount()).toBe(0);
  });
});
