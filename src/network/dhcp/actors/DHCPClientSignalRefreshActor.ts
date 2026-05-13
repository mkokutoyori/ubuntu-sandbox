/**
 * DHCPClientSignalRefreshActor — refreshes the DHCP client's
 * ifaces / stats signals on every relevant bus event.
 *
 * Filtered by `deviceId` so multiple clients on a shared bus stay
 * isolated.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { DHCPClient } from '../DHCPClient';

export class DHCPClientSignalRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly client: DHCPClient,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;

    const isOurs = (e: { deviceId?: string }) =>
      e.deviceId === this.client.getDeviceId();

    this.subscriptions.push(
      this.bus.subscribeWhere('dhcp.engine.started', isOurs, () => this.client._refreshAll()),
      this.bus.subscribeWhere('dhcp.engine.stopped', isOurs, () => this.client._refreshAll()),
      this.bus.subscribeWhere('dhcp.client.state-changed', isOurs, () => this.client._refreshAll()),
      this.bus.subscribeWhere('dhcp.lease.granted', isOurs, () => this.client._refreshAll()),
      this.bus.subscribeWhere('dhcp.lease.renewing', isOurs, () => this.client._refreshAll()),
      this.bus.subscribeWhere('dhcp.lease.rebinding', isOurs, () => this.client._refreshAll()),
      this.bus.subscribeWhere('dhcp.lease.expired', isOurs, () => this.client._refreshAll()),
      this.bus.subscribeWhere('dhcp.lease.released', isOurs, () => this.client._refreshAll()),
      this.bus.subscribeWhere('dhcp.discover.sent', isOurs, () => this.client._refreshStats()),
      this.bus.subscribeWhere('dhcp.offer.received', isOurs, () => this.client._refreshStats()),
      this.bus.subscribeWhere('dhcp.request.sent', isOurs, () => this.client._refreshStats()),
      this.bus.subscribeWhere('dhcp.ack.received', isOurs, () => this.client._refreshStats()),
      this.bus.subscribeWhere('dhcp.nak.received', isOurs, () => this.client._refreshStats()),
      this.bus.subscribeWhere('dhcp.address-conflict', isOurs, () => this.client._refreshStats()),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
