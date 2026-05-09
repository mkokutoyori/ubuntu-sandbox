/**
 * OSPF — observable read-models (Signals) + pure projection functions.
 *
 * The signals expose a reactive view of the engine's internal state
 * without leaking the mutable engine itself. Each signal is owned by
 * an `OSPFEngine` instance and republished by the bundled
 * `SignalRefreshActor` after every relevant mutation event.
 *
 * The pure projection functions (`projectNeighbors`, `projectInterfaces`,
 * `projectLsdbSummary`, `projectRoutes`, `projectRuntime`) are the
 * single source of truth for "engine state → view-model". They are
 * directly testable without mounting the engine.
 *
 * The store is **engine-private** by construction: callers receive
 * the read-only `Signal<T>` interface, not the writable handles.
 */

import type {
  OSPFNeighborState, OSPFInterfaceState,
  LSA, LSAHeader, LSDB, OSPFInterface, OSPFRouteEntry,
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

// ── Pure projection functions ──────────────────────────────────────────
// These are the single source of truth for engine state → view-model.
// They take only the inputs they need so they can be unit-tested without
// instantiating an OSPFEngine.

/** Project the iterable of OSPF interfaces into the neighbor view-model. */
export function projectNeighbors(
  interfaces: Iterable<OSPFInterface>,
): OspfNeighborVM[] {
  const out: OspfNeighborVM[] = [];
  for (const iface of interfaces) {
    for (const [, n] of iface.neighbors) {
      out.push({
        iface: iface.name,
        routerId: n.routerId,
        state: n.state,
        ipAddress: n.ipAddress,
        priority: n.priority,
        isMaster: n.isMaster,
        isDR: n.routerId === iface.dr,
        isBDR: n.routerId === iface.bdr,
      });
    }
  }
  return out;
}

/** Project the iterable of OSPF interfaces into the interface view-model. */
export function projectInterfaces(
  interfaces: Iterable<OSPFInterface>,
): OspfInterfaceVM[] {
  const out: OspfInterfaceVM[] = [];
  for (const iface of interfaces) {
    let fullCount = 0;
    for (const [, n] of iface.neighbors) {
      if (n.state === 'Full') fullCount++;
    }
    out.push({
      name: iface.name,
      areaId: iface.areaId,
      ipAddress: iface.ipAddress,
      mask: iface.mask,
      state: iface.state,
      networkType: iface.networkType,
      priority: iface.priority,
      cost: iface.cost,
      dr: iface.dr,
      bdr: iface.bdr,
      passive: iface.passive,
      neighborCount: iface.neighbors.size,
      fullNeighborCount: fullCount,
    });
  }
  return out;
}

/** Project the LSDB into a compact summary view-model. */
export function projectLsdbSummary(lsdb: LSDB): OspfLSDBSummaryVM {
  let total = 0;
  const perArea = new Map<string, number>();
  const headers: LSAHeader[] = [];
  for (const [areaId, areaDB] of lsdb.areas) {
    perArea.set(areaId, areaDB.size);
    total += areaDB.size;
    for (const [, lsa] of areaDB) headers.push(lsaHeaderOf(lsa));
  }
  for (const [, lsa] of lsdb.external) {
    total++;
    headers.push(lsaHeaderOf(lsa));
  }
  return {
    totalLSAs: total,
    perAreaCounts: perArea,
    externalCount: lsdb.external.size,
    headers,
  };
}

/** Project the routes array into the routes view-model. */
export function projectRoutes(
  routes: ReadonlyArray<OSPFRouteEntry>,
  lastUpdatedAt: number,
): OspfRoutesVM {
  return { routes: [...routes], lastUpdatedAt };
}

/** Project the engine's runtime stats into a view-model. */
export function projectRuntime(input: {
  running: boolean;
  spfRuns: number;
  lastSpfKind: 'full' | 'partial' | null;
  lastSpfDurationMs: number;
  neighborChanges: number;
}): OspfRuntimeStatsVM {
  return { ...input };
}

/** Extract the immutable header from a full LSA. */
export function lsaHeaderOf(lsa: LSA): LSAHeader {
  return {
    lsAge: lsa.lsAge,
    options: lsa.options,
    lsType: lsa.lsType,
    linkStateId: lsa.linkStateId,
    advertisingRouter: lsa.advertisingRouter,
    lsSequenceNumber: lsa.lsSequenceNumber,
    checksum: lsa.checksum,
    length: lsa.length,
  };
}
