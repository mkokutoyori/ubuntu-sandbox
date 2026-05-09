/**
 * RoutingTableSyncActor — outbound routing-table integration hook.
 *
 * Subscribes to `ospf.routes-recomputed` and forwards the resulting
 * routes to a configured "install" callback. This is the integration
 * point between the OSPF engine and the host router's data-plane (or
 * any other consumer — telemetry, sandbox snapshot, …).
 *
 * Decoupling rationale: until now, integrating OSPF with `Router`
 * required `RouterOSPFIntegration` to thread engine references and
 * sendCallbacks both ways. With this actor, the router only needs to
 * register a single install function — the rest is bus-driven.
 *
 * Multiple consumers: this actor allows multiple install callbacks
 * (e.g. the routing table + a telemetry exporter) to be subscribed
 * concurrently without any changes to the engine.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { OSPFEngine } from '../OSPFEngine';
import type { OSPFRouteEntry } from '../types';

/** Callback invoked with the freshly computed OSPF routes. */
export type OspfRoutesInstaller = (routes: ReadonlyArray<OSPFRouteEntry>) => void;

export class RoutingTableSyncActor {
  private readonly subscriptions: BusUnsubscribe[] = [];
  private readonly installers = new Set<OspfRoutesInstaller>();

  constructor(
    private readonly bus: IEventBus,
    private readonly engine: OSPFEngine,
  ) {}

  /**
   * Register an install callback. Returns an unsubscription function.
   * Multiple installers can coexist; they all receive the same routes.
   */
  onRoutes(installer: OspfRoutesInstaller): () => void {
    this.installers.add(installer);
    return () => this.installers.delete(installer);
  }

  start(): void {
    if (this.subscriptions.length > 0) return;

    const isOurs = (e: { routerId: string; processId: number }) =>
      e.routerId === this.engine.getRouterId() &&
      e.processId === this.engine.getProcessId();

    this.subscriptions.push(
      this.bus.subscribeWhere('ospf.routes-recomputed', isOurs, (e) => {
        const routes = e.payload.routes;
        for (const installer of this.installers) {
          try {
            installer(routes);
          } catch (err) {
            console.error('[RoutingTableSyncActor] installer threw:', err);
          }
        }
      }),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }

  /** Test convenience: number of registered installers. */
  installerCount(): number {
    return this.installers.size;
  }
}
