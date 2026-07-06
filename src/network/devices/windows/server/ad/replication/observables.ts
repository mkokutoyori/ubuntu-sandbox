/**
 * AD replication — observable read-model (Signal) + projection
 * (PRD-Windows-Server-Advanced.md §5 P12). One store per DC, fed by
 * `replicateFrom` (puller side) and `ReplicationServerHandler` (responder
 * side) — the log VM reuses `ReplicationLogEntry` (already built at §5
 * P6) rather than duplicating its shape, matching `dhcp/observables.ts`'s
 * pattern of a rolling log plus running counters.
 */

import { WritableSignal, type Signal } from '@/events/Signal';
import type { ReplicationLogEntry } from './ReplicationSession';

export interface ReplicationStatsVM {
  readonly pullsSucceeded: number;
  readonly pullsFailed: number;
  readonly totalApplied: number;
  readonly intraSiteCount: number;
  readonly interSiteCount: number;
  readonly served: number;
  readonly changesServed: number;
}

const EMPTY_STATS: ReplicationStatsVM = {
  pullsSucceeded: 0, pullsFailed: 0, totalApplied: 0, intraSiteCount: 0, interSiteCount: 0, served: 0, changesServed: 0,
};

const LOG_CAPACITY = 200;

export class ReplicationSignalStore {
  readonly log = new WritableSignal<ReadonlyArray<ReplicationLogEntry>>([]);
  readonly stats = new WritableSignal<ReplicationStatsVM>(EMPTY_STATS);

  recordPull(entry: ReplicationLogEntry): void {
    this.log.set([...this.log.get(), entry].slice(-LOG_CAPACITY));
    const stats = this.stats.get();
    this.stats.set({
      ...stats,
      pullsSucceeded: stats.pullsSucceeded + (entry.ok ? 1 : 0),
      pullsFailed: stats.pullsFailed + (entry.ok ? 0 : 1),
      totalApplied: stats.totalApplied + entry.applied,
      intraSiteCount: stats.intraSiteCount + (entry.siteRelation === 'intra-site' ? 1 : 0),
      interSiteCount: stats.interSiteCount + (entry.siteRelation === 'inter-site' ? 1 : 0),
    });
  }

  recordServed(changesSent: number): void {
    const stats = this.stats.get();
    this.stats.set({ ...stats, served: stats.served + 1, changesServed: stats.changesServed + changesSent });
  }
}

export interface ReplicationObservables {
  readonly log: Signal<ReadonlyArray<ReplicationLogEntry>>;
  readonly stats: Signal<ReplicationStatsVM>;
}

export function makeReadonlyReplicationObservables(store: ReplicationSignalStore): ReplicationObservables {
  return { log: store.log, stats: store.stats };
}
