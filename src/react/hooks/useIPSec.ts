/**
 * IPSec hooks — read IPSecEngine observables from a router by deviceId.
 *
 * Resolution: device → router._getIPSecEngineInternal() → engine.observables
 */

import { useEngineSignal } from './useEngineSignal';
import type { Equipment } from '@/network/equipment/Equipment';
import type { IPSecEngine } from '@/network/ipsec/IPSecEngine';
import type {
  IkeSaVM,
  IpsecSaVM,
  FragmentGroupVM,
  IPSecRuntimeStatsVM,
} from '@/network/ipsec/observables';

const EMPTY_ARRAY: ReadonlyArray<never> = [];
const EMPTY_STATS: IPSecRuntimeStatsVM = {
  running: false,
  activeIkeSAs: 0, activeIPSecSAs: 0, fragGroupsInFlight: 0,
  inboundProcessed: 0, inboundDropped: 0, inboundRejected: 0,
  outboundProcessed: 0, outboundDropped: 0, outboundRejected: 0,
};

function resolveIPSec(eq: Equipment): IPSecEngine | null {
  const router = eq as unknown as { _getIPSecEngineInternal?: () => IPSecEngine | null };
  return router._getIPSecEngineInternal?.() ?? null;
}

export function useIkeSAs(deviceId: string): ReadonlyArray<IkeSaVM> {
  return useEngineSignal(deviceId, resolveIPSec, (e) => e.observables.ikeSAs, EMPTY_ARRAY);
}
export function useIpsecSAs(deviceId: string): ReadonlyArray<IpsecSaVM> {
  return useEngineSignal(deviceId, resolveIPSec, (e) => e.observables.ipsecSAs, EMPTY_ARRAY);
}
export function useIPSecFragmentGroups(deviceId: string): ReadonlyArray<FragmentGroupVM> {
  return useEngineSignal(deviceId, resolveIPSec, (e) => e.observables.fragGroups, EMPTY_ARRAY);
}
export function useIPSecStats(deviceId: string): IPSecRuntimeStatsVM {
  return useEngineSignal(deviceId, resolveIPSec, (e) => e.observables.stats, EMPTY_STATS);
}
