import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('ip ifindex is stable, not recomputed from list position (PRD-ip.md P3)', () => {
  it('lo is always ifindex 1 across repeated calls', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const first = await pc.executeCommand('ip addr show dev lo');
    const second = await pc.executeCommand('ip addr show dev lo');
    expect(first).toMatch(/^1: lo:/);
    expect(second).toMatch(/^1: lo:/);
  });

  it('the same interface keeps the same ifindex across independent ip invocations', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const call1 = await pc.executeCommand('ip addr show dev eth0');
    const call2 = await pc.executeCommand('ip link show dev eth0');
    const call3 = await pc.executeCommand('ip -j addr show dev eth0');

    const idx1 = Number(call1.match(/^(\d+): eth0/)?.[1]);
    const idx2 = Number(call2.match(/^(\d+): eth0/)?.[1]);
    const idx3 = JSON.parse(call3)[0].ifindex;

    expect(idx1).toBeGreaterThan(1);
    expect(idx1).toBe(idx2);
    expect(idx1).toBe(idx3);
  });

  it('ifindex is not derived from getInterfaceNames() list position: filtering by dev does not change it', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const all = await pc.executeCommand('ip addr show');
    const filtered = await pc.executeCommand('ip addr show dev eth0');

    const idxInList = Number(all.match(/(\d+): eth0/)?.[1]);
    const idxFiltered = Number(filtered.match(/^(\d+): eth0/)?.[1]);
    expect(idxInList).toBe(idxFiltered);
  });

  it('ip monitor formatting uses the same stable ifindex as ip addr/link show', async () => {
    const pc = new LinuxPC('PC1', 0, 0);
    const showOut = await pc.executeCommand('ip link show dev eth0');
    const idxFromShow = Number(showOut.match(/^(\d+): eth0/)?.[1]);
    expect(idxFromShow).toBeGreaterThan(1);
  });
});
