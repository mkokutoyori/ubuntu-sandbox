/**
 * HelloActor — reactive sender of OSPFv2 Hello packets.
 *
 * The engine's per-interface Hello timer used to call `sendHello(iface)`
 * directly. Now it just emits `ospf.hello.send-requested { iface }`
 * and this actor performs the build+send.
 *
 * Why this matters:
 *  - tests can intercept "the engine wants to send a Hello" without
 *    touching the data plane;
 *  - alternative Hello policies (authenticated, padded, jittered)
 *    plug in by replacing this actor;
 *  - capture sees the *intent* to send before the actual packet
 *    publication on `ospf.packet.outgoing`.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { OSPFEngine } from '../OSPFEngine';

export class HelloActor {
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
      this.bus.subscribeWhere('ospf.hello.send-requested', isOurs, (e) => {
        this.engine.sendHelloOnInterface(e.payload.iface);
      }),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
