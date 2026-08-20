/**
 * DFSR — observable read-model (Signal) + projection (PRD-Windows-Server-
 * Advanced.md §5 P23). One store per member server, fed by `WindowsDfsrRole.
 * sync` as it completes (or fails) a pull cycle.
 */

import { WritableSignal, type Signal } from '@/events/Signal';

export interface DfsLogEntryVM {
  readonly timestamp: number;
  readonly kind: 'synced' | 'failed';
  readonly groupName: string;
  readonly detail: string;
}

export interface DfsStatsVM {
  readonly syncsCompleted: number;
  readonly syncsFailed: number;
  readonly filesApplied: number;
}

const EMPTY_STATS: DfsStatsVM = { syncsCompleted: 0, syncsFailed: 0, filesApplied: 0 };
const LOG_CAPACITY = 200;

export class DfsSignalStore {
  readonly log = new WritableSignal<ReadonlyArray<DfsLogEntryVM>>([]);
  readonly stats = new WritableSignal<DfsStatsVM>(EMPTY_STATS);

  recordSynced(groupName: string, filesApplied: number): void {
    const entry: DfsLogEntryVM = { timestamp: Date.now(), kind: 'synced', groupName, detail: `filesApplied=${filesApplied}` };
    this.log.set([...this.log.get(), entry].slice(-LOG_CAPACITY));
    const stats = this.stats.get();
    this.stats.set({ ...stats, syncsCompleted: stats.syncsCompleted + 1, filesApplied: stats.filesApplied + filesApplied });
  }

  recordFailed(groupName: string, error: string): void {
    const entry: DfsLogEntryVM = { timestamp: Date.now(), kind: 'failed', groupName, detail: error };
    this.log.set([...this.log.get(), entry].slice(-LOG_CAPACITY));
    this.stats.set({ ...this.stats.get(), syncsFailed: this.stats.get().syncsFailed + 1 });
  }
}

export interface DfsObservables {
  readonly log: Signal<ReadonlyArray<DfsLogEntryVM>>;
  readonly stats: Signal<DfsStatsVM>;
}

export function makeReadonlyDfsObservables(store: DfsSignalStore): DfsObservables {
  return { log: store.log, stats: store.stats };
}
