/**
 * RmanSubject<T> — minimal hot multicast observable.
 *
 * No RxJS dependency. Synchronous emit; pipe() composes operators.
 * Used only inside the RMAN module — public consumers see
 * RmanObservable<T>, the read-only view returned by asObservable().
 */

export interface RmanObservable<T> {
  subscribe(fn: (value: T) => void): () => void;
  pipe<U>(operator: RmanOperator<T, U>): RmanObservable<U>;
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
    return {
      subscribe: (fn) => this.subscribe(fn),
      pipe:      (op) => this.pipe(op),
    };
  }

  pipe<U>(operator: RmanOperator<T, U>): RmanObservable<U> {
    return operator(this.asObservable());
  }
}
