import { describe, it, expect, vi } from 'vitest';
import { RealTimeScheduler, VirtualTimeScheduler } from '@/events/Scheduler';

describe('VirtualTimeScheduler', () => {
  it('runs setTimeout callbacks at the requested virtual time', () => {
    const sched = new VirtualTimeScheduler();
    const order: number[] = [];

    sched.setTimeout(() => order.push(2), 200);
    sched.setTimeout(() => order.push(1), 100);
    sched.setTimeout(() => order.push(3), 300);

    sched.advance(150);
    expect(order).toEqual([1]);
    expect(sched.now()).toBe(150);

    sched.advance(200);
    expect(order).toEqual([1, 2, 3]);
    expect(sched.now()).toBe(350);
  });

  it('honours setInterval period', () => {
    const sched = new VirtualTimeScheduler();
    const ticks: number[] = [];
    sched.setInterval(() => ticks.push(sched.now()), 50);

    sched.advance(125);
    expect(ticks).toEqual([50, 100]);

    sched.advance(100);
    expect(ticks).toEqual([50, 100, 150, 200]);
  });

  it('clear() cancels pending timers', () => {
    const sched = new VirtualTimeScheduler();
    const fn = vi.fn();
    const handle = sched.setTimeout(fn, 100);
    sched.clear(handle);
    sched.advance(500);
    expect(fn).not.toHaveBeenCalled();
  });

  it('delay() resolves after advance()', async () => {
    const sched = new VirtualTimeScheduler();
    let resolved = false;
    const p = sched.delay(50).then(() => {
      resolved = true;
    });

    sched.advance(50);
    await p;
    expect(resolved).toBe(true);
    expect(sched.now()).toBe(50);
  });

  it('runs tasks scheduled by other tasks within the same advance window', () => {
    const sched = new VirtualTimeScheduler();
    const events: string[] = [];

    sched.setTimeout(() => {
      events.push('A@100');
      sched.setTimeout(() => events.push('B@150'), 50);
    }, 100);

    sched.advance(200);
    expect(events).toEqual(['A@100', 'B@150']);
    expect(sched.now()).toBe(200);
  });

  it('reset() clears clock and tasks', () => {
    const sched = new VirtualTimeScheduler();
    const fn = vi.fn();
    sched.setTimeout(fn, 10);
    sched.advance(5);
    sched.reset();
    expect(sched.now()).toBe(0);
    expect(sched.pendingCount()).toBe(0);
  });

  it('throws on negative advance', () => {
    const sched = new VirtualTimeScheduler();
    expect(() => sched.advance(-1)).toThrow();
  });
});

describe('RealTimeScheduler', () => {
  it('eventually fires real timeouts', async () => {
    const sched = new RealTimeScheduler();
    const start = sched.now();
    await sched.delay(20);
    const elapsed = sched.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(15);
  });

  it('clear() cancels real timeouts', async () => {
    const sched = new RealTimeScheduler();
    const fn = vi.fn();
    const handle = sched.setTimeout(fn, 20);
    sched.clear(handle);
    await sched.delay(40);
    expect(fn).not.toHaveBeenCalled();
  });
});
