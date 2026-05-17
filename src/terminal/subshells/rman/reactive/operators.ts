/**
 * Operators — pure higher-order functions that transform RmanObservables.
 *
 * Each operator returns a new RmanObservable so .pipe() chains cleanly.
 * Side-effect free, no shared state.
 */

import type { RmanObservable, RmanOperator } from './RmanSubject';

export const Operators = {
  filter<T>(predicate: (v: T) => boolean): RmanOperator<T, T> {
    return (source) => ({
      subscribe(fn) {
        return source.subscribe(v => { if (predicate(v)) fn(v); });
      },
      pipe(...ops: Array<RmanOperator<unknown, unknown>>) {
        let cur: RmanObservable<unknown> = this as RmanObservable<unknown>;
        for (const o of ops) cur = o(cur);
        return cur;
      },
    });
  },

  map<T, U>(transform: (v: T) => U): RmanOperator<T, U> {
    return (source) => ({
      subscribe(fn) { return source.subscribe(v => fn(transform(v))); },
      pipe(...ops: Array<RmanOperator<unknown, unknown>>) {
        let cur: RmanObservable<unknown> = this as RmanObservable<unknown>;
        for (const o of ops) cur = o(cur);
        return cur;
      },
    });
  },

  ofType<T, K extends T>(guard: (v: T) => v is K): RmanOperator<T, K> {
    return (source) => ({
      subscribe(fn) {
        return source.subscribe(v => { if (guard(v)) fn(v); });
      },
      pipe(...ops: Array<RmanOperator<unknown, unknown>>) {
        let cur: RmanObservable<unknown> = this as RmanObservable<unknown>;
        for (const o of ops) cur = o(cur);
        return cur;
      },
    });
  },

  distinctUntilChanged<T>(eq: (a: T, b: T) => boolean = (a, b) => a === b): RmanOperator<T, T> {
    return (source) => {
      let last: T | undefined;
      let hasLast = false;
      return {
        subscribe(fn) {
          return source.subscribe(v => {
            if (!hasLast || !eq(last as T, v)) { last = v; hasLast = true; fn(v); }
          });
        },
        pipe(...ops: Array<RmanOperator<unknown, unknown>>) {
        let cur: RmanObservable<unknown> = this as RmanObservable<unknown>;
        for (const o of ops) cur = o(cur);
        return cur;
      },
      };
    };
  },

  /**
   * scan(seed, reducer) — fold left over the stream. Emits the accumulator
   * after every input. Each subscriber gets its own accumulator instance
   * (cold-style state per subscription).
   */
  scan<T, U>(seed: U, reducer: (acc: U, v: T) => U): RmanOperator<T, U> {
    return (source) => ({
      subscribe(fn) {
        let acc = seed;
        return source.subscribe(v => { acc = reducer(acc, v); fn(acc); });
      },
      pipe(...ops: Array<RmanOperator<unknown, unknown>>) {
        let cur: RmanObservable<unknown> = this as RmanObservable<unknown>;
        for (const o of ops) cur = o(cur);
        return cur;
      },
    });
  },

  /** startWith(seed) — emit `seed` synchronously, then mirror the source. */
  startWith<T>(seed: T): RmanOperator<T, T> {
    return (source) => ({
      subscribe(fn) {
        fn(seed);
        return source.subscribe(fn);
      },
      pipe(...ops: Array<RmanOperator<unknown, unknown>>) {
        let cur: RmanObservable<unknown> = this as RmanObservable<unknown>;
        for (const o of ops) cur = o(cur);
        return cur;
      },
    });
  },

  /** take(n) — forward the first `n` emissions, then auto-unsubscribe. */
  take<T>(n: number): RmanOperator<T, T> {
    return (source) => ({
      subscribe(fn) {
        let count = 0;
        let unsub: (() => void) | undefined;
        unsub = source.subscribe(v => {
          if (count >= n) return;
          count++;
          fn(v);
          if (count >= n) unsub?.();
        });
        return unsub;
      },
      pipe(...ops: Array<RmanOperator<unknown, unknown>>) {
        let cur: RmanObservable<unknown> = this as RmanObservable<unknown>;
        for (const o of ops) cur = o(cur);
        return cur;
      },
    });
  },
};
