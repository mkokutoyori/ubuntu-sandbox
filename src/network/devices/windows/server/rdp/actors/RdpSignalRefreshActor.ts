/**
 * RdpSignalRefreshActor — the only writer of an `RdpSignalStore` (PRD-
 * Windows-Server-Advanced.md §5 P23): mirrors `KerberosSignalRefreshActor`'s
 * shape, filtered by `deviceId`.
 */
import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { RdpSignalStore } from '../observables';

export class RdpSignalRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly store: RdpSignalStore,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;
    const isOurs = (e: { deviceId: string }) => e.deviceId === this.deviceId;
    this.subscriptions.push(
      this.bus.subscribeWhere('rdp.session.established', isOurs, (e) =>
        this.store.recordSessionEstablished(e.payload.sessionId, e.payload.userName, e.payload.clientAddress)),
      this.bus.subscribeWhere('rdp.session.closed', isOurs, (e) => this.store.recordSessionClosed(e.payload.sessionId)),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
