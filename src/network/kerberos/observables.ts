/**
 * Kerberos — observable read-model (Signal) + projection (PRD-Windows-
 * Server-Advanced.md §5 P12). One store per KDC, fed by `KdcSessionHandler`
 * as it processes AS-REQ/TGS-REQ, mirroring `dhcp/observables.ts`'s
 * shape (a small rolling event log plus running counters — no per-
 * principal ticket inventory, which `klist`'s own `KerberosTicketCache`
 * already covers client-side).
 */

import { WritableSignal, type Signal } from '@/events/Signal';

export interface KerberosLogEntryVM {
  readonly timestamp: number;
  readonly kind: 'as-succeeded' | 'as-failed' | 'tgs-succeeded' | 'tgs-referral' | 'tgs-failed' | 'delegation-granted' | 'delegation-denied';
  readonly cname: string;
  readonly detail: string;
}

export interface KerberosStatsVM {
  readonly asSucceeded: number;
  readonly asFailed: number;
  readonly tgsSucceeded: number;
  readonly tgsReferralsIssued: number;
  readonly tgsFailed: number;
  readonly delegationsGranted: number;
  readonly delegationsDenied: number;
}

const EMPTY_STATS: KerberosStatsVM = {
  asSucceeded: 0, asFailed: 0, tgsSucceeded: 0, tgsReferralsIssued: 0, tgsFailed: 0,
  delegationsGranted: 0, delegationsDenied: 0,
};

const LOG_CAPACITY = 200;

export class KerberosSignalStore {
  readonly log = new WritableSignal<ReadonlyArray<KerberosLogEntryVM>>([]);
  readonly stats = new WritableSignal<KerberosStatsVM>(EMPTY_STATS);

  private append(entry: KerberosLogEntryVM, statsPatch: Partial<KerberosStatsVM>): void {
    const nextLog = [...this.log.get(), entry].slice(-LOG_CAPACITY);
    this.log.set(nextLog);
    this.stats.set({ ...this.stats.get(), ...statsPatch });
  }

  recordAsSucceeded(cname: string): void {
    const stats = this.stats.get();
    this.append(
      { timestamp: Date.now(), kind: 'as-succeeded', cname, detail: 'AS-REP issued' },
      { asSucceeded: stats.asSucceeded + 1 },
    );
  }

  recordAsFailed(cname: string, errorCode: number): void {
    const stats = this.stats.get();
    this.append(
      { timestamp: Date.now(), kind: 'as-failed', cname, detail: `KRB-ERROR ${errorCode}` },
      { asFailed: stats.asFailed + 1 },
    );
  }

  recordTgsSucceeded(cname: string, serviceName: string, referral: boolean): void {
    const stats = this.stats.get();
    this.append(
      { timestamp: Date.now(), kind: referral ? 'tgs-referral' : 'tgs-succeeded', cname, detail: `service=${serviceName}` },
      referral
        ? { tgsSucceeded: stats.tgsSucceeded + 1, tgsReferralsIssued: stats.tgsReferralsIssued + 1 }
        : { tgsSucceeded: stats.tgsSucceeded + 1 },
    );
  }

  recordTgsFailed(cname: string, serviceName: string, errorCode: number): void {
    const stats = this.stats.get();
    this.append(
      { timestamp: Date.now(), kind: 'tgs-failed', cname, detail: `service=${serviceName} KRB-ERROR ${errorCode}` },
      { tgsFailed: stats.tgsFailed + 1 },
    );
  }

  recordDelegationGranted(delegatingService: string, onBehalfOf: string, targetService: string): void {
    const stats = this.stats.get();
    this.append(
      { timestamp: Date.now(), kind: 'delegation-granted', cname: onBehalfOf, detail: `${delegatingService} -> ${targetService}` },
      { delegationsGranted: stats.delegationsGranted + 1 },
    );
  }

  recordDelegationDenied(delegatingService: string, targetService: string): void {
    const stats = this.stats.get();
    this.append(
      { timestamp: Date.now(), kind: 'delegation-denied', cname: delegatingService, detail: `${delegatingService} -> ${targetService}` },
      { delegationsDenied: stats.delegationsDenied + 1 },
    );
  }
}

export interface KerberosObservables {
  readonly log: Signal<ReadonlyArray<KerberosLogEntryVM>>;
  readonly stats: Signal<KerberosStatsVM>;
}

export function makeReadonlyKerberosObservables(store: KerberosSignalStore): KerberosObservables {
  return { log: store.log, stats: store.stats };
}
