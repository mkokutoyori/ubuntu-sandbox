/**
 * RmanSubject + Operators — module-internal observable layer.
 *
 * Mirrors a tiny RxJS subset: hot multicast subject, .subscribe(),
 * .pipe(filter|map|ofType|merge|distinctUntilChanged).
 */

import { describe, it, expect } from 'vitest';
import { RmanSubject } from '@/terminal/subshells/rman/reactive/RmanSubject';
import { Operators } from '@/terminal/subshells/rman/reactive/operators';

describe('RmanSubject<T>', () => {
  it('broadcasts to every subscriber', () => {
    const s = new RmanSubject<number>();
    const a: number[] = [], b: number[] = [];
    s.subscribe(v => a.push(v));
    s.subscribe(v => b.push(v));
    s.next(1); s.next(2);
    expect(a).toEqual([1, 2]);
    expect(b).toEqual([1, 2]);
  });

  it('unsubscribe stops further deliveries', () => {
    const s = new RmanSubject<number>();
    const seen: number[] = [];
    const unsub = s.subscribe(v => seen.push(v));
    s.next(1);
    unsub();
    s.next(2);
    expect(seen).toEqual([1]);
  });

  it('complete drops new subscriptions and ignores further emits', () => {
    const s = new RmanSubject<number>();
    s.next(1);
    s.complete();
    const seen: number[] = [];
    s.subscribe(v => seen.push(v));
    s.next(2);
    expect(seen).toEqual([]);
  });

  it('asObservable() hides next/complete', () => {
    const s = new RmanSubject<number>();
    const obs = s.asObservable();
    expect((obs as unknown as { next?: unknown }).next).toBeUndefined();
    const seen: number[] = [];
    obs.subscribe(v => seen.push(v));
    s.next(42);
    expect(seen).toEqual([42]);
  });
});

describe('Operators.filter', () => {
  it('keeps values matching the predicate', () => {
    const s = new RmanSubject<number>();
    const seen: number[] = [];
    s.pipe(Operators.filter(n => n % 2 === 0)).subscribe(v => seen.push(v));
    s.next(1); s.next(2); s.next(3); s.next(4);
    expect(seen).toEqual([2, 4]);
  });
});

describe('Operators.map', () => {
  it('transforms each value', () => {
    const s = new RmanSubject<number>();
    const seen: string[] = [];
    s.pipe(Operators.map(n => `n=${n}`)).subscribe(v => seen.push(v));
    s.next(1); s.next(2);
    expect(seen).toEqual(['n=1', 'n=2']);
  });
});

describe('Operators.ofType', () => {
  type E = { type: 'a'; n: number } | { type: 'b'; s: string };
  it('narrows by type guard', () => {
    const subj = new RmanSubject<E>();
    const seen: E[] = [];
    subj.pipe(Operators.ofType((e): e is Extract<E, { type: 'a' }> => e.type === 'a'))
        .subscribe(v => seen.push(v));
    subj.next({ type: 'a', n: 1 });
    subj.next({ type: 'b', s: 'x' });
    subj.next({ type: 'a', n: 2 });
    expect(seen).toEqual([{ type: 'a', n: 1 }, { type: 'a', n: 2 }]);
  });
});

describe('Operators.distinctUntilChanged', () => {
  it('suppresses consecutive duplicates', () => {
    const s = new RmanSubject<number>();
    const seen: number[] = [];
    s.pipe(Operators.distinctUntilChanged()).subscribe(v => seen.push(v));
    s.next(1); s.next(1); s.next(2); s.next(2); s.next(1);
    expect(seen).toEqual([1, 2, 1]);
  });
});
