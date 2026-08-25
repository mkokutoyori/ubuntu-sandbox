/**
 * @vitest-environment jsdom
 *
 * PRD-Suppression-Bus-Partage increment 3 — the canvas observes what it
 * owns, not a process-wide bus.
 *
 * Written BLIND. The eight hooks under `src/react/hooks/` all reach for
 * `getDefaultEventBus()`. What they actually watch splits in three, and
 * each half has a rightful owner that is not a shared bus:
 *
 *   - TOPOLOGY lifecycle (`device.registered`, `device.deregistered`,
 *     `registry.cleared`) — the canvas legitimately needs to know a
 *     device appeared. The owner is the registry that decides it, and it
 *     should say so directly rather than through a bus anyone can read.
 *   - PER-DEVICE state (`port.link.*`, `port.config.*`, `oracle.*`) —
 *     the owner is the device being rendered, and it already has its own
 *     machine bus.
 *   - FRAMES (`cable.frame.dispatched`, for the packet animation) — the
 *     owner is the tap of increment 1, which is what a real capture is.
 *
 * The behavioural cases pin what must NOT change: the canvas still sees
 * a device appear, disappear, and the topology being cleared. The
 * structural case is the guard.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { renderHook, act } from '@testing-library/react';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { useDevices } from '@/react/hooks/useDevices';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('the canvas still sees the topology change', () => {
  it('a device registered after mount shows up', () => {
    const { result } = renderHook(() => useDevices());
    const before = result.current.length;

    act(() => { new LinuxPC('linux-pc', 'PC1', 0, 0); });

    expect(result.current.length).toBe(before + 1);
    expect(result.current.some(d => d.name === 'PC1')).toBe(true);
  });

  it('a device deregistered after mount disappears', () => {
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    const { result } = renderHook(() => useDevices());

    act(() => { EquipmentRegistry.getInstance().deregister(pc.getId()); });

    expect(result.current.some(d => d.name === 'PC1')).toBe(false);
  });

  it('clearing the topology empties the list', () => {
    new LinuxPC('linux-pc', 'PC1', 0, 0);
    const { result } = renderHook(() => useDevices());

    act(() => { EquipmentRegistry.getInstance().clear(); });

    expect(result.current).toHaveLength(0);
  });
});

describe('the registry says it itself', () => {
  it('a listener hears a registration without any bus', () => {
    const heard: string[] = [];
    const off = EquipmentRegistry.getInstance().subscribe(() => heard.push('change'));

    new LinuxPC('linux-pc', 'PC1', 0, 0);
    off();
    new LinuxPC('linux-pc', 'PC2', 0, 0);

    expect(heard).toHaveLength(1);
  });
});

describe('no hook reads the shared bus', () => {
  it('src/react/hooks names getDefaultEventBus nowhere', () => {
    const offenders = readdirSync('src/react/hooks')
      .filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
      .filter(name => /getDefaultEventBus/.test(
        readFileSync(`src/react/hooks/${name}`, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
