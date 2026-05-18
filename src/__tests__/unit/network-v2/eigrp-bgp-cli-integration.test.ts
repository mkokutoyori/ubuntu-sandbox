/**
 * TDD — EIGRP/BGP engines wired into the Router via the CLI. Two
 * genuinely cabled CiscoRouters, configured through the real CLI,
 * form adjacencies and install learned routes into the RIB
 * (`show ip route` shows D / B). A lone router learns nothing (true).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

async function baseAddrs(r: CiscoRouter, lan: string, wan: string) {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand(`ip address ${lan} 255.255.255.0`);
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  await r.executeCommand('interface GigabitEthernet0/1');
  await r.executeCommand(`ip address ${wan} 255.255.255.252`);
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  await r.executeCommand('end');
}

function wire(r1: CiscoRouter, r2: CiscoRouter) {
  new Cable('wan').connect(
    r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
}

describe('EIGRP via CLI — real RIB integration', () => {
  it('two cabled routers (same AS) install learned D routes', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await baseAddrs(r1, '192.168.1.1', '10.0.0.1');
    await baseAddrs(r2, '192.168.2.1', '10.0.0.2');
    wire(r1, r2);
    for (const r of [r1, r2]) {
      await r.executeCommand('configure terminal');
      await r.executeCommand('router eigrp 100');
      await r.executeCommand('network 192.168.0.0 0.0.255.255');
      await r.executeCommand('network 10.0.0.0 0.0.0.3');
      await r.executeCommand('end');
    }
    const route1 = await r1.executeCommand('show ip route');
    expect(route1).toMatch(/D\s+192\.168\.2\.0\/24 \[90\/\d+\] via 10\.0\.0\.2/);
    const route2 = await r2.executeCommand('show ip route');
    expect(route2).toMatch(/D\s+192\.168\.1\.0\/24 \[90\/\d+\] via 10\.0\.0\.1/);

    // Live show family reflects the real adjacency.
    const nbr = await r1.executeCommand('show ip eigrp neighbors');
    expect(nbr).toMatch(/AS\(100\)/);
    expect(nbr).toContain('10.0.0.2');
    expect(nbr).not.toMatch(/no real EIGRP peer/);
    expect(await r1.executeCommand('show ip eigrp topology'))
      .toMatch(/192\.168\.2\.0\/24, 1 successors/);
  });

  it('lone router with EIGRP learns nothing (true state)', async () => {
    const r1 = new CiscoRouter('R1');
    await baseAddrs(r1, '192.168.1.1', '10.0.0.1');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('router eigrp 100');
    await r1.executeCommand('network 192.168.0.0 0.0.255.255');
    await r1.executeCommand('end');
    expect(await r1.executeCommand('show ip route')).not.toMatch(/^D\s/m);
  });
});

describe('BGP via CLI — real RIB integration', () => {
  it('reciprocal eBGP peers install learned B routes', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await baseAddrs(r1, '192.168.1.1', '10.0.0.1');
    await baseAddrs(r2, '192.168.2.1', '10.0.0.2');
    wire(r1, r2);
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('router bgp 65001');
    await r1.executeCommand('neighbor 10.0.0.2 remote-as 65002');
    await r1.executeCommand('network 192.168.1.0 mask 255.255.255.0');
    await r1.executeCommand('end');
    await r2.executeCommand('configure terminal');
    await r2.executeCommand('router bgp 65002');
    await r2.executeCommand('neighbor 10.0.0.1 remote-as 65001');
    await r2.executeCommand('network 192.168.2.0 mask 255.255.255.0');
    await r2.executeCommand('end');

    const route1 = await r1.executeCommand('show ip route');
    expect(route1).toMatch(/B\s+192\.168\.2\.0\/24 \[20\/\d+\] via 10\.0\.0\.2/);

    const sum = await r1.executeCommand('show ip bgp summary');
    expect(sum).toMatch(/local AS number 65001/);
    expect(sum).toMatch(/10\.0\.0\.2.*Established/);
    expect(await r1.executeCommand('show ip bgp neighbors'))
      .toMatch(/BGP state = Established/);
  });

  it('no reciprocal neighbour ⇒ no B route (true state)', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await baseAddrs(r1, '192.168.1.1', '10.0.0.1');
    await baseAddrs(r2, '192.168.2.1', '10.0.0.2');
    wire(r1, r2);
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('router bgp 65001');
    await r1.executeCommand('neighbor 10.0.0.2 remote-as 65002');
    await r1.executeCommand('network 192.168.1.0 mask 255.255.255.0');
    await r1.executeCommand('end');
    // R2 never configures BGP back.
    expect(await r1.executeCommand('show ip route')).not.toMatch(/^B\s/m);
  });
});
