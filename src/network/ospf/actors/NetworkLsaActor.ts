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
        if (iface.dr !== iface.ipAddress) return;
        this.engine.originateNetworkLSA(iface);
      }),
      this.bus.subscribeWhere('ospf.neighbor.state-changed', isOurs, (e) => {
        const wasFull = e.payload.oldState === 'Full';
        const isFull = e.payload.newState === 'Full';
        if (wasFull === isFull) return;
        const iface = this.engine.getInterface(e.payload.iface);
        if (!iface) return;
        this.engine.originateNetworkLSA(iface);
      }),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
