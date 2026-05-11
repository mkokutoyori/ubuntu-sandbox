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
  OSPFv3Interface,
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

// ── OSPFv3 — view-models, projections, signal store ────────────────────
//
// OSPFv3 (RFC 5340) has a slightly different interface shape (link
// IDs, scoped IPv6 addressing) but the reactive observability story
// is the same: a small store of WritableSignals, refreshed by a
// dedicated SignalRefreshActor on bus events.

export interface OSPFv3NeighborVM {
  readonly iface: string;
  readonly routerId: string;
  readonly state: OSPFNeighborState;
  readonly priority: number;
  readonly ipAddress: string;
  readonly isDR: boolean;
  readonly isBDR: boolean;
}

export interface OSPFv3InterfaceVM {
  readonly name: string;
  readonly areaId: string;
  readonly state: OSPFInterfaceState;
  readonly networkType: string;
  readonly priority: number;
  readonly cost: number;
  readonly passive: boolean;
  readonly dr: string;
  readonly bdr: string;
  readonly neighborCount: number;
  readonly fullNeighborCount: number;
}

export interface OSPFv3RuntimeStatsVM {
  readonly running: boolean;
  readonly neighborCount: number;
  readonly fullNeighborCount: number;
  readonly interfaceCount: number;
}

export interface OSPFv3LSDBSummaryVM {
  readonly totalLSAs: number;
  readonly perAreaCounts: Map<string, number>;
  readonly externalCount: number;
}

export class OSPFv3SignalStore {
  readonly neighbors = new WritableSignal<ReadonlyArray<OSPFv3NeighborVM>>([]);
  readonly interfaces = new WritableSignal<ReadonlyArray<OSPFv3InterfaceVM>>([]);
  readonly runtime = new WritableSignal<OSPFv3RuntimeStatsVM>({
    running: false,
    neighborCount: 0,
    fullNeighborCount: 0,
    interfaceCount: 0,
  });
  readonly lsdbSummary = new WritableSignal<OSPFv3LSDBSummaryVM>({
    totalLSAs: 0,
    perAreaCounts: new Map(),
    externalCount: 0,
  });
}

export interface OSPFv3Observables {
  readonly neighbors: Signal<ReadonlyArray<OSPFv3NeighborVM>>;
  readonly interfaces: Signal<ReadonlyArray<OSPFv3InterfaceVM>>;
  readonly runtime: Signal<OSPFv3RuntimeStatsVM>;
  readonly lsdbSummary: Signal<OSPFv3LSDBSummaryVM>;
}

export function makeReadonlyV3Observables(store: OSPFv3SignalStore): OSPFv3Observables {
  return {
    neighbors: store.neighbors,
    interfaces: store.interfaces,
    runtime: store.runtime,
    lsdbSummary: store.lsdbSummary,
  };
}

// ── OSPFv3 pure projection functions ──────────────────────────────────

export function projectV3Neighbors(
  interfaces: Iterable<OSPFv3Interface>,
): OSPFv3NeighborVM[] {
  const out: OSPFv3NeighborVM[] = [];
  for (const iface of interfaces) {
    for (const [, n] of iface.neighbors) {
      out.push({
        iface: iface.name,
        routerId: n.routerId,
        state: n.state,
        priority: n.priority,
        ipAddress: n.ipAddress,
        isDR: n.routerId === iface.dr,
        isBDR: n.routerId === iface.bdr,
      });
    }
  }
  return out;
}

export function projectV3Interfaces(
  interfaces: Iterable<OSPFv3Interface>,
): OSPFv3InterfaceVM[] {
  const out: OSPFv3InterfaceVM[] = [];
  for (const iface of interfaces) {
    let fullCount = 0;
    for (const [, n] of iface.neighbors) {
      if (n.state === 'Full') fullCount++;
    }
    out.push({
      name: iface.name,
      areaId: iface.areaId,
      state: iface.state,
      networkType: iface.networkType,
      priority: iface.priority,
      cost: iface.cost,
      passive: iface.passive,
      dr: iface.dr,
      bdr: iface.bdr,
      neighborCount: iface.neighbors.size,
      fullNeighborCount: fullCount,
    });
  }
  return out;
}

export function projectV3Runtime(input: {
  running: boolean;
  interfaces: Iterable<OSPFv3Interface>;
}): OSPFv3RuntimeStatsVM {
  let neighborCount = 0;
  let fullNeighborCount = 0;
  let interfaceCount = 0;
  for (const iface of input.interfaces) {
    interfaceCount++;
    for (const [, n] of iface.neighbors) {
      neighborCount++;
      if (n.state === 'Full') fullNeighborCount++;
    }
  }
  return {
    running: input.running,
    neighborCount,
    fullNeighborCount,
    interfaceCount,
  };
}

export function projectV3LsdbSummary(lsdb: LSDB): OSPFv3LSDBSummaryVM {
  let total = 0;
  const perArea = new Map<string, number>();
  for (const [areaId, areaDB] of lsdb.areas) {
    perArea.set(areaId, areaDB.size);
    total += areaDB.size;
  }
  total += lsdb.external.size;
  return {
    totalLSAs: total,
    perAreaCounts: perArea,
    externalCount: lsdb.external.size,
  };
}
