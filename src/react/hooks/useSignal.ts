/**
 * `useSignal` — React primitive that adapts our `Signal<T>` to
 * `useSyncExternalStore` so components re-render when the signal changes
 * (Phase 6 — UI projections).
 */

import { useSyncExternalStore } from 'react';
import type { Signal } from '@/events/Signal';

export function useSignal<T>(signal: Signal<T>): T {
  return useSyncExternalStore(
    (onChange) => signal.subscribe(onChange),
    () => signal.get(),
    () => signal.get(),
  );
}
