/**
 * IPSec — observable read-models (Signals) + projection functions.
 *
 * Mirrors the OSPF observables design: a private `IPSecSignalStore`
 * holds the writable signals; `IPSecObservables` is the read-only
 * surface exposed by `engine.observables`. Pure projection functions
 * recompute view-models from the raw engine state and feed the
 * signals via the bundled `IPSecSignalRefreshActor`.
 */

import { WritableSignal, type Signal } from '@/events/Signal';
import type { IKE_SA, IKEv2_SA, IPSec_SA } from './IPSecTypes';

// ── View-model types ────────────────────────────────────────────────────

export interface IkeSaVM {
  readonly peerIp: string;
  readonly localIp: string;
  readonly version: 1 | 2;
  readonly status: string;
  readonly createdAt: number;
  readonly lifetimeSec: number;
  readonly dpdEnabled: boolean;
  readonly dpdTimeouts: number;
}

export interface IpsecSaVM {
  readonly peerIp: string;
  readonly spiInbound: number;
  readonly spiOutbound: number;
  readonly protocol: 'esp' | 'ah';
  readonly mode: 'tunnel' | 'transport';
  readonly encryption: string;
  readonly integrity: string;
  readonly lifetimeSec?: number;
  readonly lifetimeKB?: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly packetsIn: number;
  readonly packetsOut: number;
}

export interface FragmentGroupVM {
  readonly key: string;
  readonly fragmentsSeen: number;
  readonly totalDataLength: number;
  readonly createdAt: number;
}

export interface IPSecRuntimeStatsVM {
  readonly running: boolean;
  readonly activeIkeSAs: number;
  readonly activeIPSecSAs: number;
  readonly fragGroupsInFlight: number;
  readonly inboundProcessed: number;
  readonly inboundDropped: number;
  readonly inboundRejected: number;
  readonly outboundProcessed: number;
  readonly outboundDropped: number;
  readonly outboundRejected: number;
}

// ── Signal store ────────────────────────────────────────────────────────

export class IPSecSignalStore {
  readonly ikeSAs = new WritableSignal<ReadonlyArray<IkeSaVM>>([]);
  readonly ipsecSAs = new WritableSignal<ReadonlyArray<IpsecSaVM>>([]);
  readonly fragGroups = new WritableSignal<ReadonlyArray<FragmentGroupVM>>([]);
  readonly stats = new WritableSignal<IPSecRuntimeStatsVM>({
    running: false,
    activeIkeSAs: 0,
    activeIPSecSAs: 0,
    fragGroupsInFlight: 0,
    inboundProcessed: 0,
    inboundDropped: 0,
    inboundRejected: 0,
    outboundProcessed: 0,
    outboundDropped: 0,
    outboundRejected: 0,
  });
}

export interface IPSecObservables {
  readonly ikeSAs: Signal<ReadonlyArray<IkeSaVM>>;
  readonly ipsecSAs: Signal<ReadonlyArray<IpsecSaVM>>;
  readonly fragGroups: Signal<ReadonlyArray<FragmentGroupVM>>;
  readonly stats: Signal<IPSecRuntimeStatsVM>;
}

export function makeReadonlyIPSecObservables(store: IPSecSignalStore): IPSecObservables {
  return {
    ikeSAs: store.ikeSAs,
    ipsecSAs: store.ipsecSAs,
    fragGroups: store.fragGroups,
    stats: store.stats,
  };
}

// ── Pure projection functions ──────────────────────────────────────────

export function projectIkeSAs(
  ikeSADB: Map<string, IKE_SA>,
  ikev2SADB: Map<string, IKEv2_SA>,
): IkeSaVM[] {
  const out: IkeSaVM[] = [];
  for (const [peerIp, sa] of ikeSADB) {
    out.push({
      peerIp,
      localIp: sa.localIP ?? '',
      version: 1,
      status: sa.status,
      createdAt: sa.created,
      lifetimeSec: sa.lifetime,
      dpdEnabled: sa.dpdEnabled ?? false,
      dpdTimeouts: sa.dpdTimeouts ?? 0,
    });
  }
  for (const [peerIp, sa] of ikev2SADB) {
    out.push({
      peerIp,
      localIp: sa.localIP ?? '',
      version: 2,
      status: sa.status,
      createdAt: sa.created,
      lifetimeSec: (sa as IKEv2_SA & { lifetime?: number }).lifetime ?? 0,
      dpdEnabled: false,
      dpdTimeouts: 0,
    });
  }
  return out;
}

export function projectIpsecSAs(
  ipsecSADB: Map<string, IPSec_SA[]>,
): IpsecSaVM[] {
  const out: IpsecSaVM[] = [];
  for (const [peerIp, sas] of ipsecSADB) {
    for (const sa of sas) {
      out.push({
        peerIp,
        spiInbound: sa.spiIn,
        spiOutbound: sa.spiOut,
        protocol: sa.hasAH && !sa.hasESP ? 'ah' : 'esp',
        mode: sa.mode === 'Tunnel' ? 'tunnel' : 'transport',
        encryption: sa.transforms.find((t) => t.startsWith('esp-') || t.startsWith('ah-')) ?? '',
        integrity: sa.transforms.find((t) => t.includes('hmac')) ?? '',
        lifetimeSec: sa.lifetime,
        lifetimeKB: sa.lifetimeKB,
        bytesIn: sa.bytesDecaps ?? 0,
        bytesOut: sa.bytesEncaps ?? 0,
        packetsIn: sa.pktsDecaps ?? 0,
        packetsOut: sa.pktsEncaps ?? 0,
      });
    }
  }
  return out;
}

export function projectFragmentGroups(
  fragBuffer: Map<string, { fragments: { offsetBytes: number }[]; totalDataLength: number; created: number }>,
): FragmentGroupVM[] {
  const out: FragmentGroupVM[] = [];
  for (const [key, group] of fragBuffer) {
    out.push({
      key,
      fragmentsSeen: group.fragments.length,
      totalDataLength: group.totalDataLength,
      createdAt: group.created,
    });
  }
  return out;
}

export function projectIPSecStats(input: {
  running: boolean;
  ikeSADB: Map<string, IKE_SA>;
  ikev2SADB: Map<string, IKEv2_SA>;
  ipsecSADB: Map<string, IPSec_SA[]>;
  fragBufferSize: number;
  inboundProcessed: number;
  inboundDropped: number;
  inboundRejected: number;
  outboundProcessed: number;
  outboundDropped: number;
  outboundRejected: number;
}): IPSecRuntimeStatsVM {
  let ipsecCount = 0;
  for (const sas of input.ipsecSADB.values()) ipsecCount += sas.length;
  return {
    running: input.running,
    activeIkeSAs: input.ikeSADB.size + input.ikev2SADB.size,
    activeIPSecSAs: ipsecCount,
    fragGroupsInFlight: input.fragBufferSize,
    inboundProcessed: input.inboundProcessed,
    inboundDropped: input.inboundDropped,
    inboundRejected: input.inboundRejected,
    outboundProcessed: input.outboundProcessed,
    outboundDropped: input.outboundDropped,
    outboundRejected: input.outboundRejected,
  };
}
