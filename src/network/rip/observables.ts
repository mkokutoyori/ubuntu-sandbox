/**
 * RIP — observable read-models (Signals) + projection functions.
 *
 * Mirrors the OSPF / IPSec observables design: a private store
 * holds the writable signals; the read-only `RIPObservables` is
 * exposed by `engine.observables`. Pure projection functions
 * recompute view-models from the raw engine state.
 */

import { WritableSignal, type Signal } from '@/events/Signal';
import type { RIPRouteState } from './RIPEngine';

// ── View-models ────────────────────────────────────────────────────────

export interface RipRouteVM {
  readonly network: string;
  readonly mask: string;
  readonly nextHop: string;
  readonly iface: string;
  readonly metric: number;
  readonly learnedFrom: string;
  readonly garbageCollect: boolean;
  readonly lastUpdate: number;
}

export interface RipRuntimeStatsVM {
  readonly running: boolean;
  readonly routeCount: number;
  readonly activeRouteCount: number;     // not in GC
  readonly garbageRouteCount: number;
  readonly updatesSent: number;
  readonly updatesReceived: number;
  readonly routesAdded: number;
  readonly routesRemoved: number;
}

// ── Signal store ────────────────────────────────────────────────────────

export class RIPSignalStore {
  readonly routes = new WritableSignal<ReadonlyArray<RipRouteVM>>([]);
  readonly stats = new WritableSignal<RipRuntimeStatsVM>({
    running: false,
    routeCount: 0,
    activeRouteCount: 0,
    garbageRouteCount: 0,
    updatesSent: 0,
    updatesReceived: 0,
    routesAdded: 0,
    routesRemoved: 0,
  });
}

export interface RIPObservables {
  readonly routes: Signal<ReadonlyArray<RipRouteVM>>;
  readonly stats: Signal<RipRuntimeStatsVM>;
}

export function makeReadonlyRIPObservables(store: RIPSignalStore): RIPObservables {
  return { routes: store.routes, stats: store.stats };
}

// ── Pure projections ───────────────────────────────────────────────────

export function projectRipRoutes(routes: Map<string, RIPRouteState>): RipRouteVM[] {
  const out: RipRouteVM[] = [];
  for (const [, state] of routes) {
    out.push({
      network: state.route.network.toString(),
      mask: state.route.mask.toString(),
      nextHop: state.route.nextHop.toString(),
      iface: state.route.iface,
      metric: state.route.metric,
      learnedFrom: state.learnedFrom,
      garbageCollect: state.garbageCollect,
      lastUpdate: state.lastUpdate,
    });
  }
  return out;
}

export function projectRipStats(input: {
  running: boolean;
  routes: Map<string, RIPRouteState>;
  updatesSent: number;
  updatesReceived: number;
  routesAdded: number;
  routesRemoved: number;
}): RipRuntimeStatsVM {
  let active = 0;
  let gc = 0;
  for (const [, state] of input.routes) {
    if (state.garbageCollect) gc++;
    else active++;
  }
  return {
    running: input.running,
    routeCount: input.routes.size,
    activeRouteCount: active,
    garbageRouteCount: gc,
    updatesSent: input.updatesSent,
    updatesReceived: input.updatesReceived,
    routesAdded: input.routesAdded,
    routesRemoved: input.routesRemoved,
  };
}
