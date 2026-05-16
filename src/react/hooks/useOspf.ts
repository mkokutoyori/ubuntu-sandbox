/**
 * OSPF hooks — read OSPFEngine observables from a router by deviceId.
 *
 * Resolution: device → router._getOSPFEngineInternal() → engine.observables
 */

import { useEngineSignal } from './useEngineSignal';
import type { Equipment } from '@/network/equipment/Equipment';
import type { OSPFEngine } from '@/network/ospf/OSPFEngine';
import type {
  OspfNeighborVM,
  OspfInterfaceVM,
  OspfLSDBSummaryVM,
  OspfRoutesVM,
  OspfRuntimeStatsVM,
} from '@/network/ospf/observables';

const EMPTY_ARRAY: ReadonlyArray<never> = [];
const EMPTY_LSDB: OspfLSDBSummaryVM = {
  totalLSAs: 0,
  perAreaCounts: new Map(),
  externalCount: 0,
  headers: [],
};
const EMPTY_ROUTES: OspfRoutesVM = { routes: [], lastUpdatedAt: 0 };
const EMPTY_RUNTIME: OspfRuntimeStatsVM = {
  running: false,
  spfRuns: 0,
  lastSpfKind: null,
  lastSpfDurationMs: 0,
  neighborChanges: 0,
};

function resolveOspf(eq: Equipment): OSPFEngine | null {
  const router = eq as unknown as { _getOSPFEngineInternal?: () => OSPFEngine | null };
  return router._getOSPFEngineInternal?.() ?? null;
}

export function useOspfNeighbors(deviceId: string): ReadonlyArray<OspfNeighborVM> {
  return useEngineSignal(deviceId, resolveOspf, (e) => e.observables.neighbors, EMPTY_ARRAY);
}
export function useOspfInterfaces(deviceId: string): ReadonlyArray<OspfInterfaceVM> {
  return useEngineSignal(deviceId, resolveOspf, (e) => e.observables.interfaces, EMPTY_ARRAY);
}
export function useOspfLSDBSummary(deviceId: string): OspfLSDBSummaryVM {
  return useEngineSignal(deviceId, resolveOspf, (e) => e.observables.lsdbSummary, EMPTY_LSDB);
}
export function useOspfRoutes(deviceId: string): OspfRoutesVM {
  return useEngineSignal(deviceId, resolveOspf, (e) => e.observables.routes, EMPTY_ROUTES);
}
export function useOspfRuntime(deviceId: string): OspfRuntimeStatsVM {
  return useEngineSignal(deviceId, resolveOspf, (e) => e.observables.runtime, EMPTY_RUNTIME);
}
