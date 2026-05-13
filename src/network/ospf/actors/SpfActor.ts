/**
 * SpfActor — reactive SPF scheduler.
 *
 * Owns the rule that decides *when* to (re)compute SPF. Subscribes to:
 *   - `ospf.lsa.installed`     → full SPF if Type 1/2 LSA, partial otherwise
 *   - `ospf.lsa.flushed`       → full SPF (LSDB topology shrunk)
 *   - `ospf.neighbor.state-changed` → SPF on Full ↔ X transitions
 *
 * Before the reactive refactor, this routing logic was scattered in
 * `OSPFEngine.installLSA`, `OSPFEngine.tickLSAge`, and
 * `OSPFEngine.neighborEvent`. Centralising it here makes:
 *   - the policy testable in isolation;
 *   - new triggers (e.g. LSA-refreshed, route-redistribution) trivial
 *     to add as additional subscriptions, without touching the engine.
 *
 * The actor calls back into `engine.scheduleSPF(isTopologyChange)` —
 * the engine's existing throttle/debounce logic stays in place.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { OSPFEngine } from '../OSPFEngine';

export class SpfActor {
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
      // LSA installed → full SPF for topology LSAs (Type 1/2), partial otherwise.
      this.bus.subscribeWhere('ospf.lsa.installed', isOurs, (e) => {
        const lsType = e.payload.lsa.lsType;
        const isTopologyChange = lsType === 1 || lsType === 2;
        this.engine.scheduleSPF(isTopologyChange);
      }),
      // LSA aged out → topology shrank, full SPF.
      this.bus.subscribeWhere('ospf.lsa.flushed', isOurs, () => {
        this.engine.scheduleSPF(true);
      }),
      // Neighbor crossed Full boundary → adjacency change → full SPF.
      this.bus.subscribeWhere('ospf.neighbor.state-changed', isOurs, (e) => {
        const wasFull = e.payload.oldState === 'Full';
        const isFull = e.payload.newState === 'Full';
        if (wasFull !== isFull) {
          this.engine.scheduleSPF(true);
        }
      }),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
