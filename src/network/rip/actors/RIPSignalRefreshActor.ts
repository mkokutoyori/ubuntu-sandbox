/**
 * RIPSignalRefreshActor — refreshes RIP read-models from bus events.
 *
 * Subscribes to the engine's `rip.*` events and republishes signals.
 * Filtered by `deviceId` so multiple engines on a shared bus don't
 * pollute each other.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { RIPEngine } from '../RIPEngine';

export class RIPSignalRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly engine: RIPEngine,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;

    const isOurs = (e: { deviceId?: string }) =>
      e.deviceId === this.engine.getDeviceId();

    this.subscriptions.push(
      this.bus.subscribeWhere('rip.engine.started', isOurs, () => this.engine._refreshAllSignals()),
      this.bus.subscribeWhere('rip.engine.stopped', isOurs, () => this.engine._refreshAllSignals()),
      this.bus.subscribeWhere('rip.route.added', isOurs, () => this.engine._refreshAllSignals()),
      this.bus.subscribeWhere('rip.route.updated', isOurs, () => this.engine._refreshAllSignals()),
      this.bus.subscribeWhere('rip.route.timed-out', isOurs, () => this.engine._refreshAllSignals()),
      this.bus.subscribeWhere('rip.route.removed', isOurs, () => this.engine._refreshAllSignals()),
      this.bus.subscribeWhere('rip.update.sent', isOurs, () => this.engine._refreshStatsSignal()),
      this.bus.subscribeWhere('rip.update.received', isOurs, () => this.engine._refreshStatsSignal()),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
