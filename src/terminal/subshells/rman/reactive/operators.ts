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
      pipe(op) { return op(this); },
    });
  },

  map<T, U>(transform: (v: T) => U): RmanOperator<T, U> {
    return (source) => ({
      subscribe(fn) { return source.subscribe(v => fn(transform(v))); },
      pipe(op) { return op(this); },
    });
  },

  ofType<T, K extends T>(guard: (v: T) => v is K): RmanOperator<T, K> {
    return (source) => ({
      subscribe(fn) {
        return source.subscribe(v => { if (guard(v)) fn(v); });
      },
      pipe(op) { return op(this); },
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
        pipe(op) { return op(this); },
      };
    };
  },
};
