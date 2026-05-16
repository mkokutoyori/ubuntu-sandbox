/**
 * Host-specific hooks — read the per-device signal store exposed by
 * EndHost (Phase 5.0–5.3). Each hook re-renders when the underlying
 * Signal notifies.
 *
 * Resolution rule:
 *  - the device is looked up in the EquipmentRegistry by id;
 *  - if it's not an EndHost (no `.observables` field), the hook returns
 *    an empty projection;
 *  - if the device is unregistered later, the last snapshot is kept
 *    until the consumer re-mounts.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getDefaultEventBus } from '@/events/EventBus';
import type {
  HostObservables,
  HostArpEntryVM,
  HostNdpEntryVM,
  HostRouteVM,
  HostTcpListenerVM,
  HostTcpConnectionVM,
  HostStatsVM,
} from '@/network/devices/host/observables';

/** Resolve a device id to its `observables` map, or `null` if unavailable. */
function resolveObservables(deviceId: string): HostObservables | null {
  const eq = EquipmentRegistry.getInstance().getById(deviceId);
  if (!eq) return null;
  // Duck-type — EndHost exposes a public `observables` field.
  const obs = (eq as unknown as { observables?: HostObservables }).observables;
  return obs ?? null;
}

/**
 * Reactive accessor for an arbitrary signal on the host's observables.
 *
 * Combines two reactive sources:
 *  - the EquipmentRegistry lifecycle (device may register late);
 *  - the per-signal subscription (re-renders on data changes).
 */
function useHostSignal<K extends keyof HostObservables>(
  deviceId: string,
  key: K,
): ReturnType<HostObservables[K]['get']> {
  // Track registry version so that a late-registering device shows up.
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

  const signal = useMemo(() => {
    const obs = resolveObservables(deviceId);
    return obs ? obs[key] : null;
  }, [deviceId, key, version]);

  return useSyncExternalStore(
    (onChange) => signal ? signal.subscribe(onChange) : () => {},
    () => (signal ? signal.get() : emptyValueFor(key)),
    () => (signal ? signal.get() : emptyValueFor(key)),
  ) as ReturnType<HostObservables[K]['get']>;
}

const EMPTY_ARRAY: ReadonlyArray<never> = [];
const EMPTY_STATS: HostStatsVM = {
  arpCacheSize: 0,
  ndpCacheSize: 0,
  routeCount: 0,
  tcpListeners: 0,
  tcpConnections: 0,
  icmpEchosSent: 0,
  icmpEchosReceived: 0,
  icmpTimeouts: 0,
  arpRequestsSent: 0,
};

function emptyValueFor(key: keyof HostObservables): unknown {
  return key === 'stats' ? EMPTY_STATS : EMPTY_ARRAY;
}

export function useArpTable(deviceId: string): ReadonlyArray<HostArpEntryVM> {
  return useHostSignal(deviceId, 'arp');
}

export function useNdpTable(deviceId: string): ReadonlyArray<HostNdpEntryVM> {
  return useHostSignal(deviceId, 'ndp');
}

export function useHostRoutingTable(deviceId: string): ReadonlyArray<HostRouteVM> {
  return useHostSignal(deviceId, 'routes');
}

export function useTcpListeners(deviceId: string): ReadonlyArray<HostTcpListenerVM> {
  return useHostSignal(deviceId, 'tcpListeners');
}

export function useTcpConnections(deviceId: string): ReadonlyArray<HostTcpConnectionVM> {
  return useHostSignal(deviceId, 'tcpConnections');
}

export function useHostStats(deviceId: string): HostStatsVM {
  return useHostSignal(deviceId, 'stats');
}
