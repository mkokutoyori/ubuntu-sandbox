/**
 * DHCP — observable read-models (Signals) + projection functions.
 *
 * The client side is the rich one (per-interface lease state machine).
 * The server side exposes pool occupancy. Both share the same
 * `DHCPObservables` interface so a single `DHCPSignalRefreshActor`
 * can serve both kinds of engine.
 */

import { WritableSignal, type Signal } from '@/events/Signal';
import type { DHCPClientIfaceState } from './types';

// ── View-models ────────────────────────────────────────────────────────

export interface DhcpClientIfaceVM {
  readonly iface: string;
  readonly state: string;
  readonly xid: number;
  readonly hasLease: boolean;
  readonly leaseIp?: string;
  readonly leaseGateway?: string;
  readonly leaseExpiresAt?: number;
  readonly leaseDurationSec?: number;
  readonly serverIp?: string;
}

export interface DhcpClientStatsVM {
  readonly running: boolean;
  readonly ifaceCount: number;
  readonly boundCount: number;
  readonly discoversSent: number;
  readonly offersReceived: number;
  readonly requestsSent: number;
  readonly acksReceived: number;
  readonly naksReceived: number;
  readonly leasesGranted: number;
  readonly leasesExpired: number;
  readonly leasesReleased: number;
  readonly conflicts: number;
}

export interface DhcpServerLeaseVM {
  readonly pool: string;
  readonly clientMac: string;
  readonly ip: string;
  readonly grantedAt: number;
  readonly expiresAt: number;
}

export interface DhcpServerStatsVM {
  readonly running: boolean;
  readonly poolCount: number;
  readonly activeLeases: number;
  readonly reservationsCount: number;
}

// ── Signal stores ──────────────────────────────────────────────────────

export class DHCPClientSignalStore {
  readonly ifaces = new WritableSignal<ReadonlyArray<DhcpClientIfaceVM>>([]);
  readonly stats = new WritableSignal<DhcpClientStatsVM>({
    running: false,
    ifaceCount: 0,
    boundCount: 0,
    discoversSent: 0,
    offersReceived: 0,
    requestsSent: 0,
    acksReceived: 0,
    naksReceived: 0,
    leasesGranted: 0,
    leasesExpired: 0,
    leasesReleased: 0,
    conflicts: 0,
  });
}

export class DHCPServerSignalStore {
  readonly leases = new WritableSignal<ReadonlyArray<DhcpServerLeaseVM>>([]);
  readonly stats = new WritableSignal<DhcpServerStatsVM>({
    running: false,
    poolCount: 0,
    activeLeases: 0,
    reservationsCount: 0,
  });
}

export interface DHCPClientObservables {
  readonly ifaces: Signal<ReadonlyArray<DhcpClientIfaceVM>>;
  readonly stats: Signal<DhcpClientStatsVM>;
}

export interface DHCPServerObservables {
  readonly leases: Signal<ReadonlyArray<DhcpServerLeaseVM>>;
  readonly stats: Signal<DhcpServerStatsVM>;
}

export function makeReadonlyDHCPClientObservables(
  store: DHCPClientSignalStore,
): DHCPClientObservables {
  return { ifaces: store.ifaces, stats: store.stats };
}

export function makeReadonlyDHCPServerObservables(
  store: DHCPServerSignalStore,
): DHCPServerObservables {
  return { leases: store.leases, stats: store.stats };
}

// ── Projections ────────────────────────────────────────────────────────

export function projectDhcpClientIfaces(
  ifaceStates: Map<string, DHCPClientIfaceState>,
): DhcpClientIfaceVM[] {
  const out: DhcpClientIfaceVM[] = [];
  for (const [iface, st] of ifaceStates) {
    const lease = st.lease;
    out.push({
      iface,
      state: String(st.state),
      xid: st.xid,
      hasLease: !!lease,
      leaseIp: lease?.ipAddress,
      leaseGateway: lease?.defaultGateway ?? undefined,
      leaseExpiresAt: lease?.expiration,
      leaseDurationSec: lease?.leaseDuration,
      serverIp: lease?.serverIdentifier,
    });
  }
  return out;
}

export function projectDhcpClientStats(input: {
  running: boolean;
  ifaceStates: Map<string, DHCPClientIfaceState>;
  discoversSent: number;
  offersReceived: number;
  requestsSent: number;
  acksReceived: number;
  naksReceived: number;
  leasesGranted: number;
  leasesExpired: number;
  leasesReleased: number;
  conflicts: number;
}): DhcpClientStatsVM {
  let bound = 0;
  for (const [, st] of input.ifaceStates) {
    if (String(st.state) === 'BOUND') bound++;
  }
  return {
    running: input.running,
    ifaceCount: input.ifaceStates.size,
    boundCount: bound,
    discoversSent: input.discoversSent,
    offersReceived: input.offersReceived,
    requestsSent: input.requestsSent,
    acksReceived: input.acksReceived,
    naksReceived: input.naksReceived,
    leasesGranted: input.leasesGranted,
    leasesExpired: input.leasesExpired,
    leasesReleased: input.leasesReleased,
    conflicts: input.conflicts,
  };
}
