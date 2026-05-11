/**
 * `waitForEvent` — generic helper that turns a one-shot bus subscription
 * into an awaitable Promise. Replaces the `pendingARPs / pendingPings /
 * pendingTcpHandshakes / pendingTraceHops / pendingNDPs` Maps that
 * proliferate today across `EndHost` and `Router` (cf.
 * `docs/REFONTE-REACTIVE-EVENT-DRIVEN.md` §8.5.1).
 *
 * Resolution conditions:
 *  - the next event on `topic` whose payload satisfies `predicate` resolves
 *    the promise with that payload;
 *  - the timeout (driven by an injected `IScheduler`) rejects with a
 *    descriptive Error;
 *  - in either case, the underlying subscription and timer are cleaned up,
 *    so there is no chance of a leak.
 */

import type { IEventBus } from './EventBus';
import type { IScheduler } from './Scheduler';
import type { DomainEventTopic, EventOf, PayloadOf } from './types';

export interface WaitForEventOptions {
  timeoutMs: number;
  scheduler: IScheduler;
  /** Custom error message; defaults to a generic timeout description. */
  message?: string;
  /** AbortSignal to cancel the wait early; rejects with `AbortError`. */
  signal?: AbortSignal;
}

export class WaitForEventTimeoutError extends Error {
  constructor(topic: string, timeoutMs: number) {
    super(`waitForEvent('${topic}') timed out after ${timeoutMs}ms`);
    this.name = 'WaitForEventTimeoutError';
  }
}

export class WaitForEventAbortedError extends Error {
  constructor(topic: string) {
    super(`waitForEvent('${topic}') was aborted`);
    this.name = 'WaitForEventAbortedError';
  }
}

export function waitForEvent<T extends DomainEventTopic>(
  bus: IEventBus,
  topic: T,
  predicate: (payload: PayloadOf<T>) => boolean,
  opts: WaitForEventOptions,
): Promise<PayloadOf<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      opts.scheduler.clear(timer);
      unsubscribe();
      if (abortListener && opts.signal) {
        opts.signal.removeEventListener('abort', abortListener);
      }
    };

    const timer = opts.scheduler.setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new WaitForEventTimeoutError(topic, opts.timeoutMs));
    }, opts.timeoutMs);

    const unsubscribe = bus.subscribe(topic, (event) => {
      if (settled) return;
      const typed = event as EventOf<T>;
      if (predicate(typed.payload)) {
        cleanup();
        resolve(typed.payload);
      }
    });

    let abortListener: (() => void) | undefined;
    if (opts.signal) {
      if (opts.signal.aborted) {
        cleanup();
        reject(new WaitForEventAbortedError(topic));
        return;
      }
      abortListener = () => {
        if (settled) return;
        cleanup();
        reject(new WaitForEventAbortedError(topic));
      };
      opts.signal.addEventListener('abort', abortListener);
    }
  });
}
