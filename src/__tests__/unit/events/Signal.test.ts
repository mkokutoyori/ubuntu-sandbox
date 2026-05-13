import { describe, it, expect, vi } from 'vitest';
import { WritableSignal, derived } from '@/events/Signal';

describe('WritableSignal', () => {
  it('returns the initial value via get()', () => {
    const s = new WritableSignal(42);
    expect(s.get()).toBe(42);
  });

  it('notifies subscribers on a value change', () => {
    const s = new WritableSignal(0);
    const listener = vi.fn();
    s.subscribe(listener);
    s.set(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(s.get()).toBe(1);
  });

  it('does NOT notify when set() is called with the same value (Object.is)', () => {
    const s = new WritableSignal(7);
    const listener = vi.fn();
    s.subscribe(listener);
    s.set(7);
    expect(listener).not.toHaveBeenCalled();
  });

  it('treats NaN as unchanged via Object.is', () => {
    const s = new WritableSignal<number>(NaN);
    const listener = vi.fn();
    s.subscribe(listener);
    s.set(NaN);
    expect(listener).not.toHaveBeenCalled();
  });

  it('returns a working unsubscribe', () => {
    const s = new WritableSignal('a');
    const listener = vi.fn();
    const unsub = s.subscribe(listener);
    s.set('b');
    unsub();
    s.set('c');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('update() applies the mutator and notifies', () => {
    const s = new WritableSignal({ count: 0 });
    const listener = vi.fn();
    s.subscribe(listener);
    s.update((cur) => ({ count: cur.count + 1 }));
    expect(s.get()).toEqual({ count: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('derived', () => {
  it('recomputes when a dependency changes', () => {
    const a = new WritableSignal(1);
    const b = new WritableSignal(2);
    const sum = derived([a, b], () => a.get() + b.get());
    expect(sum.get()).toBe(3);

    a.set(10);
    expect(sum.get()).toBe(12);

    b.set(0);
    expect(sum.get()).toBe(10);
  });

  it('only notifies derived subscribers when the computed value changes', () => {
    const a = new WritableSignal(1);
    const isPositive = derived([a], () => a.get() > 0);
    const listener = vi.fn();
    isPositive.subscribe(listener);

    a.set(2); // still positive, derived value unchanged
    expect(listener).not.toHaveBeenCalled();

    a.set(-1); // becomes false
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
