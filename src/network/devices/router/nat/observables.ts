/**
 * NAT — observable read-models (Signals) + projection functions.
 */

import { simulationNowMs } from '@/network/core/SystemClock';

import { LazySignal, type Signal } from '@/events/Signal';
import type { NatSession, NatTcpState } from '../NATEngine';

export interface NatSessionVM {
  readonly protocol: number;
  readonly localIp: string;
  readonly localPort: number;
  readonly globalIp: string;
  readonly globalPort: number;
  readonly outsideIp: string;
  readonly outsidePort: number;
  readonly tcpState?: NatTcpState;
  readonly age: number;
}

export interface NatStatsVM {
  readonly sessionCount: number;
  readonly hits: number;
  readonly misses: number;
  readonly expired: number;
  readonly inboundTranslations: number;
  readonly outboundTranslations: number;
  readonly tcpEstablished: number;
  readonly tcpHalfOpen: number;
  readonly tcpClosing: number;
}

export class NATSignalStore {
  readonly sessions: LazySignal<ReadonlyArray<NatSessionVM>>;
  readonly stats: LazySignal<NatStatsVM>;

  constructor(
    computeSessions: () => ReadonlyArray<NatSessionVM>,
    computeStats: () => NatStatsVM,
  ) {
    this.sessions = new LazySignal(computeSessions);
    this.stats = new LazySignal(computeStats);
  }
}

export interface NATObservables {
  readonly sessions: Signal<ReadonlyArray<NatSessionVM>>;
  readonly stats: Signal<NatStatsVM>;
}

export function makeReadonlyNATObservables(store: NATSignalStore): NATObservables {
  return { sessions: store.sessions, stats: store.stats };
}

// ── Projections ────────────────────────────────────────────────────────

export function projectNatSessions(sessions: Map<string, NatSession>): NatSessionVM[] {
  const now = simulationNowMs();
  const out: NatSessionVM[] = [];
  for (const [, s] of sessions) {
    out.push({
      protocol: s.protocol,
      localIp: s.localIP,
      localPort: s.localPort,
      globalIp: s.globalIP,
      globalPort: s.globalPort,
      outsideIp: s.outsideIP,
      outsidePort: s.outsidePort,
      tcpState: s.tcpState,
      age: Math.max(0, now - s.timestamp),
    });
  }
  return out;
}

export function projectNatStats(input: {
  sessions: Map<string, NatSession>;
  hits: number;
  misses: number;
  expired: number;
  inboundTranslations: number;
  outboundTranslations: number;
}): NatStatsVM {
  let est = 0, half = 0, closing = 0;
  for (const [, s] of input.sessions) {
    if (s.tcpState === 'established') est++;
    else if (s.tcpState === 'syn-seen') half++;
    else if (s.tcpState === 'fin-wait' || s.tcpState === 'time-wait') closing++;
  }
  return {
    sessionCount: input.sessions.size,
    hits: input.hits,
    misses: input.misses,
    expired: input.expired,
    inboundTranslations: input.inboundTranslations,
    outboundTranslations: input.outboundTranslations,
    tcpEstablished: est,
    tcpHalfOpen: half,
    tcpClosing: closing,
  };
}
