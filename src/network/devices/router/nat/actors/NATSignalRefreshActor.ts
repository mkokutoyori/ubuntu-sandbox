/**
 * NATSignalRefreshActor — refreshes NAT signals from bus events.
 *
 * Filtered by `deviceId` so multiple routers on a shared bus stay
 * isolated.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { NATEngine } from '../../NATEngine';

export class NATSignalRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly engine: NATEngine,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;

    const isOurs = (e: { deviceId?: string }) =>
      e.deviceId === this.engine.getDeviceId();

    this.subscriptions.push(
      this.bus.subscribeWhere('nat.engine.configured', isOurs, () => this.engine._refreshAll()),
      this.bus.subscribeWhere('nat.session.created', isOurs, () => this.engine._refreshAll()),
      this.bus.subscribeWhere('nat.session.removed', isOurs, () => this.engine._refreshAll()),
      this.bus.subscribeWhere('nat.tcp.state-changed', isOurs, () => this.engine._refreshAll()),
      this.bus.subscribeWhere('nat.translation.applied', isOurs, () => this.engine._refreshStats()),
      this.bus.subscribeWhere('nat.stale.sweeped', isOurs, () => this.engine._refreshAll()),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
