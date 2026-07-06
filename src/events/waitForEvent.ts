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
import type { DomainEventTopic, PayloadOf } from './types';

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
  return new Promise<PayloadOf<T>>((resolve, reject) => {
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
      // T stays generic inside this function body, so EventOf<T>'s
      // Extract<DomainEvent, { topic: T }> can't distribute precisely —
      // it resolves to the union of every topic's payload. Narrow through
      // unknown to the shape we actually know holds: the payload for
      // whichever concrete topic the caller instantiated T with.
      const typed = event as unknown as { payload: PayloadOf<T> };
      if (predicate(typed.payload)) {
        cleanup();
        // Two separate references to the same deferred conditional type
        // PayloadOf<T> aren't always considered mutually assignable by TS
        // inside a generic function body — go through Parameters<> to
        // match resolve's actual parameter type exactly.
        resolve(typed.payload as unknown as Parameters<typeof resolve>[0]);
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
