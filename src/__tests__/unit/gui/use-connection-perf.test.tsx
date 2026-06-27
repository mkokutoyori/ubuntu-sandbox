/** @vitest-environment jsdom */

import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { useConnectionPerf } from '@/react/hooks';
import { __test__ } from '@/react/hooks/useConnectionPerf';
import type { Connection } from '@/store/networkStore';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function makeLab() {
  const a = new LinuxPC('linux-pc', 'pcA', 0, 0);
  const b = new LinuxPC('linux-pc', 'pcB', 0, 0);
  const portA = a.getPort('eth0')!;
  const portB = b.getPort('eth0')!;
  const cable = new Cable('cab-1');
  cable.connect(portA, portB);
  const conn: Connection = {
    sourceDeviceId: a.getId(),
    sourceInterfaceId: 'eth0',
    targetDeviceId: b.getId(),
    targetInterfaceId: 'eth0',
    cable,
    type: 'ethernet',
  };
  const resolve = (id: string) => id === a.getId() ? a : id === b.getId() ? b : undefined;
  return { a, b, portA, portB, conn, resolve };
}

describe('useConnectionPerf — pure formatter helpers', () => {
  it('fmtBandwidth covers all magnitudes', () => {
    expect(__test__.fmtBandwidth(0)).toBe('N/A');
    expect(__test__.fmtBandwidth(1544)).toBe('1.5 Mbps');
    expect(__test__.fmtBandwidth(100_000)).toBe('100 Mbps');
    expect(__test__.fmtBandwidth(1_000_000)).toBe('1 Gbps');
    expect(__test__.fmtBandwidth(10_000_000)).toBe('10 Gbps');
  });

  it('fmtLatency covers sub-100us and ms', () => {
    expect(__test__.fmtLatency(0)).toBe('N/A');
    expect(__test__.fmtLatency(50)).toBe('< 0.1 ms');
    expect(__test__.fmtLatency(500)).toBe('0.5 ms');
    expect(__test__.fmtLatency(5000)).toBe('5.0 ms');
  });
});

describe('useConnectionPerf — read-model integration', () => {
  it('reads the live port speed and delay', () => {
    const { conn, resolve } = makeLab();
    const { result } = renderHook(() => useConnectionPerf(conn, resolve));
    // Default Port speed = 1000 Mbps → 1_000_000 kbps → "1 Gbps".
    expect(result.current.bandwidthLabel).toBe('1 Gbps');
    expect(result.current.latencyLabel).toMatch(/ms$|< 0\.1 ms/);
    expect(result.current.resolved).toBe(true);
  });

  it('re-renders when a port speed changes (port.config.speed-changed)', async () => {
    const { portA, conn, resolve } = makeLab();
    const { result } = renderHook(() => useConnectionPerf(conn, resolve));
    expect(result.current.bandwidthLabel).toBe('1 Gbps');

    act(() => { portA.setSpeed(100); });
    // 100 Mbps on one side → link is constrained to 100 Mbps.
    await waitFor(() => expect(result.current.bandwidthLabel).toBe('100 Mbps'));
  });

  it('takes the slower side when speeds differ (min)', () => {
    const { portA, portB, conn, resolve } = makeLab();
    portA.setSpeed(1000);
    portB.setSpeed(10);
    const { result } = renderHook(() => useConnectionPerf(conn, resolve));
    expect(result.current.bandwidthKbps).toBe(10_000);
  });

  it('console connections always report N/A', () => {
    const { conn, resolve } = makeLab();
    const consoleConn: Connection = { ...conn, type: 'console' };
    const { result } = renderHook(() => useConnectionPerf(consoleConn, resolve));
    expect(result.current.bandwidthLabel).toBe('N/A');
    expect(result.current.latencyLabel).toBe('N/A');
    expect(result.current.resolved).toBe(true);
  });

  it('returns resolved=false when an endpoint device cannot be looked up', () => {
    const { conn } = makeLab();
    const empty = () => undefined;
    const { result } = renderHook(() => useConnectionPerf(conn, empty));
    expect(result.current.resolved).toBe(false);
    expect(result.current.bandwidthLabel).toBe('N/A');
  });

  it('returns resolved=false when connection is null', () => {
    const { result } = renderHook(() => useConnectionPerf(null, () => undefined));
    expect(result.current.resolved).toBe(false);
  });
});
