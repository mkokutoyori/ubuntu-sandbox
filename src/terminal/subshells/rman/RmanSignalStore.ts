/**
 * RmanSignalStore — read-models for one RMAN session, projected onto
 * WritableSignal<T> (the project-wide reactive primitive).
 *
 * Mirrors OracleSignalStore in shape:
 *   - Private writable store owned here.
 *   - Read-only view returned via makeReadonlyRmanObservables().
 *   - Mutated only by RmanSignalRefreshActor — engines never touch it.
 *
 * Plug-and-play with React via useSyncExternalStore.
 */

import { WritableSignal, type Signal } from '@/events/Signal';
import type { RmanSessionState, RmanOperation } from './core/types';

export interface RmanSessionVM {
  readonly sessionId: string;
  readonly state:     RmanSessionState;
  readonly dbName:    string | null;
  readonly connectedAt: number | null;
}

export interface RmanActiveJobVM {
  readonly jobId:     string;
  readonly operation: RmanOperation;
  readonly startedAt: number;
  readonly stepName:  string;
  readonly pct:       number;
  readonly message:   string;
}

export interface RmanMetricsVM {
  readonly jobsStarted:        number;
  readonly jobsCompleted:      number;
  readonly jobsFailed:         number;
  readonly piecesCreated:      number;
  readonly piecesDeleted:      number;
  readonly totalBytesBackedUp: number;
  readonly channelsAllocated:  number;
  readonly channelsReleased:   number;
}

export const EMPTY_RMAN_METRICS: RmanMetricsVM = Object.freeze({
  jobsStarted: 0, jobsCompleted: 0, jobsFailed: 0,
  piecesCreated: 0, piecesDeleted: 0, totalBytesBackedUp: 0,
  channelsAllocated: 0, channelsReleased: 0,
});

export class RmanSignalStore {
  readonly session = new WritableSignal<RmanSessionVM>({
    sessionId: '', state: 'IDLE', dbName: null, connectedAt: null,
  });
  readonly activeJob      = new WritableSignal<RmanActiveJobVM | null>(null);
  readonly activeChannels = new WritableSignal<ReadonlySet<string>>(new Set());
  readonly metrics        = new WritableSignal<RmanMetricsVM>(EMPTY_RMAN_METRICS);
}

export interface RmanObservables {
  readonly session:        Signal<RmanSessionVM>;
  readonly activeJob:      Signal<RmanActiveJobVM | null>;
  readonly activeChannels: Signal<ReadonlySet<string>>;
  readonly metrics:        Signal<RmanMetricsVM>;
}

export function makeReadonlyRmanObservables(store: RmanSignalStore): RmanObservables {
  return {
    session:        store.session,
    activeJob:      store.activeJob,
    activeChannels: store.activeChannels,
    metrics:        store.metrics,
  };
}
