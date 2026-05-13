/**
 * NetworkLsaActor — Network-LSA origination on DR election.
 *
 * RFC 2328 §12.4.2: only the Designated Router originates a Network-LSA
 * for the segment. Whenever a DR election concludes with this engine
 * being the elected DR for an interface, this actor calls
 * `engine.originateNetworkLSA(iface)`.
 *
 * Subscribes to `ospf.dr-election` and uses the engine's interface
 * lookup to retrieve the live `OSPFInterface` object before delegating.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { OSPFEngine } from '../OSPFEngine';

export class NetworkLsaActor {
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
      this.bus.subscribeWhere('ospf.dr-election', isOurs, (e) => {
        const iface = this.engine.getInterface(e.payload.iface);
        if (!iface) return;
        // We are the DR if our IP is the elected DR. Network-LSA is
        // only originated by the DR.
        if (iface.dr !== iface.ipAddress) return;
        this.engine.originateNetworkLSA(iface);
      }),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
