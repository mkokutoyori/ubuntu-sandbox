/**
 * Equipment hooks — expose the base device read-models (identity/power detail
 * and ports) that EVERY `Equipment` projects via `deviceObservables`.
 *
 * These let the UI consume device state reactively as plain view-models,
 * without holding a reference to the mutable `Equipment` instance (objective
 * O5: decouple the View from the domain).
 */

import { useEngineSignal } from './useEngineSignal';
import type { Equipment } from '@/network/equipment/Equipment';
import type { DeviceDetailVM, PortVM } from '@/network/equipment/observables';

// Stable fallbacks at module scope so the reference never changes across renders.
const FALLBACK_DETAIL: DeviceDetailVM = {
  id: '',
  name: '',
  hostname: '',
  type: '',
  poweredOn: false,
  uptimeMs: 0,
  portCount: 0,
};
const EMPTY_PORTS: ReadonlyArray<PortVM> = [];

/** The "engine" is the Equipment itself — it owns `deviceObservables`. */
const resolveSelf = (eq: Equipment): Equipment => eq;

export function useDeviceDetail(deviceId: string): DeviceDetailVM {
  return useEngineSignal(deviceId, resolveSelf, (eq) => eq.deviceObservables.detail, FALLBACK_DETAIL);
}

export function usePorts(deviceId: string): ReadonlyArray<PortVM> {
  return useEngineSignal(deviceId, resolveSelf, (eq) => eq.deviceObservables.ports, EMPTY_PORTS);
}
