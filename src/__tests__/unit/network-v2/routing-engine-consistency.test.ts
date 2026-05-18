/**
 * TDD — full routing-engine consistency. RIP/OSPF/EIGRP/BGP all
 * satisfy the SAME IRoutingProtocolEngine contract + shared reactive
 * read-model (via Adapter for the frame-driven RIP/OSPF cores). The
 * adapters reflect the REAL engine state — no behaviour change to the
 * existing RIP/OSPF packet path.
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

async function addrs(r: CiscoRouter, lan: string, wan: string) {
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

describe('Routing-engine consistency (unified contract)', () => {
  it('all four engines expose the same IRoutingProtocolEngine surface', () => {
    const r = new CiscoRouter('R1');
    const engines = r.getDynamicRouting().allEngines();
    const tags = engines.map((e) => e.protocol).sort();
    expect(tags).toEqual(['bgp', 'eigrp', 'ospf', 'rip']);
    for (const e of engines) {
      expect(typeof e.isEnabled).toBe('function');
      expect(typeof e.getNeighbors).toBe('function');
      expect(typeof e.getContributedRoutes).toBe('function');
      expect(typeof e.converge).toBe('function');
      // Shared reactive read-model present on every engine.
      expect(e.observables.neighbors.get()).toEqual([]);
      expect(e.observables.stats.get().running).toBe(false);
      expect(e.isEnabled()).toBe(false);
      expect(e.getContributedRoutes()).toEqual([]);
    }
  });

  it('RIP adapter reflects the real engine enabled via CLI', async () => {
    const r = new CiscoRouter('R1');
    await addrs(r, '192.168.1.1', '10.0.0.1');
    await r.executeCommand('configure terminal');
    await r.executeCommand('router rip');
    await r.executeCommand('version 2');
    await r.executeCommand('network 192.168.1.0');
    await r.executeCommand('end');
    const rip = r.getDynamicRouting().rip;
    expect(rip.isEnabled()).toBe(true);
    expect(rip.protocol).toBe('rip');
    rip.converge();
    expect(rip.observables.stats.get().running).toBe(true);
  });

  it('OSPF adapter reflects a REAL adjacency between two cabled routers', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await addrs(r1, '192.168.1.1', '10.0.0.1');
    await addrs(r2, '192.168.2.1', '10.0.0.2');
    new Cable('wan').connect(
      r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    for (const [r, id] of [[r1, '1.1.1.1'], [r2, '2.2.2.2']] as const) {
      await r.executeCommand('configure terminal');
      await r.executeCommand('router ospf 1');
      await r.executeCommand(`router-id ${id}`);
      await r.executeCommand('network 10.0.0.0 0.0.0.3 area 0');
      await r.executeCommand('network 192.168.0.0 0.0.255.255 area 0');
      await r.executeCommand('end');
    }
    // Drive OSPF (frame/timer core) then read via the unified adapter.
    await r1.executeCommand('show ip ospf neighbor');
    const ospf = r1.getDynamicRouting().ospf;
    expect(ospf.isEnabled()).toBe(true);
    ospf.converge();
    const ns = ospf.getNeighbors();
    expect(ns.length).toBeGreaterThanOrEqual(1);
    expect(ns.some((n) => n.isUp && n.state === 'Established')).toBe(true);
    expect(ospf.getContributedRoutes().some(
      (rt) => rt.protocol === 'ospf')).toBe(true);
  });

  it('disabled adapters contribute nothing (true state, no fabrication)', () => {
    const r = new CiscoRouter('R1');
    const { rip, ospf } = r.getDynamicRouting();
    expect(rip.isEnabled()).toBe(false);
    expect(rip.getNeighbors()).toEqual([]);
    expect(ospf.isEnabled()).toBe(false);
    expect(ospf.getContributedRoutes()).toEqual([]);
  });
});
