/**
 * @vitest-environment jsdom
 *
 * Phase 6 — React hooks integration tests.
 *
 * Validates that the new reactive hooks (`useSignal`, `useDevices`,
 * `useArpTable`, `useBusEvents`) actually re-render their consumer when
 * the underlying signal or bus topic changes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress } from '@/network/core/types';
import { WritableSignal } from '@/events/Signal';
import {
  useSignal, useDevices, useDevice,
  useArpTable, useHostStats, useBusEvents,
  useNatStats, useIPSecStats, useDhcpServerStats,
} from '@/react/hooks';

describe('Phase 6 — React hooks', () => {
  let bus: EventBus;

  beforeEach(() => {
    EquipmentRegistry.resetInstance();
    bus = new EventBus();
    __setDefaultEventBus(bus);
    EquipmentRegistry.getInstance().setEventBus(bus);
  });

  afterEach(() => {
    EquipmentRegistry.getInstance().setEventBus(null);
    EquipmentRegistry.resetInstance();
    __setDefaultEventBus(null);
  });

  it('useSignal re-renders when the signal changes', () => {
    const sig = new WritableSignal(0);
    const { result } = renderHook(() => useSignal(sig));
    expect(result.current).toBe(0);
    act(() => sig.set(42));
    expect(result.current).toBe(42);
  });

  it('useDevices reflects registry additions and removals', () => {
    const { result } = renderHook(() => useDevices());
    expect(result.current).toEqual([]);

    let pc: LinuxPC;
    act(() => {
      pc = new LinuxPC('linux-pc', 'PC1');
      pc.setEventBus(bus);
    });
    expect(result.current.length).toBe(1);
    expect(result.current[0].name).toBe('PC1');

    act(() => {
      EquipmentRegistry.getInstance().deregister(pc.getId());
    });
    expect(result.current.length).toBe(0);
  });

  it('useDevice returns the projection of a single device', () => {
    let pc!: LinuxPC;
    act(() => { pc = new LinuxPC('linux-pc', 'PC2'); pc.setEventBus(bus); });
    const { result } = renderHook(() => useDevice(pc.getId()));
    expect(result.current?.name).toBe('PC2');
    expect(result.current?.type).toBe('linux-pc');
  });

  it('useArpTable re-renders when addStaticARP fires', () => {
    let pc!: LinuxPC;
    act(() => { pc = new LinuxPC('linux-pc', 'PC3'); pc.setEventBus(bus); });

    const { result } = renderHook(() => useArpTable(pc.getId()));
    expect(result.current).toEqual([]);

    act(() => {
      pc.addStaticARP('10.0.0.42', MACAddress.parse('aa:bb:cc:dd:ee:ff'), 'eth0');
    });
    expect(result.current.length).toBe(1);
    expect(result.current[0].ip).toBe('10.0.0.42');
  });

  it('useHostStats tracks arp cache size', () => {
    let pc!: LinuxPC;
    act(() => { pc = new LinuxPC('linux-pc', 'PC4'); pc.setEventBus(bus); });

    const { result } = renderHook(() => useHostStats(pc.getId()));
    expect(result.current.arpCacheSize).toBe(0);
    act(() => {
      pc.addStaticARP('10.0.0.1', MACAddress.parse('aa:bb:cc:dd:ee:01'), 'eth0');
      pc.addStaticARP('10.0.0.2', MACAddress.parse('aa:bb:cc:dd:ee:02'), 'eth0');
    });
    expect(result.current.arpCacheSize).toBe(2);
  });

  it('useBusEvents accumulates events with a bounded ring buffer', () => {
    let pc!: LinuxPC;
    act(() => { pc = new LinuxPC('linux-pc', 'PC5'); pc.setEventBus(bus); });

    const { result } = renderHook(() =>
      useBusEvents('host.arp.entry-learned', { maxEntries: 3, bus }),
    );
    expect(result.current).toEqual([]);

    for (let i = 0; i < 5; i++) {
      act(() => {
        pc.addStaticARP(`10.0.0.${i + 1}`, MACAddress.parse(`aa:bb:cc:dd:ee:0${i}`), 'eth0');
      });
    }
    expect(result.current.length).toBe(3);
    // ring buffer keeps the last 3
    expect(result.current[result.current.length - 1].payload.ip).toBe('10.0.0.5');
  });

  it('useArpTable returns empty array for unknown devices', () => {
    const { result } = renderHook(() => useArpTable('unknown-id'));
    expect(result.current).toEqual([]);
  });

  it('useNatStats reads NATEngine.observables.stats from a CiscoRouter', () => {
    let r1!: CiscoRouter;
    act(() => { r1 = new CiscoRouter('R1'); r1.setEventBus(bus); });
    const { result } = renderHook(() => useNatStats(r1.getId()));
    expect(result.current.sessionCount).toBe(0);
    expect(result.current.hits).toBe(0);
  });

  it('useIPSecStats falls back to empty when IPSec engine not configured', () => {
    let r1!: CiscoRouter;
    act(() => { r1 = new CiscoRouter('R2'); r1.setEventBus(bus); });
    const { result } = renderHook(() => useIPSecStats(r1.getId()));
    expect(result.current.running).toBe(false);
    expect(result.current.activeIkeSAs).toBe(0);
  });

  it('useDhcpServerStats reads the router DHCP server signal store', () => {
    let r1!: CiscoRouter;
    act(() => { r1 = new CiscoRouter('R3'); r1.setEventBus(bus); });
    const { result } = renderHook(() => useDhcpServerStats(r1.getId()));
    expect(result.current.running).toBe(false);
    expect(result.current.poolCount).toBe(0);
  });
});
