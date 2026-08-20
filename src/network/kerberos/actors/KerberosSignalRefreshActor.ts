/**
 * KerberosSignalRefreshActor — the only writer of a `KerberosSignalStore`
 * (PRD-Windows-Server-Advanced.md §5 P12): `KdcSessionHandler` only
 * publishes `kerberos.*` events onto the bus, this actor subscribes and
 * projects them into the store, filtered by `deviceId` so multiple KDCs
 * on a shared bus stay isolated — mirrors `DHCPClientSignalRefreshActor`'s
 * shape.
 */
import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { KerberosSignalStore } from '../observables';

export class KerberosSignalRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly deviceId: string,
    private readonly store: KerberosSignalStore,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;

    const isOurs = (e: { deviceId: string }) => e.deviceId === this.deviceId;

    this.subscriptions.push(
      this.bus.subscribeWhere('kerberos.as.succeeded', isOurs, (e) => this.store.recordAsSucceeded(e.payload.cname)),
      this.bus.subscribeWhere('kerberos.as.failed', isOurs, (e) => this.store.recordAsFailed(e.payload.cname, e.payload.errorCode)),
      this.bus.subscribeWhere('kerberos.tgs.succeeded', isOurs, (e) =>
        this.store.recordTgsSucceeded(e.payload.cname, e.payload.serviceName, e.payload.referral)),
      this.bus.subscribeWhere('kerberos.tgs.failed', isOurs, (e) =>
        this.store.recordTgsFailed(e.payload.cname, e.payload.serviceName, e.payload.errorCode)),
      this.bus.subscribeWhere('kerberos.delegation.granted', isOurs, (e) =>
        this.store.recordDelegationGranted(e.payload.delegatingService, e.payload.onBehalfOf, e.payload.targetService)),
      this.bus.subscribeWhere('kerberos.delegation.denied', isOurs, (e) =>
        this.store.recordDelegationDenied(e.payload.delegatingService, e.payload.targetService)),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
