/**
 * Reactive read-models shared by every routing engine.
 *
 * Mirrors the RIP/OSPF observables design: a writable SignalStore
 * holds engine state; engines expose a read-only projection via
 * `engine.observables`. UI/tests subscribe to Signals — no polling.
 */
import { WritableSignal, type Signal } from '@/events/Signal';
import type { ProtocolNeighborView, RibRoute } from './types';

export interface RoutingRouteVM {
  readonly network: string;
  readonly mask: string;
  readonly nextHop: string;
  readonly iface: string;
  readonly protocol: string;
  readonly adminDistance: number;
  readonly metric: number;
}

export interface RoutingStatsVM {
  readonly running: boolean;
  readonly neighborCount: number;
  readonly establishedNeighborCount: number;
  readonly contributedRouteCount: number;
}

export class RoutingSignalStore {
  readonly neighbors = new WritableSignal<ReadonlyArray<ProtocolNeighborView>>([]);
  readonly routes = new WritableSignal<ReadonlyArray<RoutingRouteVM>>([]);
  readonly stats = new WritableSignal<RoutingStatsVM>({
    running: false,
    neighborCount: 0,
    establishedNeighborCount: 0,
    contributedRouteCount: 0,
  });

  /** Recompute every read-model from raw engine state in one shot. */
  project(running: boolean, neighbors: ReadonlyArray<ProtocolNeighborView>,
          routes: ReadonlyArray<RibRoute>): void {
    this.neighbors.set(neighbors);
    this.routes.set(routes.map((r) => ({
      network: String(r.network),
      mask: String(r.mask),
      nextHop: r.nextHop ? String(r.nextHop) : 'connected',
      iface: r.iface,
      protocol: r.protocol,
      adminDistance: r.adminDistance,
      metric: r.metric,
    })));
    this.stats.set({
      running,
      neighborCount: neighbors.length,
      establishedNeighborCount: neighbors.filter((n) => n.isUp).length,
      contributedRouteCount: routes.length,
    });
  }
}

export interface RoutingObservables {
  readonly neighbors: Signal<ReadonlyArray<ProtocolNeighborView>>;
  readonly routes: Signal<ReadonlyArray<RoutingRouteVM>>;
  readonly stats: Signal<RoutingStatsVM>;
}

export function makeReadonlyRoutingObservables(
  store: RoutingSignalStore,
): RoutingObservables {
  return {
    neighbors: store.neighbors,
    routes: store.routes,
    stats: store.stats,
  };
}
