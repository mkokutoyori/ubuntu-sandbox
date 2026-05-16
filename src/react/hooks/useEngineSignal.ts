/**
 * Generic factory hook for engine-attached signals.
 *
 * Each protocol engine (OSPF / IPSec / RIP / DHCP-client / DHCP-server / NAT)
 * exposes a `.observables` object of `Signal<T>` fields. To plug them into
 * React, we need:
 *  - a resolver that walks the registry from `deviceId` to the engine;
 *  - a key naming the signal on that engine;
 *  - a fallback value when the engine isn't attached yet.
 *
 * This module provides the shared plumbing and exports per-protocol thin
 * wrappers below.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getDefaultEventBus } from '@/events/EventBus';
import type { Signal } from '@/events/Signal';
import type { Equipment } from '@/network/equipment/Equipment';

export type EngineResolver<E> = (device: Equipment) => E | null | undefined;

/** Re-render any time a device registers / deregisters / registry clears. */
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

/**
 * Subscribe to a single signal on an engine reachable from `deviceId`.
 * Returns `fallback` when the device or engine is missing.
 */
export function useEngineSignal<E, T>(
  deviceId: string,
  resolver: EngineResolver<E>,
  signalAccessor: (engine: E) => Signal<T>,
  fallback: T,
): T {
  const version = useRegistryVersion();

  const signal = useMemo(() => {
    const eq = EquipmentRegistry.getInstance().getById(deviceId);
    if (!eq) return null;
    const engine = resolver(eq);
    if (!engine) return null;
    return signalAccessor(engine);
  // resolver and signalAccessor are inline closures created in the call
  // site; we intentionally only depend on deviceId + version to avoid
  // re-subscribing on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, version]);

  return useSyncExternalStore(
    (onChange) => (signal ? signal.subscribe(onChange) : () => {}),
    () => (signal ? signal.get() : fallback),
    () => (signal ? signal.get() : fallback),
  );
}
