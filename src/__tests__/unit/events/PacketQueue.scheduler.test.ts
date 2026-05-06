import { describe, it, expect } from 'vitest';
import { PacketQueue } from '@/network/core/PacketQueue';
import { VirtualTimeScheduler } from '@/events/Scheduler';

describe('PacketQueue with VirtualTimeScheduler (Phase 4a)', () => {
  it('expires queued packets via the injected scheduler', () => {
    const scheduler = new VirtualTimeScheduler();
    const queue = new PacketQueue<string, string>(10, scheduler);

    queue.enqueue('pkt-A', 'eth0', '10.0.0.1', 1000);
    queue.enqueue('pkt-B', 'eth0', '10.0.0.2', 5000);
    expect(queue.size()).toBe(2);

    scheduler.advance(1000);
    expect(queue.size()).toBe(1);
    expect(queue.getByNextHop('10.0.0.1')).toEqual([]);
    expect(queue.getByNextHop('10.0.0.2')).toEqual(['pkt-B']);

    scheduler.advance(4000);
    expect(queue.size()).toBe(0);
  });

  it('flush() cancels timers and never expires flushed packets', () => {
    const scheduler = new VirtualTimeScheduler();
    const queue = new PacketQueue<string, string>(10, scheduler);

    queue.enqueue('pkt-A', 'eth0', '10.0.0.1', 1000);

    const sent: string[] = [];
    expect(queue.flush('10.0.0.1', (pkt) => sent.push(pkt))).toBe(1);
    expect(sent).toEqual(['pkt-A']);

    // Advance past the original timeout — nothing should fire because the
    // timer was cleared by flush().
    expect(() => scheduler.advance(2000)).not.toThrow();
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('clear() cancels all pending timers', () => {
    const scheduler = new VirtualTimeScheduler();
    const queue = new PacketQueue<string, string>(10, scheduler);

    queue.enqueue('a', 'eth0', '10.0.0.1', 1000);
    queue.enqueue('b', 'eth0', '10.0.0.2', 2000);

    queue.clear();
    expect(queue.size()).toBe(0);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('evicts the oldest entry (and its timer) when at capacity', () => {
    const scheduler = new VirtualTimeScheduler();
    const queue = new PacketQueue<string, string>(2, scheduler);

    queue.enqueue('A', 'eth0', '10.0.0.1', 1000);
    queue.enqueue('B', 'eth0', '10.0.0.2', 1000);
    queue.enqueue('C', 'eth0', '10.0.0.3', 1000); // should evict A

    expect(queue.size()).toBe(2);
    expect(queue.getByNextHop('10.0.0.1')).toEqual([]);
    expect(queue.getByNextHop('10.0.0.2')).toEqual(['B']);
    expect(queue.getByNextHop('10.0.0.3')).toEqual(['C']);
    expect(scheduler.pendingCount()).toBe(2);
  });
});
