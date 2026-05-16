/**
 * @vitest-environment jsdom
 *
 * Phase 6 — render-test for the LiveDeviceStats devtools panel.
 *
 * Validates the end-to-end reactive flow: mutating an EndHost via its
 * public API causes the panel to re-render with the new ARP entry,
 * without any intermediate Zustand action.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act, screen } from '@testing-library/react';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress } from '@/network/core/types';
import { LiveDeviceStats } from '@/components/network/devtools/LiveDeviceStats';

describe('LiveDeviceStats', () => {
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

  it('shows "No device selected" for unknown ids', () => {
    render(<LiveDeviceStats deviceId="nope" />);
    expect(screen.getByText('No device selected.')).toBeTruthy();
  });

  it('renders the device card and re-renders when ARP is mutated', () => {
    let pc!: LinuxPC;
    act(() => { pc = new LinuxPC('linux-pc', 'PC-LIVE'); pc.setEventBus(bus); });

    render(<LiveDeviceStats deviceId={pc.getId()} />);
    expect(screen.getByText('PC-LIVE')).toBeTruthy();
    // ARP cache should be 0 initially
    expect(screen.getByText((c) => c.includes('ARP cache: 0'))).toBeTruthy();

    act(() => {
      pc.addStaticARP('10.0.0.1', MACAddress.parse('aa:bb:cc:dd:ee:01'), 'eth0');
      pc.addStaticARP('10.0.0.2', MACAddress.parse('aa:bb:cc:dd:ee:02'), 'eth0');
    });

    expect(screen.getByText((c) => c.includes('ARP cache: 2'))).toBeTruthy();
    // The ARP table section now shows the entries
    expect(screen.getByText((c) => c.includes('10.0.0.1'))).toBeTruthy();
  });
});
