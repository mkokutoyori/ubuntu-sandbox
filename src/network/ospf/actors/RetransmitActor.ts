/**
 * RetransmitActor — reactive DD/LSR retransmissions.
 *
 * Before this actor, the engine ran two flavours of inline retransmit
 * timers (`startDDRetransmitTimer`, `startLSRRetransmitTimer`) that
 * directly re-sent packets after `RxmtInterval` seconds. Now those
 * timers only emit:
 *   - `ospf.dd.retransmit-due { iface, neighborId }`
 *   - `ospf.lsr.retransmit-due { iface, neighborId }`
 * and this actor performs the actual retransmission via the engine's
 * public retransmit entry points.
 *
 * Decoupling rationale:
 *   - retransmit policy (linear, exponential, max-retries) becomes a
 *     plug-in property of the actor, not of the engine;
 *   - replay scenarios can trace exactly when retransmits would have
 *     fired;
 *   - tests can suppress retransmits by stopping just this actor.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { OSPFEngine } from '../OSPFEngine';

export class RetransmitActor {
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
      this.bus.subscribeWhere('ospf.dd.retransmit-due', isOurs, (e) => {
        this.engine._executeDDRetransmit(e.payload.iface, e.payload.neighborId);
      }),
      this.bus.subscribeWhere('ospf.lsr.retransmit-due', isOurs, (e) => {
        this.engine.triggerLSRRetransmit(e.payload.iface, e.payload.neighborId);
      }),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
