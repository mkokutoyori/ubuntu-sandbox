/**
 * TDD — Lot C: object tracking + IP SLA as config-driven real state.
 * `track`/`ip sla` config is recorded; `show track`/`show ip sla …`
 * project it; track state is RESOLVED from real device state (port
 * line-protocol, routing table). No fabricated probe results.
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

describe('Cisco object tracking — real resolved state', () => {
  it('track interface line-protocol follows the REAL port', async () => {
    const r = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'L1', 0, 0);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('track 1 interface GigabitEthernet0/0 line-protocol'))
      .not.toMatch(/Invalid input/);
    await r.executeCommand('exit');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');
    expect(await r.executeCommand('show track 1')).toMatch(/State is Up/);

    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('shutdown');
    await r.executeCommand('end');
    expect(await r.executeCommand('show track 1')).toMatch(/State is Down/);
  });

  it('track ip route reachability uses the REAL routing table', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('exit');
    await r.executeCommand('ip route 10.10.0.0 255.255.0.0 192.168.1.2');
    await r.executeCommand('track 2 ip route 10.10.0.0 255.255.0.0 reachability');
    await r.executeCommand('end');
    expect(await r.executeCommand('show track 2')).toMatch(/State is Up/);
    expect(await r.executeCommand('show track brief')).toContain('2');
  });

  it('composite list boolean track combines member states', async () => {
    const r = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'L1', 0, 0);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('exit');
    await r.executeCommand('track 1 interface GigabitEthernet0/0 line-protocol');
    await r.executeCommand('exit');
    await r.executeCommand('track 2 interface GigabitEthernet0/1 line-protocol');
    await r.executeCommand('exit');
    await r.executeCommand('track 10 list boolean and');
    await r.executeCommand('object 1');
    await r.executeCommand('object 2');
    await r.executeCommand('end');
    // Gi0/1 is down ⇒ AND ⇒ Down (real composition, not a stub).
    expect(await r.executeCommand('show track 10')).toMatch(/State is Down/);
  });
});

describe('Cisco IP SLA — config-driven real state', () => {
  it('ip sla operation is recorded and projected', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 192.168.1.1 255.255.255.0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('exit');
    expect(await r.executeCommand('ip sla 1')).not.toMatch(/Invalid input/);
    await r.executeCommand('icmp-echo 192.168.1.9 source-interface GigabitEthernet0/0');
    await r.executeCommand('frequency 5');
    await r.executeCommand('exit');
    await r.executeCommand('ip sla schedule 1 life forever start-time now');
    await r.executeCommand('ip sla responder');
    await r.executeCommand('end');

    const cfg = await r.executeCommand('show ip sla configuration');
    expect(cfg).toContain('192.168.1.9');
    expect(cfg).toMatch(/icmp-echo/);
    const stats = await r.executeCommand('show ip sla statistics');
    expect(stats).not.toMatch(/Invalid input/);
    expect(stats).toMatch(/reachable/);          // 192.168.1.0/24 is connected
    expect(await r.executeCommand('show ip sla responder')).toMatch(/Enabled/);
  });
});
