/**
 * @vitest-environment jsdom
 *
 * Phase 7c — React hook tests for the Oracle observables surface.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import {
  resetAllOracleInstances, getOracleDatabase,
} from '@/terminal/commands/database';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  useOracleInstanceState, useOracleAlertLog,
  useOracleProcesses, useOracleStats,
} from '@/react/hooks';

describe('Phase 7c — Oracle React hooks', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.resetInstance();
    EquipmentRegistry.getInstance().setEventBus(bus);
    resetAllOracleInstances();
  });

  afterEach(() => {
    resetAllOracleInstances();
    EquipmentRegistry.getInstance().setEventBus(null);
    EquipmentRegistry.resetInstance();
    __setDefaultEventBus(null);
  });

  it('useOracleInstanceState returns SHUTDOWN fallback when no Oracle is running', () => {
    const { result } = renderHook(() => useOracleInstanceState('nope'));
    expect(result.current.state).toBe('SHUTDOWN');
    expect(result.current.startedAt).toBeNull();
  });

  it('useOracleInstanceState reflects startup transition to OPEN', () => {
    const { result } = renderHook(() => useOracleInstanceState('srv-A'));
    expect(result.current.state).toBe('SHUTDOWN');

    act(() => { getOracleDatabase('srv-A'); }); // triggers startup('OPEN')
    expect(result.current.state).toBe('OPEN');
    expect(result.current.sid).toBeTruthy();
  });

  it('useOracleProcesses lists the background processes started on OPEN', () => {
    const { result } = renderHook(() => useOracleProcesses('srv-B'));
    expect(result.current).toEqual([]);

    act(() => { getOracleDatabase('srv-B'); });
    // PMON/SMON/DBW0/LGWR/CKPT/RECO/MMON/MMNL = at least 8
    expect(result.current.length).toBeGreaterThanOrEqual(8);
    expect(result.current.some((p) => p.name === 'PMON')).toBe(true);
  });

  it('useOracleAlertLog accumulates the alert log lines', () => {
    const { result } = renderHook(() => useOracleAlertLog('srv-C'));
    expect(result.current.lines).toEqual([]);

    act(() => { getOracleDatabase('srv-C'); });
    expect(result.current.lines.length).toBeGreaterThanOrEqual(3);
    expect(result.current.lines.some((l) => l.includes('Database opened'))).toBe(true);
  });

  it('useOracleStats tracks DML/DDL/commits/rollbacks counters', () => {
    const { result } = renderHook(() => useOracleStats('srv-D'));
    expect(result.current.dmlExecuted).toBe(0);

    act(() => {
      const db = getOracleDatabase('srv-D');
      const { executor } = db.connectAsSysdba();
      executor.setSessionId('t1');
      db.executeSql(executor, 'CREATE TABLE OPH (id NUMBER)');
      db.executeSql(executor, "INSERT INTO OPH VALUES (1)");
      db.executeSql(executor, 'COMMIT');
    });
    expect(result.current.ddlExecuted).toBeGreaterThanOrEqual(1);
    expect(result.current.dmlExecuted).toBeGreaterThanOrEqual(1);
    expect(result.current.commits).toBeGreaterThanOrEqual(1);
  });
});
