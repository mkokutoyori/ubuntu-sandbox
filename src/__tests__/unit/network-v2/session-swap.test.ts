import { describe, it, expect } from 'vitest';
import { SessionWorkQueue } from '@/network/devices/host/session/SessionWorkQueue';
import { SessionSwapWindow } from '@/network/devices/host/session/SessionSwapWindow';

describe('SessionWorkQueue', () => {
  it('runs tasks strictly in arrival order', async () => {
    const queue = new SessionWorkQueue();
    const order: number[] = [];
    const slow = queue.run(async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push(1);
      return 'a';
    });
    const fast = queue.run(async () => {
      order.push(2);
      return 'b';
    });
    expect(await Promise.all([slow, fast])).toEqual(['a', 'b']);
    expect(order).toEqual([1, 2]);
  });

  it('a rejected task does not block subsequent tasks', async () => {
    const queue = new SessionWorkQueue();
    const failing = queue.run(async () => { throw new Error('boom'); });
    await expect(failing).rejects.toThrow('boom');
    expect(await queue.run(async () => 42)).toBe(42);
  });

  it('propagates the rejection to the caller of the failing task only', async () => {
    const queue = new SessionWorkQueue();
    const results: string[] = [];
    const p1 = queue.run(async () => { throw new Error('first'); }).catch(e => results.push(e.message));
    const p2 = queue.run(async () => { results.push('second'); });
    await Promise.all([p1, p2]);
    expect(results).toEqual(['first', 'second']);
  });
});

describe('SessionSwapWindow', () => {
  type Session = { id: string; value: number };

  function makeFixture() {
    const device = { value: 0 };
    const calls: string[] = [];
    const swap = new SessionSwapWindow<Session, number>({
      snapshot: () => { calls.push('snapshot'); return device.value; },
      swapIn: (s) => { calls.push('swapIn'); device.value = s.value; },
      captureInto: (s) => { calls.push('capture'); s.value = device.value; },
      restore: (b) => { calls.push('restore'); device.value = b; },
    });
    return { device, calls, swap };
  }

  it('swaps in, captures on success, and restores the baseline', async () => {
    const { device, calls, swap } = makeFixture();
    device.value = 99;
    const session: Session = { id: 's1', value: 5 };

    const result = await swap.within(session, () => {
      device.value += 1;
      return 'done';
    });

    expect(result).toBe('done');
    expect(session.value).toBe(6);       // mutation captured into the session
    expect(device.value).toBe(99);       // device state restored
    expect(calls).toEqual(['snapshot', 'swapIn', 'capture', 'restore']);
  });

  it('restores but does NOT capture when the task throws', async () => {
    const { device, calls, swap } = makeFixture();
    device.value = 10;
    const session: Session = { id: 's1', value: 5 };

    await expect(swap.within(session, () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');

    expect(session.value).toBe(5);       // no capture on failure
    expect(device.value).toBe(10);       // baseline restored
    expect(calls).toEqual(['snapshot', 'swapIn', 'restore']);
  });

  it('skips capture for read-only windows (capture: false)', () => {
    const { device, calls, swap } = makeFixture();
    const session: Session = { id: 's1', value: 5 };

    const result = swap.withinSync(session, () => {
      device.value = 123;
      return device.value;
    }, { capture: false });

    expect(result).toBe(123);
    expect(session.value).toBe(5);
    expect(calls).toEqual(['snapshot', 'swapIn', 'restore']);
  });
});
