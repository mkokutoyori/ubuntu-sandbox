/**
 * Oracle hooks — read OracleInstance.observables from a device by id.
 *
 * Resolution: device → device-scoped OracleDatabase (via the per-device
 * cache maintained by `terminal/commands/database.ts`) → instance.observables.
 *
 * Because `getOracleDatabase` is lazy (Oracle isn't always alive on a
 * device), the hook returns a frozen empty fallback when there's no
 * registered Oracle for the device.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { getDefaultEventBus } from '@/events/EventBus';
import type { Signal } from '@/events/Signal';
import type { OracleObservables, OracleInstanceStateVM, OracleProcessVM,
  OracleAlertLogVM, OracleSessionVM, OracleStatsVM } from '@/database/oracle/observables';
import { getRegisteredOracleDatabase } from '@/terminal/commands/database';

const EMPTY_ARRAY: ReadonlyArray<never> = [];
const EMPTY_INSTANCE: OracleInstanceStateVM = { state: 'SHUTDOWN', sid: '', startedAt: null };
const EMPTY_ALERT: OracleAlertLogVM = { lines: [] };
const EMPTY_STATS: OracleStatsVM = {
  activeSessions: 0, activeTransactions: 0,
  dmlExecuted: 0, ddlExecuted: 0,
  commits: 0, rollbacks: 0, errors: 0,
  redoSwitches: 0, archiveLogs: 0,
};

function resolveObs(deviceId: string): OracleObservables | null {
  const db = getRegisteredOracleDatabase(deviceId);
  return db ? db.instance.observables : null;
}

/** Bump on lifecycle so a late-instantiated Oracle becomes visible. */
function useOracleLifecycleVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bus = getDefaultEventBus();
    const bump = () => setVersion((v) => v + 1);
    // Any oracle.* state-changed or session.connected may be the first signal
    // that an instance is now alive on this device.
    const subs = [
      bus.subscribe('oracle.instance.state-changed', bump),
      bus.subscribe('oracle.session.connected', bump),
    ];
    return () => { for (const u of subs) u(); };
  }, []);
  return version;
}

function useOracleSignal<K extends keyof OracleObservables>(
  deviceId: string,
  key: K,
  fallback: ReturnType<OracleObservables[K]['get']>,
): ReturnType<OracleObservables[K]['get']> {
  const version = useOracleLifecycleVersion();
  const signal = useMemo<Signal<unknown> | null>(() => {
    const obs = resolveObs(deviceId);
    return obs ? obs[key] : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, key, version]);

  return useSyncExternalStore(
    (onChange) => (signal ? signal.subscribe(onChange) : () => {}),
    () => (signal ? signal.get() : fallback),
    () => (signal ? signal.get() : fallback),
  ) as ReturnType<OracleObservables[K]['get']>;
}

export function useOracleInstanceState(deviceId: string): OracleInstanceStateVM {
  return useOracleSignal(deviceId, 'instance', EMPTY_INSTANCE);
}

export function useOracleProcesses(deviceId: string): ReadonlyArray<OracleProcessVM> {
  return useOracleSignal(deviceId, 'processes', EMPTY_ARRAY);
}

export function useOracleAlertLog(deviceId: string): OracleAlertLogVM {
  return useOracleSignal(deviceId, 'alertLog', EMPTY_ALERT);
}

export function useOracleSessions(deviceId: string): ReadonlyArray<OracleSessionVM> {
  return useOracleSignal(deviceId, 'sessions', EMPTY_ARRAY);
}

export function useOracleStats(deviceId: string): OracleStatsVM {
  return useOracleSignal(deviceId, 'stats', EMPTY_STATS);
}
