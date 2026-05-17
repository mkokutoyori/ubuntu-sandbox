/**
 * TDD — Lot C: HSRP as config-driven real state (FhrpRepository).
 * `standby …` mutates real group state; `show standby [brief]`
 * projects it; operational state derives from the real port (a lone
 * speaker owns the group while its interface is up). No stubs.
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

describe('Cisco HSRP — config-driven real state', () => {
  it('standby config is recognised and projected by show standby', async () => {
    const r = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'L1', 0, 0);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    for (const c of [
      'standby version 2',
      'standby 1 ip 192.168.1.254',
      'standby 1 priority 110',
      'standby 1 preempt delay minimum 30',
      'standby 1 timers 1 3',
      'standby 1 authentication md5 key-string Secret1',
      'standby 1 name HSRP-LAN',
      'standby 1 track 1 decrement 20',
    ]) {
      expect(await r.executeCommand(c), c).not.toMatch(/Invalid input|Incomplete|Unrecognized/);
    }
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');

    const det = await r.executeCommand('show standby');
    expect(det).not.toMatch(/Invalid input/);
    expect(det).toContain('Group 1');
    expect(det).toContain('192.168.1.254');     // real configured VIP
    expect(det).toContain('Priority 110');       // real configured priority
    expect(det).toMatch(/State is Active/);      // up port ⇒ sole owner
    expect(det).toContain('HSRP-LAN');
    expect(det).toContain('0000.0c9f.f001');     // v2 virtual MAC for grp 1

    const brief = await r.executeCommand('show standby brief');
    expect(brief).toContain('192.168.1.254');
    expect(brief).toMatch(/Active/);
  });

  it('state follows the REAL interface: shutdown ⇒ Init', async () => {
    const r = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'L1', 0, 0);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('standby 5 ip 10.0.0.1');
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');
    expect(await r.executeCommand('show standby')).toMatch(/State is Active/);

    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    expect(await r.executeCommand('show standby')).toMatch(/State is Init/);
  });

  it('no standby <grp> removes the real group', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('standby 7 ip 172.16.0.1');
    await r.executeCommand('no standby 7');
    await r.executeCommand('end');
    const out = await r.executeCommand('show standby');
    expect(out).not.toContain('Group 7');
  });
});
