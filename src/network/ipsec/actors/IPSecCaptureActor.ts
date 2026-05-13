/**
 * IPSecCaptureActor — opt-in tcpdump-like recorder for IPSec.
 *
 * Subscribes to the chain outcomes (`ipsec.inbound.outcome`,
 * `ipsec.outbound.outcome`), the SA lifecycle events
 * (`ipsec.ike.sa-installed/deleted`, `ipsec.sa.installed/deleted`)
 * and the DPD events (`ipsec.dpd.request-sent`,
 * `ipsec.dpd.peer-down`). Maintains a bounded ring buffer.
 *
 * NOT instantiated by default — like `OspfCaptureActor`, this is a
 * composition primitive: instantiate it on the engine's bus when
 * capture is needed (CLI command, replay, snapshot test).
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';

export type CapturedIpsecKind =
  | 'inbound-outcome'
  | 'outbound-outcome'
  | 'ike-sa-installed'
  | 'ike-sa-deleted'
  | 'ipsec-sa-installed'
  | 'ipsec-sa-deleted'
  | 'dpd-request'
  | 'dpd-peer-down';

export interface CapturedIpsecEntry {
  readonly kind: CapturedIpsecKind;
  readonly timestamp: number;
  readonly deviceId: string;
  /** Free-form payload (varies per kind). */
  readonly payload: Record<string, unknown>;
}

export interface IPSecCaptureFilter {
  readonly deviceId?: string;
  readonly kind?: CapturedIpsecKind;
}

export class IPSecCaptureActor {
  private readonly subscriptions: BusUnsubscribe[] = [];
  private readonly buffer: CapturedIpsecEntry[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly maxEntries: number = 1000,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;
    this.subscriptions.push(
      this.bus.subscribe('ipsec.inbound.outcome', (e) => this.append('inbound-outcome', e.payload)),
      this.bus.subscribe('ipsec.outbound.outcome', (e) => this.append('outbound-outcome', e.payload)),
      this.bus.subscribe('ipsec.ike.sa-installed', (e) => this.append('ike-sa-installed', e.payload)),
      this.bus.subscribe('ipsec.ike.sa-deleted', (e) => this.append('ike-sa-deleted', e.payload)),
      this.bus.subscribe('ipsec.sa.installed', (e) => this.append('ipsec-sa-installed', e.payload)),
      this.bus.subscribe('ipsec.sa.deleted', (e) => this.append('ipsec-sa-deleted', e.payload)),
      this.bus.subscribe('ipsec.dpd.request-sent', (e) => this.append('dpd-request', e.payload)),
      this.bus.subscribe('ipsec.dpd.peer-down', (e) => this.append('dpd-peer-down', e.payload)),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }

  size(): number {
    return this.buffer.length;
  }

  getCapture(filter?: IPSecCaptureFilter): CapturedIpsecEntry[] {
    if (!filter) return [...this.buffer];
    return this.buffer.filter((e) => {
      if (filter.deviceId !== undefined && e.deviceId !== filter.deviceId) return false;
      if (filter.kind !== undefined && e.kind !== filter.kind) return false;
      return true;
    });
  }

  clear(): void {
    this.buffer.length = 0;
  }

  private append(kind: CapturedIpsecKind, payload: Record<string, unknown> | { deviceId?: string }): void {
    const deviceId = (payload as { deviceId?: string }).deviceId ?? '';
    this.buffer.push({
      kind,
      timestamp: Date.now(),
      deviceId,
      payload: payload as Record<string, unknown>,
    });
    if (this.buffer.length > this.maxEntries) {
      this.buffer.splice(0, Math.floor(this.maxEntries / 2));
    }
  }
}
