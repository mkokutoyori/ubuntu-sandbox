/**
 * TEMPLATE — Projector (read-models) for a feature.
 *
 * Copy to `src/network/<feature>/observables.ts` and replace `Lldp`/`lldp`
 * with your feature name. Modelled 1:1 on `src/network/ospf/observables.ts`.
 *
 * This file is the SINGLE SOURCE OF TRUTH for "domain state → view-model".
 * It contains three things and NOTHING else:
 *   1. VM types          — immutable, serialisable, `readonly` fields only.
 *   2. SignalStore        — engine-private bundle of WritableSignals.
 *   3. Pure projections   — `projectXxx(domain): VM[]`, no side effects.
 *
 * RULES
 *  - No `import` of React, the store, the EventBus, or the Scheduler here.
 *  - Projections are PURE: same input ⇒ same output, no clock, no randomness.
 *  - VMs never hold a reference to a domain (mutable) object.
 */

import { WritableSignal, type Signal } from '@/events/Signal';
// import only the *types* you need from the domain to write the projections:
// import type { LldpNeighborState, LldpPort } from './types';

// ── 1. View-model types ──────────────────────────────────────────────────

export interface LldpNeighborVM {
  readonly localPort: string;
  readonly chassisId: string;
  readonly remotePortId: string;
  readonly systemName: string;
  readonly ttlSeconds: number;
  readonly ageSeconds: number;
}

export interface LldpRuntimeVM {
  readonly enabled: boolean;
  readonly txCount: number;
  readonly rxCount: number;
  readonly neighborCount: number;
}

// ── 2. Signal store (engine-private) ──────────────────────────────────────

/**
 * Owned by the engine as a PRIVATE field. Consumers receive only the
 * read-only `Signal<T>` view returned by `makeLldpObservables`.
 */
export class LldpSignalStore {
  readonly neighbors = new WritableSignal<ReadonlyArray<LldpNeighborVM>>([]);
  readonly runtime = new WritableSignal<LldpRuntimeVM>({
    enabled: false,
    txCount: 0,
    rxCount: 0,
    neighborCount: 0,
  });
}

/** Read-only surface exposed by the engine as `engine.observables`. */
export interface LldpObservables {
  readonly neighbors: Signal<ReadonlyArray<LldpNeighborVM>>;
  readonly runtime: Signal<LldpRuntimeVM>;
}

export function makeLldpObservables(store: LldpSignalStore): LldpObservables {
  // Expose the Signal interface only — never the writable handles.
  return {
    neighbors: store.neighbors,
    runtime: store.runtime,
  };
}

// ── 3. Pure projection functions ──────────────────────────────────────────
// These are the most-tested functions of the module. Keep ALL transform
// logic here — never in the engine, the hook, or the component.

interface NeighborProjectionInput {
  readonly localPort: string;
  readonly chassisId: string;
  readonly remotePortId: string;
  readonly systemName: string;
  readonly ttlSeconds: number;
  readonly learnedAtMs: number;
}

export function projectNeighbors(
  neighbors: Iterable<NeighborProjectionInput>,
  nowMs: number,
): LldpNeighborVM[] {
  const out: LldpNeighborVM[] = [];
  for (const n of neighbors) {
    out.push({
      localPort: n.localPort,
      chassisId: n.chassisId,
      remotePortId: n.remotePortId,
      systemName: n.systemName,
      ttlSeconds: n.ttlSeconds,
      // `nowMs` is passed in (not read from a clock) so the projection stays pure.
      ageSeconds: Math.max(0, Math.floor((nowMs - n.learnedAtMs) / 1000)),
    });
  }
  return out;
}

export function projectRuntime(input: {
  enabled: boolean;
  txCount: number;
  rxCount: number;
  neighborCount: number;
}): LldpRuntimeVM {
  return {
    enabled: input.enabled,
    txCount: input.txCount,
    rxCount: input.rxCount,
    neighborCount: input.neighborCount,
  };
}
