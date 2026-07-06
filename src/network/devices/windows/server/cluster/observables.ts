/**
 * WSFC cluster — observable read-model (Signal) + projection (PRD-Windows-
 * Server-Advanced.md §5 P23). One store per node, fed by `ClusterService`
 * as it detects peer liveness transitions and resource-group ownership
 * changes.
 */

import { WritableSignal, type Signal } from '@/events/Signal';

export interface ClusterLogEntryVM {
  readonly timestamp: number;
  readonly kind: 'node-up' | 'node-down' | 'group-moved';
  readonly detail: string;
}

export interface ClusterStatsVM {
  readonly nodeUpTransitions: number;
  readonly nodeDownTransitions: number;
  readonly groupMoves: number;
}

const EMPTY_STATS: ClusterStatsVM = { nodeUpTransitions: 0, nodeDownTransitions: 0, groupMoves: 0 };
const LOG_CAPACITY = 200;

export class ClusterSignalStore {
  readonly log = new WritableSignal<ReadonlyArray<ClusterLogEntryVM>>([]);
  readonly stats = new WritableSignal<ClusterStatsVM>(EMPTY_STATS);

  recordNodeUp(nodeName: string): void {
    this.log.set([...this.log.get(), { timestamp: Date.now(), kind: 'node-up' as const, detail: `node=${nodeName}` }].slice(-LOG_CAPACITY));
    this.stats.set({ ...this.stats.get(), nodeUpTransitions: this.stats.get().nodeUpTransitions + 1 });
  }

  recordNodeDown(nodeName: string): void {
    this.log.set([...this.log.get(), { timestamp: Date.now(), kind: 'node-down' as const, detail: `node=${nodeName}` }].slice(-LOG_CAPACITY));
    this.stats.set({ ...this.stats.get(), nodeDownTransitions: this.stats.get().nodeDownTransitions + 1 });
  }

  recordGroupMoved(groupName: string, fromNode: string | null, toNode: string): void {
    const detail = `group=${groupName} ${fromNode ?? '(none)'} -> ${toNode}`;
    this.log.set([...this.log.get(), { timestamp: Date.now(), kind: 'group-moved' as const, detail }].slice(-LOG_CAPACITY));
    this.stats.set({ ...this.stats.get(), groupMoves: this.stats.get().groupMoves + 1 });
  }
}

export interface ClusterObservables {
  readonly log: Signal<ReadonlyArray<ClusterLogEntryVM>>;
  readonly stats: Signal<ClusterStatsVM>;
}

export function makeReadonlyClusterObservables(store: ClusterSignalStore): ClusterObservables {
  return { log: store.log, stats: store.stats };
}
