/**
 * NATCaptureActor — opt-in tcpdump-like recorder for NAT.
 *
 * Subscribes to every nat.* topic. Useful for `show ip nat
 * translations live`, replay scenarios, or telemetry exporters.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';

export type CapturedNatKind =
  | 'engine-configured'
  | 'session-created'
  | 'session-removed'
  | 'translation-applied'
  | 'tcp-state-changed'
  | 'stale-sweeped';

export interface CapturedNatEntry {
  readonly kind: CapturedNatKind;
  readonly timestamp: number;
  readonly deviceId: string;
  readonly payload: Record<string, unknown>;
}

export interface NatCaptureFilter {
  readonly deviceId?: string;
  readonly kind?: CapturedNatKind;
  /** Match local IP for session events. */
  readonly localIp?: string;
}

export class NATCaptureActor {
  private readonly subscriptions: BusUnsubscribe[] = [];
  private readonly buffer: CapturedNatEntry[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly maxEntries: number = 1000,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;
    this.subscriptions.push(
      this.bus.subscribe('nat.engine.configured', (e) => this.append('engine-configured', e.payload)),
      this.bus.subscribe('nat.session.created', (e) => this.append('session-created', e.payload)),
      this.bus.subscribe('nat.session.removed', (e) => this.append('session-removed', e.payload)),
      this.bus.subscribe('nat.translation.applied', (e) => this.append('translation-applied', e.payload)),
      this.bus.subscribe('nat.tcp.state-changed', (e) => this.append('tcp-state-changed', e.payload)),
      this.bus.subscribe('nat.stale.sweeped', (e) => this.append('stale-sweeped', e.payload)),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }

  size(): number { return this.buffer.length; }
  clear(): void { this.buffer.length = 0; }

  getCapture(filter?: NatCaptureFilter): CapturedNatEntry[] {
    if (!filter) return [...this.buffer];
    return this.buffer.filter((e) => {
      if (filter.deviceId !== undefined && e.deviceId !== filter.deviceId) return false;
      if (filter.kind !== undefined && e.kind !== filter.kind) return false;
      if (filter.localIp !== undefined) {
        const ip = (e.payload as { localIp?: string }).localIp;
        if (ip !== filter.localIp) return false;
      }
      return true;
    });
  }

  private append(kind: CapturedNatKind, payload: Record<string, unknown>): void {
    const deviceId = (payload as { deviceId?: string }).deviceId ?? '';
    this.buffer.push({ kind, timestamp: Date.now(), deviceId, payload });
    if (this.buffer.length > this.maxEntries) {
      this.buffer.splice(0, Math.floor(this.maxEntries / 2));
    }
  }
}
