/**
 * RDP — observable read-model (Signal) + projection (PRD-Windows-Server-
 * Advanced.md §5 P23). One store per RDP host, fed by `RdpServerHandler`/
 * `RdpSessionTable` as sessions establish and close.
 */

import { WritableSignal, type Signal } from '@/events/Signal';

export interface RdpLogEntryVM {
  readonly timestamp: number;
  readonly kind: 'session-established' | 'session-closed';
  readonly detail: string;
}

export interface RdpStatsVM {
  readonly sessionsEstablished: number;
  readonly sessionsClosed: number;
}

const EMPTY_STATS: RdpStatsVM = { sessionsEstablished: 0, sessionsClosed: 0 };
const LOG_CAPACITY = 200;

export class RdpSignalStore {
  readonly log = new WritableSignal<ReadonlyArray<RdpLogEntryVM>>([]);
  readonly stats = new WritableSignal<RdpStatsVM>(EMPTY_STATS);

  recordSessionEstablished(sessionId: number, userName: string, clientAddress: string): void {
    const entry: RdpLogEntryVM = {
      timestamp: Date.now(), kind: 'session-established',
      detail: `session=${sessionId} user=${userName} client=${clientAddress}`,
    };
    this.log.set([...this.log.get(), entry].slice(-LOG_CAPACITY));
    this.stats.set({ ...this.stats.get(), sessionsEstablished: this.stats.get().sessionsEstablished + 1 });
  }

  recordSessionClosed(sessionId: number): void {
    const entry: RdpLogEntryVM = { timestamp: Date.now(), kind: 'session-closed', detail: `session=${sessionId}` };
    this.log.set([...this.log.get(), entry].slice(-LOG_CAPACITY));
    this.stats.set({ ...this.stats.get(), sessionsClosed: this.stats.get().sessionsClosed + 1 });
  }
}

export interface RdpObservables {
  readonly log: Signal<ReadonlyArray<RdpLogEntryVM>>;
  readonly stats: Signal<RdpStatsVM>;
}

export function makeReadonlyRdpObservables(store: RdpSignalStore): RdpObservables {
  return { log: store.log, stats: store.stats };
}
