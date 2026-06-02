/**
 * HostCaptureActor — opt-in tcpdump-style recorder for host (L3/L4)
 * domain events.
 *
 * Subscribes to every `host.*` topic and keeps a bounded ring buffer.
 * Useful for `show arp / show route / netstat / show icmp` live
 * commands, replay scenarios, and §11.2.5 trace snapshots.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';

export type CapturedHostKind =
  | 'arp-learned' | 'arp-expired' | 'arp-request-sent'
  | 'ndp-learned' | 'ndp-expired'
  | 'route-added' | 'route-removed'
  | 'icmp-echo-sent' | 'icmp-echo-reply' | 'icmp-echo-timeout'
  | 'icmp-unreachable'
  | 'tcp-listener-started' | 'tcp-listener-stopped'
  | 'tcp-connection-established' | 'tcp-connection-closed'
  | 'l3-tx-requested';

export interface CapturedHostEntry {
  readonly kind: CapturedHostKind;
  readonly timestamp: number;
  readonly deviceId: string;
  readonly payload: Record<string, unknown>;
}

export interface HostCaptureFilter {
  readonly deviceId?: string;
  readonly kind?: CapturedHostKind;
  readonly iface?: string;
  /** Match an IP — checked against any 'fromIp', 'toIp', 'ip' field. */
  readonly ip?: string;
}

export class HostCaptureActor {
  private readonly subscriptions: BusUnsubscribe[] = [];
  private readonly buffer: CapturedHostEntry[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly maxEntries: number = 1000,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;
    this.subscriptions.push(
      this.bus.subscribe('host.arp.entry-learned', (e) => this.append('arp-learned', e.payload)),
      this.bus.subscribe('host.arp.entry-expired', (e) => this.append('arp-expired', e.payload)),
      this.bus.subscribe('host.arp.request-sent', (e) => this.append('arp-request-sent', e.payload)),
      this.bus.subscribe('host.ndp.entry-learned', (e) => this.append('ndp-learned', e.payload)),
      this.bus.subscribe('host.ndp.entry-expired', (e) => this.append('ndp-expired', e.payload)),
      this.bus.subscribe('host.routing.route-added', (e) => this.append('route-added', e.payload)),
      this.bus.subscribe('host.routing.route-removed', (e) => this.append('route-removed', e.payload)),
      this.bus.subscribe('host.icmp.echo-sent', (e) => this.append('icmp-echo-sent', e.payload)),
      this.bus.subscribe('host.icmp.echo-reply', (e) => this.append('icmp-echo-reply', e.payload)),
      this.bus.subscribe('host.icmp.echo-timeout', (e) => this.append('icmp-echo-timeout', e.payload)),
      this.bus.subscribe('host.icmp.unreachable', (e) => this.append('icmp-unreachable', e.payload)),
      this.bus.subscribe('tcp.listener.changed', (e) => {
        this.append(e.payload.added ? 'tcp-listener-started' : 'tcp-listener-stopped', e.payload);
      }),
      this.bus.subscribe('tcp.connection.opened', (e) => this.append('tcp-connection-established', e.payload)),
      this.bus.subscribe('tcp.connection.closed', (e) => this.append('tcp-connection-closed', e.payload)),
      this.bus.subscribe('host.l3.packet-tx-requested', (e) => this.append('l3-tx-requested', e.payload)),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }

  size(): number { return this.buffer.length; }
  clear(): void { this.buffer.length = 0; }

  getCapture(filter?: HostCaptureFilter): CapturedHostEntry[] {
    if (!filter) return [...this.buffer];
    return this.buffer.filter((e) => {
      if (filter.deviceId !== undefined && e.deviceId !== filter.deviceId) return false;
      if (filter.kind !== undefined && e.kind !== filter.kind) return false;
      if (filter.iface !== undefined) {
        const iface = (e.payload as { iface?: string }).iface;
        if (iface !== filter.iface) return false;
      }
      if (filter.ip !== undefined) {
        const p = e.payload as { ip?: string; fromIp?: string; toIp?: string };
        if (p.ip !== filter.ip && p.fromIp !== filter.ip && p.toIp !== filter.ip) return false;
      }
      return true;
    });
  }

  private append(kind: CapturedHostKind, payload: Record<string, unknown>): void {
    const deviceId = (payload as { deviceId?: string }).deviceId ?? '';
    this.buffer.push({ kind, timestamp: Date.now(), deviceId, payload });
    if (this.buffer.length > this.maxEntries) {
      this.buffer.splice(0, Math.floor(this.maxEntries / 2));
    }
  }
}
