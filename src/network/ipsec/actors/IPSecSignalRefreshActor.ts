/**
 * IPSecSignalRefreshActor — keeps the IPSec read-models in sync.
 *
 * Subscribes to the engine's `ipsec.*` events and republishes the
 * appropriate signals (ikeSAs, ipsecSAs, fragGroups, stats). The
 * engine itself only emits — this actor reacts and projects.
 *
 * Filtered by `deviceId` so multiple engines on a shared bus stay
 * isolated.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { IPSecEngine } from '../IPSecEngine';

export class IPSecSignalRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly engine: IPSecEngine,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;

    const isOurs = (e: { deviceId?: string }) =>
      e.deviceId === this.engine.getDeviceId();

    // Engine lifecycle → stats
    this.subscriptions.push(
      this.bus.subscribeWhere('ipsec.engine.started', isOurs, () => this.engine._refreshAllSignals()),
      this.bus.subscribeWhere('ipsec.engine.stopped', isOurs, () => this.engine._refreshAllSignals()),
      // SA install / delete → ikeSAs / ipsecSAs / stats
      this.bus.subscribeWhere('ipsec.ike.sa-installed', isOurs, () => this.engine._refreshAllSignals()),
      this.bus.subscribeWhere('ipsec.ike.sa-deleted', isOurs, () => this.engine._refreshAllSignals()),
      this.bus.subscribeWhere('ipsec.sa.installed', isOurs, () => this.engine._refreshAllSignals()),
      this.bus.subscribeWhere('ipsec.sa.deleted', isOurs, () => this.engine._refreshAllSignals()),
      // Fragment timeouts → fragGroups + stats
      this.bus.subscribeWhere('ipsec.fragment.timeout', isOurs, () => this.engine._refreshFragGroupsAndStats()),
      // Inbound / outbound chain outcomes → stats
      this.bus.subscribeWhere('ipsec.inbound.outcome', isOurs, () => this.engine._refreshStatsSignal()),
      this.bus.subscribeWhere('ipsec.outbound.outcome', isOurs, () => this.engine._refreshStatsSignal()),
      // DPD peer-down → stats (peer count change indirect)
      this.bus.subscribeWhere('ipsec.dpd.peer-down', isOurs, () => this.engine._refreshAllSignals()),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
