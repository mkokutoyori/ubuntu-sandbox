/**
 * NAT hooks — read NATEngine observables from a router by deviceId.
 */

import { useEngineSignal } from './useEngineSignal';
import type { Equipment } from '@/network/equipment/Equipment';
import type { NATEngine } from '@/network/devices/router/NATEngine';
import type { NatSessionVM, NatStatsVM } from '@/network/devices/router/nat/observables';

const EMPTY_ARRAY: ReadonlyArray<never> = [];
const EMPTY_STATS: NatStatsVM = {
  sessionCount: 0, hits: 0, misses: 0, expired: 0,
  inboundTranslations: 0, outboundTranslations: 0,
  tcpEstablished: 0, tcpHalfOpen: 0, tcpClosing: 0,
};

function resolveNat(eq: Equipment): NATEngine | null {
  const router = eq as unknown as { _getNATEngine?: () => NATEngine };
  return router._getNATEngine?.() ?? null;
}

export function useNatSessions(deviceId: string): ReadonlyArray<NatSessionVM> {
  return useEngineSignal(deviceId, resolveNat, (e) => e.observables.sessions, EMPTY_ARRAY);
}
export function useNatStats(deviceId: string): NatStatsVM {
  return useEngineSignal(deviceId, resolveNat, (e) => e.observables.stats, EMPTY_STATS);
}
