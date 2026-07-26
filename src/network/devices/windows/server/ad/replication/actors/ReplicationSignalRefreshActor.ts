/**
 * ReplicationSignalRefreshActor — the only writer of a
 * `ReplicationSignalStore` (PRD-Windows-Server-Advanced.md §5 P12):
 * `replicateFrom`/`installADDSDomainController`/`ReplicationServerHandler`
 * only publish `replication.*` events onto the bus, this actor subscribes
 * and projects them into the store, filtered by `deviceId` so multiple DCs
 * on a shared bus stay isolated — mirrors `DHCPClientSignalRefreshActor`'s
 * shape.
 */
import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { ReplicationSignalStore } from '../observables';
import type { ReplicationLogEntry } from '../ReplicationSession';

export class ReplicationSignalRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly store: ReplicationSignalStore,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;

    const isOurs = (e: { deviceId: string }) => e.deviceId === this.deviceId;

    this.subscriptions.push(
      this.bus.subscribeWhere('replication.pull.completed', isOurs, (e) => {
        const entry: ReplicationLogEntry = {
          timestamp: Math.floor(Date.now() / 1000), partnerAddress: e.payload.partnerAddress,
          applied: e.payload.applied, ok: true, siteRelation: e.payload.siteRelation, direction: 'inbound',
          remoteInvocationId: e.payload.remoteInvocationId,
        };
        this.store.recordPull(entry);
      }),
      this.bus.subscribeWhere('replication.pull.failed', isOurs, (e) => {
        const entry: ReplicationLogEntry = {
          timestamp: Math.floor(Date.now() / 1000), partnerAddress: e.payload.partnerAddress,
          applied: 0, ok: false, siteRelation: e.payload.siteRelation, direction: 'inbound', error: e.payload.error,
        };
        this.store.recordPull(entry);
      }),
      this.bus.subscribeWhere('replication.served', isOurs, (e) => {
        const entry: ReplicationLogEntry = {
          timestamp: Math.floor(Date.now() / 1000), partnerAddress: e.payload.partnerAddress,
          applied: e.payload.changesSent, ok: true, siteRelation: e.payload.siteRelation, direction: 'outbound',
        };
        this.store.recordServed(entry);
      }),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
