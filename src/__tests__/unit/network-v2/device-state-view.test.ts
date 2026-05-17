/**
 * TDD — Lot A of the device state-inspection layer
 * (docs/DESIGN-DEVICE-STATE-INSPECTION.md).
 *
 * The EquipmentStateView facade must project the REAL topology: real
 * cabled neighbours, real per-port state. Anti-stub: an unconnected
 * port must NOT manufacture a neighbour entry.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentStateView } from '@/network/devices/inspection/EquipmentStateView';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('EquipmentStateView (inspection facade, Lot A)', () => {
  it('identity reflects the real device', () => {
    const r = new CiscoRouter('R1');
    const id = new EquipmentStateView(r).identity();
    expect(id.hostname).toBe('R1');
    expect(id.type).toBe('router-cisco');
    expect(id.capability).toBe('Router');
    expect(id.platform).toMatch(/Cisco/);
  });

  it('neighbors() returns ONLY real cabled peers (anti-stub)', () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const pc = new LinuxPC('linux-pc', 'L1', 0, 0);
    new Cable('w1').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    new Cable('w2').connect(r1.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);

    const ns = new EquipmentStateView(r1).neighbors();
    expect(ns).toHaveLength(2);
    const byHost = Object.fromEntries(ns.map((n) => [n.remoteHost, n]));
    expect(byHost['R2'].localPort).toBe('GigabitEthernet0/1');
    expect(byHost['R2'].remotePort).toBe('GigabitEthernet0/1');
    expect(byHost['R2'].remoteCapability).toBe('Router');
    expect(byHost['L1'].localPort).toBe('GigabitEthernet0/0');
    expect(byHost['L1'].remoteCapability).toBe('Host');
    // No fabricated entry for the uncabled Gi0/2.
    expect(ns.some((n) => n.localPort === 'GigabitEthernet0/2')).toBe(false);
  });

  it('interfaces() reflects real configured IP & admin state', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 10.9.9.1 255.255.255.0');
    await r.executeCommand('description LOT-A');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');

    const ifs = new EquipmentStateView(r).interfaces();
    const gi0 = ifs.find((i) => i.name === 'GigabitEthernet0/0')!;
    expect(gi0.ip).toBe('10.9.9.1');
    expect(gi0.prefixLength).toBe(24);
    expect(gi0.adminUp).toBe(false);
    expect(gi0.description).toBe('LOT-A');
  });
});
