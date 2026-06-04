/**
 * TEMPLATE — Controller hook (React binding).
 *
 * Copy to `src/react/hooks/use<Feature>.ts` and replace `Lldp`/`lldp`.
 * Modelled on `src/react/hooks/useOspf.ts`.
 *
 * The hook does NO business logic. It only:
 *   1. resolves the engine from a deviceId,
 *   2. selects the right Signal,
 *   3. subscribes via useEngineSignal (useSyncExternalStore under the hood),
 *   4. returns the VM (or a STABLE fallback when the engine is absent).
 *
 * Don't forget to re-export from `src/react/hooks/index.ts`.
 */

import { useEngineSignal } from './useEngineSignal';
import type { Equipment } from '@/network/equipment/Equipment';
import type { LldpEngine } from '@/network/lldp/LldpEngine';
import type { LldpNeighborVM, LldpRuntimeVM } from '@/network/lldp/observables';

// Stable fallbacks declared at module scope so the reference never changes
// across renders (prevents needless re-renders when the engine is absent).
const EMPTY_NEIGHBORS: ReadonlyArray<LldpNeighborVM> = [];
const EMPTY_RUNTIME: LldpRuntimeVM = {
  enabled: false,
  txCount: 0,
  rxCount: 0,
  neighborCount: 0,
};

/** Resolve the engine instance attached to a device, or null. */
function resolveLldp(eq: Equipment): LldpEngine | null {
  const host = eq as unknown as { _getLldpEngineInternal?: () => LldpEngine | null };
  return host._getLldpEngineInternal?.() ?? null;
}

export function useLldpNeighbors(deviceId: string): ReadonlyArray<LldpNeighborVM> {
  return useEngineSignal(deviceId, resolveLldp, (e) => e.observables.neighbors, EMPTY_NEIGHBORS);
}

export function useLldpRuntime(deviceId: string): LldpRuntimeVM {
  return useEngineSignal(deviceId, resolveLldp, (e) => e.observables.runtime, EMPTY_RUNTIME);
}
