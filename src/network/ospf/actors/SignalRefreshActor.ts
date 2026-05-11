/**
 * SignalRefreshActor — reactive projector for OSPF read-models.
 *
 * Subscribes to the engine's `ospf.*` events and republishes the
 * appropriate `OspfObservables` signals. The engine itself no longer
 * calls `rebuildNeighborSignal()` / `rebuildLSDBSignal()` / etc. inline
 * — it just emits, and this actor reacts.
 *
 * Why this matters: a brand-new feature (capture, IDS, alerting,
 * UI panel) only has to subscribe to the same events; it doesn't have
 * to be added to every mutation site of the engine. That is the
 * pay-off of the reactive inversion.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { OSPFEngine } from '../OSPFEngine';

export class SignalRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly engine: OSPFEngine,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return; // idempotent

    // Identity is read lazily because `setRouterId()` may be called
    // after the actor is constructed.
    const isOurs = (e: { routerId: string; processId: number }) =>
      e.routerId === this.engine.getRouterId() &&
      e.processId === this.engine.getProcessId();

    this.subscriptions.push(
      // FSM transitions → neighbors + interfaces + runtime
      this.bus.subscribeWhere('ospf.neighbor.state-changed', isOurs, () => {
        this.engine._refreshNeighborInterfaceRuntimeSignals();
      }),
      // DR election → interfaces + neighbors (DR/BDR flags)
      this.bus.subscribeWhere('ospf.dr-election', isOurs, () => {
        this.engine._refreshInterfaceNeighborSignals();
      }),
      // Interface state-machine transitions → interfaces signal
      this.bus.subscribeWhere('ospf.interface.state-changed', isOurs, () => {
        this.engine._refreshInterfaceSignal();
      }),
      // LSDB mutations → lsdbSummary
      this.bus.subscribeWhere('ospf.lsa.installed', isOurs, () => {
        this.engine._refreshLSDBSignal();
      }),
      this.bus.subscribeWhere('ospf.lsa.flushed', isOurs, () => {
        this.engine._refreshLSDBSignal();
      }),
      this.bus.subscribeWhere('ospf.lsa.refreshed', isOurs, () => {
        this.engine._refreshLSDBSignal();
      }),
      // SPF run → routes + runtime
      this.bus.subscribeWhere('ospf.spf.run', isOurs, (e) => {
        this.engine._refreshRoutesAndRuntimeSignals(e.payload.runtimeMs);
      }),
      // Routes change without SPF (rare) → routes
      this.bus.subscribeWhere('ospf.routes-recomputed', isOurs, () => {
        this.engine._refreshRoutesSignal();
      }),
      // Area activation → runtime stats refresh
      this.bus.subscribeWhere('ospf.area.activated', isOurs, () => {
        this.engine._refreshRuntimeSignal();
      }),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
