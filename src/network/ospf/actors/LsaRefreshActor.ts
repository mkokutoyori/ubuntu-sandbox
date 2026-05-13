/**
 * LsaRefreshActor — periodic refresh of self-originated LSAs.
 *
 * RFC 2328 §12.4 mandates that a self-originated LSA be re-flooded
 * before it is purged at MaxAge. The aging tick emits
 * `ospf.lsa.refresh-due` whenever a self-originated LSA reaches
 * `LS_REFRESH_TIME` (1800 s of age); this actor performs the refresh:
 *
 *   1. Look up the full LSA from the engine's LSDB.
 *   2. Call `engine.refreshOwnLSA(area, lsa)` which bumps the sequence,
 *      resets age to 0, recomputes the checksum and re-floods.
 *
 * Decoupling the refresh from the aging tick:
 *   - lets external observers (telemetry, replay snapshots) see the
 *     refresh event independently of the imperative refresh logic;
 *   - lets the policy be replaced (e.g. with a coalescing strategy
 *     that batches refreshes per area) by swapping the actor.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { OSPFEngine } from '../OSPFEngine';
import type { LSAType } from '../types';

export class LsaRefreshActor {
  private readonly subscriptions: BusUnsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly engine: OSPFEngine,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;

    const isOurs = (e: { routerId: string; processId: number }) =>
      e.routerId === this.engine.getRouterId() &&
      e.processId === this.engine.getProcessId();

    this.subscriptions.push(
      this.bus.subscribeWhere('ospf.lsa.refresh-due', isOurs, (e) => {
        const { areaId, lsa: header } = e.payload;
        const full = this.engine.lookupLSA(
          areaId,
          header.lsType as LSAType,
          header.linkStateId,
          header.advertisingRouter,
        );
        if (!full) return; // LSA was concurrently flushed
        this.engine.refreshOwnLSA(areaId, full);
      }),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }
}
