/**
 * OSPFv3SignalRefreshActor — keeps the v3 read-model signals in sync.
 *
 * OSPFv3's reactive surface is smaller than v2's because v3 doesn't
 * (yet) implement SPF / Router-LSA origination / Network-LSA origination
 * inside the engine. What it *does* expose reactively is:
 *   - neighbor FSM transitions (Hello-driven) → ospf.neighbor.state-changed
 *   - DR/BDR election → ospf.dr-election
 *   - interface state transitions → ospf.interface.state-changed
 *   - LSA mutations (installLSA) → ospf.lsa.installed
 *   - packet egress / ingress → ospf.packet.outgoing / received
 *
 * This actor refreshes:
 *   - `neighbors` signal on neighbor.state-changed
 *   - `interfaces` signal on dr-election / interface.state-changed /
 *     neighbor.state-changed
 *   - `runtime` signal on every adjacency / interface mutation
 *   - `lsdbSummary` signal on every LSA mutation
 *
 * Filtered by `routerId + processId` so multiple engines on a shared
 * bus don't pollute each other.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { OSPFv3Engine } from '../OSPFv3Engine';

export class OSPFv3SignalRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly engine: OSPFv3Engine,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;

    const isOurs = (e: { routerId: string; processId: number }) =>
      e.routerId === this.engine.getRouterId() &&
      e.processId === this.engine.getProcessId();

    this.subscriptions.push(
      this.bus.subscribeWhere('ospf.neighbor.state-changed', isOurs, () => {
        this.engine._refreshAllSignals();
      }),
      this.bus.subscribeWhere('ospf.dr-election', isOurs, () => {
        this.engine._refreshInterfaceNeighborSignals();
      }),
      this.bus.subscribeWhere('ospf.interface.state-changed', isOurs, () => {
        this.engine._refreshInterfaceRuntimeSignals();
      }),
      this.bus.subscribeWhere('ospf.lsa.installed', isOurs, () => {
        this.engine._refreshLSDBSignal();
      }),
      this.bus.subscribeWhere('ospf.lsa.flushed', isOurs, () => {
        this.engine._refreshLSDBSignal();
      }),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
