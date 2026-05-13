/**
 * HostSignalRefreshActor — keeps EndHost read-models in sync.
 *
 * Subscribes to the `host.*` topics emitted by `EndHost` and
 * republishes the relevant signals (arp, ndp, routes, tcpListeners,
 * tcpConnections, stats). Filtered by `deviceId` so multiple hosts
 * on a shared bus stay isolated.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';

/**
 * Minimal slice of `EndHost` the actor depends on. Avoiding a
 * circular type import keeps this file decoupled from the device
 * class hierarchy.
 */
export interface HostRefreshTarget {
  getId(): string;
  _refreshArpSignal(): void;
  _refreshNdpSignal(): void;
  _refreshRoutesSignal(): void;
  _refreshTcpSignal(): void;
  _refreshHostStatsSignal(): void;
}

export class HostSignalRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly host: HostRefreshTarget,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;

    const isOurs = (e: { deviceId?: string }) => e.deviceId === this.host.getId();

    this.subscriptions.push(
      // ARP / NDP
      this.bus.subscribeWhere('host.arp.entry-learned', isOurs, () => {
        this.host._refreshArpSignal();
        this.host._refreshHostStatsSignal();
      }),
      this.bus.subscribeWhere('host.arp.entry-expired', isOurs, () => {
        this.host._refreshArpSignal();
        this.host._refreshHostStatsSignal();
      }),
      this.bus.subscribeWhere('host.arp.request-sent', isOurs, () => {
        this.host._refreshHostStatsSignal();
      }),
      this.bus.subscribeWhere('host.ndp.entry-learned', isOurs, () => {
        this.host._refreshNdpSignal();
        this.host._refreshHostStatsSignal();
      }),
      this.bus.subscribeWhere('host.ndp.entry-expired', isOurs, () => {
        this.host._refreshNdpSignal();
        this.host._refreshHostStatsSignal();
      }),
      // Routing
      this.bus.subscribeWhere('host.routing.route-added', isOurs, () => {
        this.host._refreshRoutesSignal();
        this.host._refreshHostStatsSignal();
      }),
      this.bus.subscribeWhere('host.routing.route-removed', isOurs, () => {
        this.host._refreshRoutesSignal();
        this.host._refreshHostStatsSignal();
      }),
      // ICMP
      this.bus.subscribeWhere('host.icmp.echo-sent', isOurs, () => this.host._refreshHostStatsSignal()),
      this.bus.subscribeWhere('host.icmp.echo-reply', isOurs, () => this.host._refreshHostStatsSignal()),
      this.bus.subscribeWhere('host.icmp.echo-timeout', isOurs, () => this.host._refreshHostStatsSignal()),
      // TCP
      this.bus.subscribeWhere('host.tcp.listener-started', isOurs, () => {
        this.host._refreshTcpSignal();
        this.host._refreshHostStatsSignal();
      }),
      this.bus.subscribeWhere('host.tcp.listener-stopped', isOurs, () => {
        this.host._refreshTcpSignal();
        this.host._refreshHostStatsSignal();
      }),
      this.bus.subscribeWhere('host.tcp.connection-established', isOurs, () => {
        this.host._refreshTcpSignal();
        this.host._refreshHostStatsSignal();
      }),
      this.bus.subscribeWhere('host.tcp.connection-closed', isOurs, () => {
        this.host._refreshTcpSignal();
        this.host._refreshHostStatsSignal();
      }),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
