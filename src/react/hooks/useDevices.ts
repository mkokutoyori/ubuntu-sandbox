/**
 * `useDevices` / `useDevice` — list and single-device hooks driven by
 * the `EquipmentRegistry`'s lifecycle events (`device.registered`,
 * `device.deregistered`, `registry.cleared`).
 *
 * Returns lightweight projection objects (`DeviceVM`) so the UI doesn't
 * hold direct references to `Equipment` instances — keeping with the
 * Phase 6.7 "read-model" architecture.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getDefaultEventBus } from '@/events/EventBus';
import type { Equipment } from '@/network/equipment/Equipment';

export interface DeviceVM {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly poweredOn: boolean;
}

function projectDevice(eq: Equipment): DeviceVM {
  return {
    id: eq.getId(),
    name: eq.getName(),
    type: String(eq.getDeviceType()),
    poweredOn: eq.getIsPoweredOn(),
  };
}

function projectAll(registry: EquipmentRegistry): DeviceVM[] {
  return registry.getAll().map(projectDevice);
}

/**
 * Subscribe to the registry. We rely on `useSyncExternalStore`-style
 * cache-busting: every relevant event swaps the "version" number, which
 * causes the memoised projection to recompute.
 */
function useRegistryVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bus = getDefaultEventBus();
    const bump = () => setVersion((v) => v + 1);
    const subs = [
      bus.subscribe('device.registered', bump),
      bus.subscribe('device.deregistered', bump),
      bus.subscribe('registry.cleared', bump),
    ];
    return () => { for (const u of subs) u(); };
  }, []);
  return version;
}

export function useDevices(): DeviceVM[] {
  const version = useRegistryVersion();
  // Recompute snapshot when the registry version changes.
  return useMemo(
    () => projectAll(EquipmentRegistry.getInstance()),
    [version],
  );
}

export function useDevice(id: string | null | undefined): DeviceVM | undefined {
  const version = useRegistryVersion();
  return useMemo(() => {
    if (!id) return undefined;
    const eq = EquipmentRegistry.getInstance().getById(id);
    return eq ? projectDevice(eq) : undefined;
  }, [id, version]);
}
