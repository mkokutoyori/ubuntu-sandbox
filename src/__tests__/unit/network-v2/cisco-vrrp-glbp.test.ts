/**
 * TDD — Lot C: VRRP & GLBP as config-driven real state, reusing the
 * FhrpRepository pattern established for HSRP. No stubs: show output
 * reflects the configured groups and the live interface state.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('Cisco VRRP/GLBP — config-driven real state', () => {
  it('vrrp config is recognised and projected by show vrrp', async () => {
    const r = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'L1', 0, 0);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    for (const c of [
      'vrrp 1 ip 192.168.1.254',
      'vrrp 1 priority 120',
      'vrrp 1 preempt delay minimum 15',
      'vrrp 1 timers advertise 1',
      'vrrp 1 authentication md5 key-string V1',
      'vrrp 1 description LAN-VRRP',
    ]) {
      expect(await r.executeCommand(c), c).not.toMatch(/Invalid input|Incomplete/);
    }
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');

    const det = await r.executeCommand('show vrrp');
    expect(det).toContain('Group 1');
    expect(det).toContain('192.168.1.254');
    expect(det).toContain('Priority is 120');
    expect(det).toMatch(/State is Master/);
    const brief = await r.executeCommand('show vrrp brief');
    expect(brief).toContain('192.168.1.254');
  });

  it('glbp config is recognised and projected by show glbp', async () => {
    const r = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'L1', 0, 0);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    for (const c of [
      'glbp 1 ip 192.168.1.250',
      'glbp 1 priority 150',
      'glbp 1 preempt delay minimum 30',
      'glbp 1 load-balancing host-dependent',
      'glbp 1 weighting 100 lower 90 upper 95',
      'glbp 1 name GLBP-1',
    ]) {
      expect(await r.executeCommand(c), c).not.toMatch(/Invalid input|Incomplete/);
    }
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');

    const det = await r.executeCommand('show glbp');
    expect(det).toContain('Group 1');
    expect(det).toContain('192.168.1.250');
    expect(det).toContain('Priority 150');
    expect(det).toContain('host-dependent');
    expect(det).toMatch(/State is Active/);
    expect(await r.executeCommand('show glbp brief')).toContain('192.168.1.250');
  });

  it('no vrrp / no glbp remove the real groups', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('vrrp 2 ip 10.0.0.2');
    await r.executeCommand('glbp 3 ip 10.0.0.3');
    await r.executeCommand('no vrrp 2');
    await r.executeCommand('no glbp 3');
    await r.executeCommand('end');
    expect(await r.executeCommand('show vrrp')).not.toContain('Group 2');
    expect(await r.executeCommand('show glbp')).not.toContain('Group 3');
  });
});
