/**
 * DfsSignalRefreshActor — the only writer of a `DfsSignalStore` (PRD-
 * Windows-Server-Advanced.md §5 P23): mirrors `ReplicationSignalRefreshActor`'s
 * shape, filtered by `deviceId`.
 */
import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { DfsSignalStore } from '../observables';

export class DfsSignalRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly store: DfsSignalStore,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;
    const isOurs = (e: { deviceId: string }) => e.deviceId === this.deviceId;
    this.subscriptions.push(
      this.bus.subscribeWhere('dfs.replication.synced', isOurs, (e) =>
        this.store.recordSynced(e.payload.groupName, e.payload.filesApplied)),
      this.bus.subscribeWhere('dfs.replication.failed', isOurs, (e) =>
        this.store.recordFailed(e.payload.groupName, e.payload.error)),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
