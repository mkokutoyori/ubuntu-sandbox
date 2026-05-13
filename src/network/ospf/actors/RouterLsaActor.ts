/**
 * RouterLsaActor — re-originates the local Router-LSA in response to
 * topology-relevant events.
 *
 * Subscribes to `ospf.neighbor.state-changed` and re-originates the
 * router's own Router-LSA whenever a neighbor crosses the Full
 * boundary on either side, so that the LSA reflects the current set of
 * fully-adjacent neighbors per RFC 2328 §12.4.1.
 *
 * Before the reactive refactor this re-origination was hard-coded
 * inside `OSPFEngine.neighborEvent`. Lifting it into an actor:
 *   - decouples "*what* changed" (an event) from "*how* we react"
 *     (re-originate Router-LSA);
 *   - allows alternative or extra reactions (route redistribution,
 *     external-LSA invalidation, telemetry) to be plugged in as
 *     siblings without modifying the engine.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { OSPFEngine } from '../OSPFEngine';

export class RouterLsaActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly engine: OSPFEngine,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;

    const isOurs = (e: { routerId: string; processId: number }) =>
      e.routerId === this.engine.getRouterId() &&
      e.processId === this.engine.getProcessId();

    this.subscriptions.push(
      this.bus.subscribeWhere('ospf.neighbor.state-changed', isOurs, (e) => {
        const wasFull = e.payload.oldState === 'Full';
        const isFull = e.payload.newState === 'Full';
        if (wasFull === isFull) return; // crossed neither way

        // Look up the area for the interface. The engine exposes a
        // public lookup; if it can't find the iface we silently skip
        // (the interface may have been torn down concurrently).
        const areaId = this.engine.getInterfaceAreaId(e.payload.iface);
        if (!areaId) return;
        this.engine.originateRouterLSA(areaId);
      }),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
