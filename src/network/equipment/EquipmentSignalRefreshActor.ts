/**
 * EquipmentSignalRefreshActor — keeps the base `Equipment` read-models in sync.
 *
 * Subscribes to the `device.*` and `port.*` topics that change a device's
 * detail / ports view-models and republishes the relevant signals. Filtered by
 * device id so multiple devices on a shared bus stay isolated.
 *
 * Same shape and lifecycle (`start` / `stop`) as `HostSignalRefreshActor`.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';

/**
 * Minimal slice of `Equipment` the actor depends on. Passing an interface (not
 * the class) avoids a circular import with the device hierarchy.
 */
export interface EquipmentRefreshTarget {
  getId(): string;
  _refreshDetailSignal(): void;
  _refreshPortsSignal(): void;
}

export class EquipmentSignalRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly device: EquipmentRefreshTarget,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;
    const id = this.device.getId();
    // `device.*` payloads carry `id`; `port.*` payloads carry `deviceId`.
    const byId = (e: { id?: string }) => e.id === id;
    const byDeviceId = (e: { deviceId?: string }) => e.deviceId === id;

    this.subscriptions.push(
      // Identity / power → detail VM
      this.bus.subscribeWhere('device.power-on', byId, () => this.device._refreshDetailSignal()),
      this.bus.subscribeWhere('device.power-off', byId, () => this.device._refreshDetailSignal()),
      this.bus.subscribeWhere('device.renamed', byId, () => this.device._refreshDetailSignal()),
      // Port link / addressing → ports VM
      this.bus.subscribeWhere('port.link.up', byDeviceId, () => this.device._refreshPortsSignal()),
      this.bus.subscribeWhere('port.link.down', byDeviceId, () => this.device._refreshPortsSignal()),
      this.bus.subscribeWhere('port.config.ip-changed', byDeviceId, () => this.device._refreshPortsSignal()),
      this.bus.subscribeWhere('port.config.ipv6-added', byDeviceId, () => this.device._refreshPortsSignal()),
      this.bus.subscribeWhere('port.config.ipv6-removed', byDeviceId, () => this.device._refreshPortsSignal()),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
