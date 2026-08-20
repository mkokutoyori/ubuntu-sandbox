/**
 * AdcsSignalRefreshActor — the only writer of an `AdcsSignalStore` (PRD-
 * Windows-Server-Advanced.md §5 P23): `WindowsAdcsRole` only publishes
 * `adcs.*` events onto the bus, this actor subscribes and projects them
 * into the store, filtered by `deviceId` — mirrors
 * `KerberosSignalRefreshActor`'s shape.
 */
import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { AdcsSignalStore } from '../observables';

export class AdcsSignalRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly store: AdcsSignalStore,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;
    this.subscriptions.push(
      this.bus.subscribeWhere('adcs.certificate.issued', (e) => e.deviceId === this.deviceId, (e) =>
        this.store.recordCertificateIssued(e.payload.subject, e.payload.templateName, e.payload.serialNumber)),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
