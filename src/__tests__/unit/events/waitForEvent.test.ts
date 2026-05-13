import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import {
  waitForEvent,
  WaitForEventTimeoutError,
  WaitForEventAbortedError,
} from '@/events/waitForEvent';

describe('waitForEvent', () => {
  it('resolves when an event matching the predicate is published', async () => {
    const bus = new EventBus();
    const scheduler = new VirtualTimeScheduler();

    const promise = waitForEvent(
      bus,
      'device.power-on',
      (p) => p.id === 'r1',
      { timeoutMs: 1000, scheduler },
    );

    bus.publish({ topic: 'device.power-on', payload: { id: 'r0' } });
    bus.publish({ topic: 'device.power-on', payload: { id: 'r1' } });

    await expect(promise).resolves.toEqual({ id: 'r1' });
  });

  it('rejects with a timeout error when no event arrives', async () => {
    const bus = new EventBus();
    const scheduler = new VirtualTimeScheduler();

    const promise = waitForEvent(
      bus,
      'device.power-on',
      () => true,
      { timeoutMs: 200, scheduler },
    );

    scheduler.advance(200);

    await expect(promise).rejects.toBeInstanceOf(WaitForEventTimeoutError);
  });

  it('cleans up subscriptions and timers on resolution', async () => {
    const bus = new EventBus();
    const scheduler = new VirtualTimeScheduler();
    expect(scheduler.pendingCount()).toBe(0);

    const promise = waitForEvent(
      bus,
      'device.power-on',
      () => true,
      { timeoutMs: 1000, scheduler },
    );
    expect(scheduler.pendingCount()).toBe(1);

    bus.publish({ topic: 'device.power-on', payload: { id: 'x' } });
    await promise;

    expect(scheduler.pendingCount()).toBe(0);

    // Subsequent matching events must NOT call the handler again.
    const spy = vi.fn();
    bus.subscribe('device.power-on', spy);
    bus.publish({ topic: 'device.power-on', payload: { id: 'y' } });
    expect(spy).toHaveBeenCalledTimes(1); // only the new subscription
  });

  it('cleans up subscriptions on timeout', async () => {
    const bus = new EventBus();
    const scheduler = new VirtualTimeScheduler();

    const promise = waitForEvent(
      bus,
      'device.power-on',
      () => true,
      { timeoutMs: 100, scheduler },
    );

    scheduler.advance(100);
    await expect(promise).rejects.toBeInstanceOf(WaitForEventTimeoutError);

    // No leftover subscribers — re-publishing the same topic should not
    // trigger anything.
    const spy = vi.fn();
    bus.subscribe('device.power-on', spy);
    bus.publish({ topic: 'device.power-on', payload: { id: 'late' } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('supports AbortSignal cancellation', async () => {
    const bus = new EventBus();
    const scheduler = new VirtualTimeScheduler();
    const ac = new AbortController();

    const promise = waitForEvent(
      bus,
      'device.power-on',
      () => true,
      { timeoutMs: 1000, scheduler, signal: ac.signal },
    );

    ac.abort();
    await expect(promise).rejects.toBeInstanceOf(WaitForEventAbortedError);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('rejects synchronously when the abort signal is already aborted', async () => {
    const bus = new EventBus();
    const scheduler = new VirtualTimeScheduler();
    const ac = new AbortController();
    ac.abort();

    await expect(
      waitForEvent(
        bus,
        'device.power-on',
        () => true,
        { timeoutMs: 1000, scheduler, signal: ac.signal },
      ),
    ).rejects.toBeInstanceOf(WaitForEventAbortedError);
  });
});
