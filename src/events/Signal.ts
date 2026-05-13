/**
 * Lightweight observable primitive.
 *
 * See `docs/REFONTE-REACTIVE-EVENT-DRIVEN.md` §8.4.
 *
 * A `Signal<T>` is a value container that notifies subscribers when its
 * value changes (Object.is comparison). It is designed to plug into
 * React's `useSyncExternalStore` without any runtime adapter.
 */

export type Unsubscribe = () => void;

export interface Signal<T> {
  get(): T;
  subscribe(listener: () => void): Unsubscribe;
}

export class WritableSignal<T> implements Signal<T> {
  private value: T;
  private readonly listeners = new Set<() => void>();

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T {
    return this.value;
  }

  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    this.notify();
  }

  /** Update via mutator. The signal still uses Object.is to decide whether
   *  to notify, so callers must produce a new reference for non-primitives. */
  update(mutator: (current: T) => T): void {
    this.set(mutator(this.value));
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    // Snapshot to allow listeners to (un)subscribe during dispatch.
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (e) {
        console.error('[Signal] listener threw:', e);
      }
    }
  }
}

/**
 * Build a derived signal whose value is recomputed when any dependency
 * changes. The derivation function is called eagerly on every dependency
 * change; the result is cached and only re-emitted if Object.is shows it
 * differs from the previous computation.
 */
export function derived<T>(
  deps: ReadonlyArray<Signal<unknown>>,
  compute: () => T,
): Signal<T> {
  const out = new WritableSignal<T>(compute());
  const onChange = () => out.set(compute());
  for (const dep of deps) dep.subscribe(onChange);
  return out;
}
