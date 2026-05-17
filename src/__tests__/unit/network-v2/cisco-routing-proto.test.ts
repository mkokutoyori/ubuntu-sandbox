/**
 * TDD — Lot C: RIP extra knobs + EIGRP/BGP as config-driven real
 * state (RoutingConfigRepository). Config is recorded and projected
 * by show ip protocols / show ip bgp[ summary] / show ip eigrp …;
 * a lone device has no peers ⇒ BGP Idle, EIGRP 0 neighbours (true).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('Cisco RIP submode — full knob set, real state', () => {
  it('records the standard RIP knobs and keeps real RIP networks', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('router rip');
    for (const c of [
      'version 2', 'no auto-summary', 'network 192.168.1.0',
      'network 10.0.0.0', 'passive-interface GigabitEthernet0/0',
      'passive-interface default', 'no passive-interface GigabitEthernet0/1',
      'neighbor 10.0.0.2', 'timers basic 30 180 180 240', 'distance 120',
      'offset-list 1 in 5 GigabitEthernet0/1', 'redistribute connected',
      'redistribute static metric 3', 'default-information originate',
      'default-metric 4', 'maximum-paths 6', 'output-delay 50',
      'flash-update-threshold 10', 'validate-update-source',
    ]) {
      expect(await r.executeCommand(c), c).not.toMatch(/Invalid input|Incomplete|Unrecognized/);
    }
    await r.executeCommand('end');

    const proto = await r.executeCommand('show ip protocols');
    expect(proto).not.toMatch(/Invalid input/);
    expect(proto).toMatch(/Routing Protocol is "rip"/);
    expect(proto).toMatch(/Automatic network summarization is not in effect/);
    expect(proto).toContain('192.168.1.0');
    expect(proto).toMatch(/Distance: 120/);
    expect(await r.executeCommand('show ip rip database')).toContain('192.168.1.0');
  });
});

describe('Cisco EIGRP — config-driven real state (no engine ⇒ honest)', () => {
  it('router eigrp config is recorded and projected', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('router eigrp 100');
    for (const c of [
      'eigrp router-id 1.1.1.1', 'no auto-summary',
      'network 10.0.0.0 0.0.255.255', 'network 192.168.1.0 0.0.0.255',
      'passive-interface GigabitEthernet0/0', 'variance 4',
      'maximum-paths 6', 'redistribute connected', 'redistribute static',
    ]) {
      expect(await r.executeCommand(c), c).not.toMatch(/Invalid input|Incomplete|Unrecognized/);
    }
    await r.executeCommand('end');

    const proto = await r.executeCommand('show ip protocols');
    expect(proto).toMatch(/Routing Protocol is "eigrp 100"/);
    expect(proto).toContain('1.1.1.1');
    const nbr = await r.executeCommand('show ip eigrp neighbors');
    expect(nbr).not.toMatch(/Invalid input/);
    expect(nbr).toMatch(/AS\(100\)/);
    expect(await r.executeCommand('show ip eigrp topology')).toContain('10.0.0.0');
  });
});

describe('Cisco BGP — config-driven real state (no peer ⇒ Idle)', () => {
  it('router bgp neighbours/networks recorded; summary shows Idle', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('router bgp 65000');
    for (const c of [
      'bgp router-id 1.1.1.1', 'no synchronization',
      'neighbor 10.0.0.2 remote-as 65001',
      'neighbor 10.0.0.2 description PEER-A',
      'neighbor 10.0.0.2 update-source Loopback0',
      'network 192.168.1.0 mask 255.255.255.0',
      'redistribute connected', 'address-family ipv4 unicast',
      'neighbor 10.0.0.2 activate', 'exit-address-family',
    ]) {
      expect(await r.executeCommand(c), c).not.toMatch(/Invalid input|Incomplete|Unrecognized/);
    }
    await r.executeCommand('end');

    const sum = await r.executeCommand('show ip bgp summary');
    expect(sum).not.toMatch(/Invalid input/);
    expect(sum).toMatch(/local AS number 65000/);
    expect(sum).toContain('10.0.0.2');
    expect(sum).toMatch(/Idle/);                 // no peer ⇒ true state
    const tbl = await r.executeCommand('show ip bgp');
    expect(tbl).toContain('192.168.1.0');
    expect(await r.executeCommand('show ip protocols'))
      .toMatch(/Routing Protocol is "bgp 65000"/);
  });

  it('no router bgp removes the process (show ip bgp honest again)', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('router bgp 65000');
    await r.executeCommand('exit');
    await r.executeCommand('no router bgp 65000');
    await r.executeCommand('end');
    expect(await r.executeCommand('show ip bgp')).toMatch(/BGP not active/);
  });
});
