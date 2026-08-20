/**
 * AD CS — observable read-model (Signal) + projection (PRD-Windows-
 * Server-Advanced.md §5 P23). One store per CA, fed by `WindowsAdcsRole`
 * as it issues certificates — same shape as `kerberos/observables.ts`.
 */

import { WritableSignal, type Signal } from '@/events/Signal';

export interface AdcsLogEntryVM {
  readonly timestamp: number;
  readonly kind: 'certificate-issued';
  readonly subject: string;
  readonly detail: string;
}

export interface AdcsStatsVM {
  readonly certificatesIssued: number;
}

const EMPTY_STATS: AdcsStatsVM = { certificatesIssued: 0 };
const LOG_CAPACITY = 200;

export class AdcsSignalStore {
  readonly log = new WritableSignal<ReadonlyArray<AdcsLogEntryVM>>([]);
  readonly stats = new WritableSignal<AdcsStatsVM>(EMPTY_STATS);

  recordCertificateIssued(subject: string, templateName: string, serialNumber: string): void {
    const entry: AdcsLogEntryVM = {
      timestamp: Date.now(), kind: 'certificate-issued', subject,
      detail: `template=${templateName} serial=${serialNumber}`,
    };
    this.log.set([...this.log.get(), entry].slice(-LOG_CAPACITY));
    this.stats.set({ certificatesIssued: this.stats.get().certificatesIssued + 1 });
  }
}

export interface AdcsObservables {
  readonly log: Signal<ReadonlyArray<AdcsLogEntryVM>>;
  readonly stats: Signal<AdcsStatsVM>;
}

export function makeReadonlyAdcsObservables(store: AdcsSignalStore): AdcsObservables {
  return { log: store.log, stats: store.stats };
}
