/**
 * Oracle — reactive read-models (Signals) + projections.
 *
 * Same pattern as the host / protocol engines: a private writable store
 * owned by `OracleInstance`, exposed via the read-only `OracleObservables`
 * surface. The store is updated by `OracleSignalRefreshActor` which
 * subscribes to the very `oracle.*` events the instance publishes, so
 * the engine code never has to mutate the signals directly.
 *
 * The view-model shapes are intentionally narrow — we keep large blobs
 * (e.g. the full alert log) out of Signal subscriptions, returning only
 * the latest bounded slice.
 */

import { WritableSignal, type Signal } from '@/events/Signal';
import type { InstanceState } from './OracleInstance';

// ── View-models ────────────────────────────────────────────────────────

export interface OracleInstanceStateVM {
  readonly state: InstanceState;
  readonly sid: string;
  readonly startedAt: number | null;
}

export interface OracleProcessVM {
  readonly name: string;
  readonly pid: number;
}

export interface OracleAlertLogVM {
  /** Bounded ring buffer of the latest alert-log lines. */
  readonly lines: ReadonlyArray<string>;
}

export interface OracleSessionVM {
  readonly sessionId: string;
  readonly schema: string;
  readonly role?: string;
  readonly inTransaction: boolean;
}

export interface OracleStatsVM {
  readonly activeSessions: number;
  readonly activeTransactions: number;
  readonly dmlExecuted: number;
  readonly ddlExecuted: number;
  readonly commits: number;
  readonly rollbacks: number;
  readonly errors: number;
  readonly redoSwitches: number;
  readonly archiveLogs: number;
}

// ── Signal store ───────────────────────────────────────────────────────

export class OracleSignalStore {
  readonly instance = new WritableSignal<OracleInstanceStateVM>({
    state: 'SHUTDOWN',
    sid: '',
    startedAt: null,
  });
  readonly processes = new WritableSignal<ReadonlyArray<OracleProcessVM>>([]);
  readonly alertLog = new WritableSignal<OracleAlertLogVM>({ lines: [] });
  readonly sessions = new WritableSignal<ReadonlyArray<OracleSessionVM>>([]);
  readonly stats = new WritableSignal<OracleStatsVM>({
    activeSessions: 0,
    activeTransactions: 0,
    dmlExecuted: 0,
    ddlExecuted: 0,
    commits: 0,
    rollbacks: 0,
    errors: 0,
    redoSwitches: 0,
    archiveLogs: 0,
  });
}

export interface OracleObservables {
  readonly instance: Signal<OracleInstanceStateVM>;
  readonly processes: Signal<ReadonlyArray<OracleProcessVM>>;
  readonly alertLog: Signal<OracleAlertLogVM>;
  readonly sessions: Signal<ReadonlyArray<OracleSessionVM>>;
  readonly stats: Signal<OracleStatsVM>;
}

export function makeReadonlyOracleObservables(store: OracleSignalStore): OracleObservables {
  return {
    instance: store.instance,
    processes: store.processes,
    alertLog: store.alertLog,
    sessions: store.sessions,
    stats: store.stats,
  };
}
