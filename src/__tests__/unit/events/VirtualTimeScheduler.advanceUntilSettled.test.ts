/*
 * Probe — VirtualTimeScheduler.advanceUntilSettled drives every unsettled
 * work from one loop, not one loop per caller.
 *
 * Measured before the fix (git stash of src/events/Scheduler.ts): 2 of the
 * 4 cases fail.
 *   - "two concurrent works": each caller ran its own loop on the same
 *     clock, so the second loop advanced to 3000 ms before the first work's
 *     continuation read the time — it returned [3000, 3000].
 *   - "a real macrotask": with no virtual timer armed, the loop spent its
 *     turn budget on microtasks and gave up before a real setTimeout(0)
 *     could fire, leaving the virtual wait behind it undriven until the
 *     test timed out (1004 ms).
 * Passing either way:
 *   - "a single work" is the WITNESS: the historical contract, unchanged.
 *   - "a nested call" is non-regression: the inner call now joins the
 *     outer loop instead of starting its own.
 */
import { describe, it, expect } from 'vitest';
import { VirtualTimeScheduler } from '@/events/Scheduler';

describe('VirtualTimeScheduler.advanceUntilSettled', () => {
  it('a single work settles at the virtual time it asked for', async () => {
    const clock = new VirtualTimeScheduler();
    const value = await clock.advanceUntilSettled(clock.delay(5000).then(() => 'done'));
    expect(value).toBe('done');
    expect(clock.now()).toBe(5000);
  });

  it('two concurrent works both settle', async () => {
    const clock = new VirtualTimeScheduler();
    const results = await Promise.all([
      clock.advanceUntilSettled(clock.delay(1000).then(() => clock.now())),
      clock.advanceUntilSettled(clock.delay(3000).then(() => clock.now())),
    ]);
    expect(results).toEqual([1000, 3000]);
  });

  it('a nested call does not advance the clock twice', async () => {
    const clock = new VirtualTimeScheduler();
    const outer = async () => {
      await clock.delay(500);
      await clock.advanceUntilSettled(clock.delay(1000));
      return clock.now();
    };
    expect(await clock.advanceUntilSettled(outer())).toBe(1500);
  });

  it('a wait behind a real macrotask is still driven', async () => {
    const clock = new VirtualTimeScheduler();
    const work = (async () => {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
      await clock.delay(2000);
      return clock.now();
    })();
    expect(await clock.advanceUntilSettled(work, 50)).toBe(2000);
  }, 1000);
});
