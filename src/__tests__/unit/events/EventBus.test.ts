import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '@/events/EventBus';
import type { DomainEvent } from '@/events/types';

const logEvent = (level: 'info' | 'warn' = 'info', event = 'unit'): DomainEvent => ({
  topic: 'log',
  payload: { level, source: 'test', event, message: 'hello' },
});

describe('EventBus', () => {
  it('dispatches events to subscribers in subscription order', () => {
    const bus = new EventBus();
    const order: number[] = [];
    bus.subscribe('log', () => order.push(1));
    bus.subscribe('log', () => order.push(2));
    bus.subscribe('log', () => order.push(3));

    bus.publish(logEvent());

    expect(order).toEqual([1, 2, 3]);
  });

  it('returns a working unsubscribe function', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const unsub = bus.subscribe('log', handler);

    bus.publish(logEvent());
    unsub();
    bus.publish(logEvent());

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('supports re-entrant publishes via a sub-event queue', () => {
    const bus = new EventBus();
    const order: string[] = [];

    bus.subscribe('log', (e) => {
      order.push(`outer:${e.payload.event}`);
      if (e.payload.event === 'first') {
        bus.publish(logEvent('info', 'second'));
        order.push('outer:done-first');
      }
    });

    bus.publish(logEvent('info', 'first'));

    expect(order).toEqual([
      'outer:first',
      'outer:done-first',
      'outer:second',
    ]);
  });

  it('delivers wildcard events to subscribeAll handlers', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribeAll((e) => seen.push(e.topic));

    bus.publish(logEvent());
    bus.publish({ topic: 'device.power-on', payload: { id: 'r1' } });

    expect(seen).toEqual(['log', 'device.power-on']);
  });

  it('isolates errors and re-emits them on bus.handler-error', () => {
    const bus = new EventBus();
    const errors: unknown[] = [];
    bus.subscribe('bus.handler-error', (e) => errors.push(e.payload.error));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    bus.subscribe('log', () => {
      throw new Error('boom');
    });
    const fine = vi.fn();
    bus.subscribe('log', fine);

    bus.publish(logEvent());

    expect(fine).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');

    consoleSpy.mockRestore();
  });

  it('supports subscribeWhere with payload predicates', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribeWhere(
      'log',
      (p) => p.level === 'warn',
      (e) => seen.push(e.payload.event),
    );

    bus.publish(logEvent('info', 'a'));
    bus.publish(logEvent('warn', 'b'));
    bus.publish(logEvent('info', 'c'));
    bus.publish(logEvent('warn', 'd'));

    expect(seen).toEqual(['b', 'd']);
  });

  it('clear() drops every subscription and pending event', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.subscribe('log', handler);
    bus.clear();

    bus.publish(logEvent());

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not call a handler that was unsubscribed before the next dispatch', () => {
    const bus = new EventBus();
    const order: number[] = [];

    bus.subscribe('log', () => order.push(1));
    const unsub2 = bus.subscribe('log', () => order.push(2));
    bus.subscribe('log', () => {
      order.push(3);
      unsub2();
    });

    // First publish: snapshot was [1, 2, 3] when dispatch started, so all
    // three handlers still run for this event even though handler 3
    // unsubscribes handler 2 mid-dispatch.
    bus.publish(logEvent());
    expect(order).toEqual([1, 2, 3]);

    // Second publish: handler 2 has been removed, so only [1, 3] fire.
    order.length = 0;
    bus.publish(logEvent());
    expect(order).toEqual([1, 3]);
  });
});
