/**
 * RmanBehaviorSubject<T> — hot multicast observable with a current value.
 *
 * Same surface as RmanSubject + a synchronous `.value` getter. Every new
 * subscriber immediately receives the current value, which makes it the
 * right primitive for derived state (active job, channel set, metrics).
 */

import { RmanSubject, type RmanObservable, type RmanOperator } from './RmanSubject';

/**
 * Deliberately does NOT `implements RmanObservable<T>` — same reason as
 * RmanSubject: its `pipe` is a single rest-arg method, which can't satisfy
 * RmanObservable<T>'s overloaded `pipe`. Use `asObservable()` for the
 * fully-typed surface.
 */
export class RmanBehaviorSubject<T> {
  private readonly _inner = new RmanSubject<T>();
  private _value: T;

  constructor(initial: T) { this._value = initial; }

  get value(): T { return this._value; }

  next(value: T): void {
    this._value = value;
    this._inner.next(value);
  }

  subscribe(fn: (v: T) => void): () => void {
    fn(this._value);                 // BehaviorSubject contract: replay current
    return this._inner.subscribe(fn);
  }

  pipe(...operators: Array<RmanOperator<unknown, unknown>>): RmanObservable<unknown> {
    let cur: RmanObservable<unknown> = this.asObservable() as RmanObservable<unknown>;
    for (const op of operators) cur = op(cur);
    return cur;
  }

  asObservable(): RmanObservable<T> {
    const self = this;
    return {
      subscribe: (fn) => self.subscribe(fn),
      pipe:      (...ops: Array<RmanOperator<unknown, unknown>>) => self.pipe(...ops),
    } as RmanObservable<T>;
  }

  complete(): void { this._inner.complete(); }
}
