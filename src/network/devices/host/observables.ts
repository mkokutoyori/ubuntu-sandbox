/**
 * Host (L3/L4) — observable read-models (Signals) + projections.
 *
 * Same shape as the protocol engines: a private writable store + a
 * read-only `HostObservables` exposed by `EndHost.observables`.
 *
 * Phase 5: signals are written by the host's own helper methods
 * (`_refreshArpSignal`, `_refreshRoutingSignal`, …) which are
 * actor-API public methods, called either inline by the engine after
 * a mutation or by the bundled `HostSignalRefreshActor` reacting to
 * `host.*` topics on the bus.
 */

import { WritableSignal, type Signal } from '@/events/Signal';

// ── View-models ────────────────────────────────────────────────────────

export interface HostArpEntryVM {
  readonly ip: string;
  readonly mac: string;
  readonly iface: string;
  readonly age: number;
}

export interface HostNdpEntryVM {
  readonly ip: string;
  readonly mac: string;
  readonly iface: string;
}

export interface HostRouteVM {
  readonly destination: string;
  readonly mask: string;
  readonly gateway: string | null;
  readonly iface: string;
  readonly metric: number;
  readonly type: string;
}

export interface HostTcpListenerVM {
  readonly ip: string;
  readonly port: number;
}

export interface HostTcpConnectionVM {
  readonly localIp: string;
  readonly localPort: number;
  readonly remoteIp: string;
  readonly remotePort: number;
  readonly side: 'client' | 'server';
}

export interface HostStatsVM {
  readonly arpCacheSize: number;
  readonly ndpCacheSize: number;
  readonly routeCount: number;
  readonly tcpListeners: number;
  readonly tcpConnections: number;
  readonly icmpEchosSent: number;
  readonly icmpEchosReceived: number;
  readonly icmpTimeouts: number;
  readonly arpRequestsSent: number;
}

// ── Signal store ──────────────────────────────────────────────────────

export class HostSignalStore {
  readonly arp = new WritableSignal<ReadonlyArray<HostArpEntryVM>>([]);
  readonly ndp = new WritableSignal<ReadonlyArray<HostNdpEntryVM>>([]);
  readonly routes = new WritableSignal<ReadonlyArray<HostRouteVM>>([]);
  readonly tcpListeners = new WritableSignal<ReadonlyArray<HostTcpListenerVM>>([]);
  readonly tcpConnections = new WritableSignal<ReadonlyArray<HostTcpConnectionVM>>([]);
  readonly stats = new WritableSignal<HostStatsVM>({
    arpCacheSize: 0,
    ndpCacheSize: 0,
    routeCount: 0,
    tcpListeners: 0,
    tcpConnections: 0,
    icmpEchosSent: 0,
    icmpEchosReceived: 0,
    icmpTimeouts: 0,
    arpRequestsSent: 0,
  });
}

export interface HostObservables {
  readonly arp: Signal<ReadonlyArray<HostArpEntryVM>>;
  readonly ndp: Signal<ReadonlyArray<HostNdpEntryVM>>;
  readonly routes: Signal<ReadonlyArray<HostRouteVM>>;
  readonly tcpListeners: Signal<ReadonlyArray<HostTcpListenerVM>>;
  readonly tcpConnections: Signal<ReadonlyArray<HostTcpConnectionVM>>;
  readonly stats: Signal<HostStatsVM>;
}

export function makeReadonlyHostObservables(store: HostSignalStore): HostObservables {
  return {
    arp: store.arp,
    ndp: store.ndp,
    routes: store.routes,
    tcpListeners: store.tcpListeners,
    tcpConnections: store.tcpConnections,
    stats: store.stats,
  };
}

// ── Projections ───────────────────────────────────────────────────────

export interface ArpEntryLike {
  mac: { toString(): string };
  iface: string;
  timestamp: number;
}

export function projectArpTable(entries: Map<string, ArpEntryLike>): HostArpEntryVM[] {
  const now = Date.now();
  const out: HostArpEntryVM[] = [];
  for (const [ip, entry] of entries) {
    out.push({
      ip,
      mac: String(entry.mac),
      iface: entry.iface,
      age: Math.max(0, now - entry.timestamp),
    });
  }
  return out;
}

export interface NdpEntryLike {
  mac: { toString(): string };
  iface: string;
}

export function projectNdpTable(entries: Map<string, NdpEntryLike>): HostNdpEntryVM[] {
  const out: HostNdpEntryVM[] = [];
  for (const [ip, entry] of entries) {
    out.push({ ip, mac: String(entry.mac), iface: entry.iface });
  }
  return out;
}

export interface HostRouteLike {
  destination: { toString(): string };
  mask: { toString(): string };
  gateway: { toString(): string } | null;
  iface: string;
  metric?: number;
  type?: string;
}

export function projectHostRoutes(routes: Iterable<HostRouteLike>): HostRouteVM[] {
  const out: HostRouteVM[] = [];
  for (const r of routes) {
    out.push({
      destination: String(r.destination),
      mask: String(r.mask),
      gateway: r.gateway ? String(r.gateway) : null,
      iface: r.iface,
      metric: r.metric ?? 0,
      type: r.type ?? 'static',
    });
  }
  return out;
}
