/**
 * ClusterSignalRefreshActor — the only writer of a `ClusterSignalStore`
 * (PRD-Windows-Server-Advanced.md §5 P23): mirrors
 * `KerberosSignalRefreshActor`'s shape, filtered by `deviceId`.
 */
import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { ClusterSignalStore } from '../observables';

export class ClusterSignalRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly store: ClusterSignalStore,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;
    const isOurs = (e: { deviceId: string }) => e.deviceId === this.deviceId;
    this.subscriptions.push(
      this.bus.subscribeWhere('cluster.node.up', isOurs, (e) => this.store.recordNodeUp(e.payload.nodeName)),
      this.bus.subscribeWhere('cluster.node.down', isOurs, (e) => this.store.recordNodeDown(e.payload.nodeName)),
      this.bus.subscribeWhere('cluster.group.moved', isOurs, (e) =>
        this.store.recordGroupMoved(e.payload.groupName, e.payload.fromNode, e.payload.toNode)),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
