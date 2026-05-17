/**
 * RmanSubject<T> — minimal hot multicast observable.
 *
 * No RxJS dependency. Synchronous emit; pipe() composes operators.
 * Used only inside the RMAN module — public consumers see
 * RmanObservable<T>, the read-only view returned by asObservable().
 */

export interface RmanObservable<T> {
  subscribe(fn: (value: T) => void): () => void;
  pipe<A>(o1: RmanOperator<T, A>): RmanObservable<A>;
  pipe<A, B>(o1: RmanOperator<T, A>, o2: RmanOperator<A, B>): RmanObservable<B>;
  pipe<A, B, C>(o1: RmanOperator<T, A>, o2: RmanOperator<A, B>, o3: RmanOperator<B, C>): RmanObservable<C>;
  pipe<A, B, C, D>(o1: RmanOperator<T, A>, o2: RmanOperator<A, B>, o3: RmanOperator<B, C>, o4: RmanOperator<C, D>): RmanObservable<D>;
  pipe(...ops: Array<RmanOperator<unknown, unknown>>): RmanObservable<unknown>;
}

export type RmanOperator<T, U> = (source: RmanObservable<T>) => RmanObservable<U>;

export class RmanSubject<T> implements RmanObservable<T> {
  private readonly _subscribers = new Set<(v: T) => void>();
  private _completed = false;

  next(value: T): void {
    if (this._completed) return;
    for (const sub of [...this._subscribers]) {
      try { sub(value); } catch (e) { console.error('[RmanSubject]', e); }
    }
  }

  complete(): void {
    this._completed = true;
    this._subscribers.clear();
  }

  subscribe(fn: (value: T) => void): () => void {
    if (this._completed) return () => {};
    this._subscribers.add(fn);
    return () => { this._subscribers.delete(fn); };
  }

  asObservable(): RmanObservable<T> {
    const self = this;
    return {
      subscribe: (fn) => self.subscribe(fn),
      pipe:      (...ops: Array<RmanOperator<unknown, unknown>>) => self.pipe(...ops as never),
    } as RmanObservable<T>;
  }

  pipe(...operators: Array<RmanOperator<unknown, unknown>>): RmanObservable<unknown> {
    let current: RmanObservable<unknown> = this.asObservable() as RmanObservable<unknown>;
    for (const op of operators) current = op(current);
    return current;
  }
}
