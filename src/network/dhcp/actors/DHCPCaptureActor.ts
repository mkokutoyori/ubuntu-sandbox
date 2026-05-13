/**
 * DHCPCaptureActor — opt-in tcpdump-like recorder for DHCP.
 *
 * Subscribes to every DHCP topic emitted by client and server. NOT
 * instantiated by default — composed externally when capture is
 * needed (CLI command, replay, snapshot test).
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';

export type CapturedDhcpKind =
  | 'engine-started'
  | 'engine-stopped'
  | 'client-state-changed'
  | 'discover-sent'
  | 'offer-received'
  | 'request-sent'
  | 'ack-received'
  | 'nak-received'
  | 'lease-granted'
  | 'lease-renewing'
  | 'lease-rebinding'
  | 'lease-expired'
  | 'lease-released'
  | 'decline-sent'
  | 'address-conflict'
  | 'pool-lease-allocated'
  | 'pool-lease-released'
  | 'reservation-added';

export interface CapturedDhcpEntry {
  readonly kind: CapturedDhcpKind;
  readonly timestamp: number;
  readonly deviceId: string;
  readonly payload: Record<string, unknown>;
}

export interface DhcpCaptureFilter {
  readonly deviceId?: string;
  readonly iface?: string;
  readonly kind?: CapturedDhcpKind;
}

export class DHCPCaptureActor {
  private readonly subscriptions: BusUnsubscribe[] = [];
  private readonly buffer: CapturedDhcpEntry[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly maxEntries: number = 1000,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;
    const sub = (kind: CapturedDhcpKind, topic:
      | 'dhcp.engine.started' | 'dhcp.engine.stopped'
      | 'dhcp.client.state-changed'
      | 'dhcp.discover.sent' | 'dhcp.offer.received'
      | 'dhcp.request.sent' | 'dhcp.ack.received'
      | 'dhcp.nak.received'
      | 'dhcp.lease.granted' | 'dhcp.lease.renewing'
      | 'dhcp.lease.rebinding' | 'dhcp.lease.expired'
      | 'dhcp.lease.released'
      | 'dhcp.decline.sent' | 'dhcp.address-conflict'
      | 'dhcp.pool.lease-allocated' | 'dhcp.pool.lease-released'
      | 'dhcp.reservation.added',
    ) => this.bus.subscribe(topic, (e) => this.append(kind, e.payload));

    this.subscriptions.push(
      sub('engine-started', 'dhcp.engine.started'),
      sub('engine-stopped', 'dhcp.engine.stopped'),
      sub('client-state-changed', 'dhcp.client.state-changed'),
      sub('discover-sent', 'dhcp.discover.sent'),
      sub('offer-received', 'dhcp.offer.received'),
      sub('request-sent', 'dhcp.request.sent'),
      sub('ack-received', 'dhcp.ack.received'),
      sub('nak-received', 'dhcp.nak.received'),
      sub('lease-granted', 'dhcp.lease.granted'),
      sub('lease-renewing', 'dhcp.lease.renewing'),
      sub('lease-rebinding', 'dhcp.lease.rebinding'),
      sub('lease-expired', 'dhcp.lease.expired'),
      sub('lease-released', 'dhcp.lease.released'),
      sub('decline-sent', 'dhcp.decline.sent'),
      sub('address-conflict', 'dhcp.address-conflict'),
      sub('pool-lease-allocated', 'dhcp.pool.lease-allocated'),
      sub('pool-lease-released', 'dhcp.pool.lease-released'),
      sub('reservation-added', 'dhcp.reservation.added'),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }

  size(): number { return this.buffer.length; }
  clear(): void { this.buffer.length = 0; }

  getCapture(filter?: DhcpCaptureFilter): CapturedDhcpEntry[] {
    if (!filter) return [...this.buffer];
    return this.buffer.filter((e) => {
      if (filter.deviceId !== undefined && e.deviceId !== filter.deviceId) return false;
      if (filter.kind !== undefined && e.kind !== filter.kind) return false;
      if (filter.iface !== undefined) {
        const ifaceField = (e.payload as { iface?: string }).iface;
        if (ifaceField !== filter.iface) return false;
      }
      return true;
    });
  }

  private append(kind: CapturedDhcpKind, payload: Record<string, unknown>): void {
    const deviceId = (payload as { deviceId?: string }).deviceId ?? '';
    this.buffer.push({ kind, timestamp: Date.now(), deviceId, payload });
    if (this.buffer.length > this.maxEntries) {
      this.buffer.splice(0, Math.floor(this.maxEntries / 2));
    }
  }
}
