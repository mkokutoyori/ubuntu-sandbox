/**
 * OSPF — observable read-models (Signals).
 *
 * Exposes a reactive view of the engine's internal state without
 * leaking the mutable engine itself. Each signal is owned by an
 * `OSPFEngine` instance and republished after every relevant
 * mutation (FSM transition, LSDB install/flush, SPF run).
 *
 * The store is **engine-private** by construction: callers receive
 * the read-only `Signal<T>` interface, not the writable handles.
 */

import type {
  OSPFNeighborState, OSPFInterfaceState,
  LSAHeader, OSPFRouteEntry,
} from './types';
import { WritableSignal, type Signal } from '@/events/Signal';

// ── View-model types ────────────────────────────────────────────────────

export interface OspfNeighborVM {
  readonly iface: string;
  readonly routerId: string;
  readonly state: OSPFNeighborState;
  readonly ipAddress: string;
  readonly priority: number;
  readonly isMaster?: boolean;
  readonly isDR: boolean;
  readonly isBDR: boolean;
}

export interface OspfInterfaceVM {
  readonly name: string;
  readonly areaId: string;
  readonly ipAddress: string;
  readonly mask: string;
  readonly state: OSPFInterfaceState;
  readonly networkType: string;
  readonly priority: number;
  readonly cost: number;
  readonly dr: string;
  readonly bdr: string;
  readonly passive: boolean;
  readonly neighborCount: number;
  readonly fullNeighborCount: number;
}

export interface OspfLSDBSummaryVM {
  readonly totalLSAs: number;
  readonly perAreaCounts: Map<string, number>;
  readonly externalCount: number;
  readonly headers: LSAHeader[];
}

export interface OspfRoutesVM {
  readonly routes: OSPFRouteEntry[];
  readonly lastUpdatedAt: number;
}

export interface OspfRuntimeStatsVM {
  readonly running: boolean;
  readonly spfRuns: number;
  readonly lastSpfKind: 'full' | 'partial' | null;
  readonly lastSpfDurationMs: number;
  readonly neighborChanges: number;
}

// ── Signal store ────────────────────────────────────────────────────────

/**
 * Bundle of `WritableSignal`s owned by an `OSPFEngine`. Consumers
 * (UI hooks, projections, tests) read from the `Signal` interface
 * exposed by `OSPFEngine.observables`, not from this writable bundle.
 */
export class OspfSignalStore {
  readonly neighbors = new WritableSignal<ReadonlyArray<OspfNeighborVM>>([]);
  readonly interfaces = new WritableSignal<ReadonlyArray<OspfInterfaceVM>>([]);
  readonly lsdbSummary = new WritableSignal<OspfLSDBSummaryVM>({
    totalLSAs: 0,
    perAreaCounts: new Map(),
    externalCount: 0,
    headers: [],
  });
  readonly routes = new WritableSignal<OspfRoutesVM>({
    routes: [],
    lastUpdatedAt: 0,
  });
  readonly runtime = new WritableSignal<OspfRuntimeStatsVM>({
    running: false,
    spfRuns: 0,
    lastSpfKind: null,
    lastSpfDurationMs: 0,
    neighborChanges: 0,
  });
}

/**
 * Read-only view of `OspfSignalStore`. This is what consumers see —
 * no `set()` is exposed.
 */
export interface OspfObservables {
  readonly neighbors: Signal<ReadonlyArray<OspfNeighborVM>>;
  readonly interfaces: Signal<ReadonlyArray<OspfInterfaceVM>>;
  readonly lsdbSummary: Signal<OspfLSDBSummaryVM>;
  readonly routes: Signal<OspfRoutesVM>;
  readonly runtime: Signal<OspfRuntimeStatsVM>;
}

export function makeReadonlyObservables(store: OspfSignalStore): OspfObservables {
  return {
    neighbors: store.neighbors,
    interfaces: store.interfaces,
    lsdbSummary: store.lsdbSummary,
    routes: store.routes,
    runtime: store.runtime,
  };
}
