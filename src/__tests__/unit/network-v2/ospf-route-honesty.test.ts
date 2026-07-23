/**
 * Audit 02 (CRITIQUE): OSPFv2 "advanced" routes (redistribute,
 * default-information-originate, inter-area/area-range, NSSA) used to be
 * fabricated by RouterOSPFIntegration.computeAdvancedRoutes() — a god-mode
 * function that read other routers' live route tables and extraConfig maps
 * directly, and hand-rolled a BFS next-hop instead of using SPF. The engine
 * (OSPFEngine) already implements real Type-3/4/5/7 LSA origination and
 * SPF-derived route computation; these tests assert those real LSAs
 * actually appear in the LSDB and propagate over the wire, not just that
 * a plausible-looking RIB entry shows up.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

describe('OSPFv2 external routes flow through real Type-5 LSAs, not a fabricated RIB copy', () => {
  it('redistribute static originates a real Type-5 LSA in the ASBR\'s own LSDB', async () => {
    const r1 = new CiscoRouter('R1');
    await run(r1, [
      'enable', 'configure terminal',
      'ip route 172.16.0.0 255.255.0.0 203.0.113.1',
      'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'redistribute static subnets', 'network 10.0.12.0 0.0.0.3 area 0', 'end',
    ]);

    const ospf1 = (r1 as any)._getOSPFEngineInternal();
    const external = [...ospf1.getLSDB().external.values()];
    expect(external.some((lsa: any) => lsa.lsType === 5 && lsa.linkStateId === '172.16.0.0')).toBe(true);
  });

  it('a router two hops from the ASBR sees the real Type-5 LSA itself, not just a RIB entry', async () => {
    const r1 = new CiscoRouter('R1'); // ASBR
    const r2 = new CiscoRouter('R2');
    const r3 = new CiscoRouter('R3');

    await run(r1, [
      'enable', 'configure terminal',
      'ip route 172.16.0.0 255.255.0.0 203.0.113.1',
      'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'redistribute static subnets', 'network 10.0.12.0 0.0.0.3 area 0', 'end',
    ]);
    await run(r2, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.252', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.23.2 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'network 10.0.12.0 0.0.0.3 area 0', 'network 10.0.23.0 0.0.0.3 area 0', 'end',
    ]);
    await run(r3, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.23.3 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'network 10.0.23.0 0.0.0.3 area 0', 'end',
    ]);
    new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    new Cable('c23').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);

    const show = await r3.executeCommand('show ip ospf database external');
    expect(show).toContain('172.16.0.0');
    expect(show).toContain('10.0.12.1'); // advertising router (the ASBR itself, R1)
  });
});

describe('OSPFv2 inter-area routes flow through real Type-3 Summary LSAs and area ranges', () => {
  it('an area range aggregate is a real Type-3 LSA in the backbone LSDB, and the individual routes are absent from it', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2'); // ABR

    await run(r1, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.252', 'no shutdown', 'exit',
      'interface Loopback1', 'ip address 192.168.1.1 255.255.255.0', 'exit',
      'interface Loopback2', 'ip address 192.168.2.1 255.255.255.0', 'exit',
      'router ospf 1',
      'network 10.0.12.0 0.0.0.3 area 1', 'network 192.168.1.0 0.0.0.255 area 1', 'network 192.168.2.0 0.0.0.255 area 1',
      'end',
    ]);
    await run(r2, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.252', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.23.2 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'area 1 range 192.168.0.0 255.255.0.0',
      'network 10.0.12.0 0.0.0.3 area 1', 'network 10.0.23.0 0.0.0.3 area 0', 'end',
    ]);
    new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    await r2.executeCommand('show ip route'); // force autoConverge before inspecting the engine directly
    const ospf2 = (r2 as any)._getOSPFEngineInternal();
    const backboneDB = [...(ospf2.getAreaLSDB('0')?.values() ?? [])];
    const summaries = backboneDB.filter((lsa: any) => lsa.lsType === 3);
    expect(summaries.some((lsa: any) => lsa.linkStateId === '192.168.0.0')).toBe(true);
    expect(summaries.some((lsa: any) => lsa.linkStateId === '192.168.1.0')).toBe(false);
    expect(summaries.some((lsa: any) => lsa.linkStateId === '192.168.2.0')).toBe(false);
  });
});

describe('OSPFv2 NSSA Type-7→Type-5 translation is real, driven by installLSA() on the ABR', () => {
  it('the NSSA ASBR never holds a Type-5 for its own redistributed route; only the ABR does, after translation', async () => {
    const r1 = new CiscoRouter('R1'); // ASBR in NSSA area 1
    const r2 = new CiscoRouter('R2'); // ABR: area 1 (nssa) + area 0

    await run(r1, [
      'enable', 'configure terminal',
      'ip route 172.16.1.0 255.255.255.0 203.0.113.1',
      'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'area 1 nssa', 'redistribute static subnets', 'network 10.0.12.0 0.0.0.3 area 1', 'end',
    ]);
    await run(r2, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.252', 'no shutdown', 'exit',
      'interface GigabitEthernet0/1', 'ip address 10.0.23.2 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'area 1 nssa', 'network 10.0.12.0 0.0.0.3 area 1', 'network 10.0.23.0 0.0.0.3 area 0', 'end',
    ]);
    new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    await r2.executeCommand('show ip route');

    const ospf1 = (r1 as any)._getOSPFEngineInternal();
    const ospf2 = (r2 as any)._getOSPFEngineInternal();

    // R1 (NSSA ASBR, not itself an ABR) only ever originates the Type-7 —
    // real OSPF/RFC 3101 forbids a plain NSSA-area ASBR from originating Type-5.
    const r1Type7 = [...(ospf1.getAreaLSDB('1')?.values() ?? [])].filter((l: any) => l.lsType === 7);
    expect(r1Type7.some((l: any) => l.linkStateId === '172.16.1.0')).toBe(true);
    expect([...ospf1.getLSDB().external.values()].length).toBe(0);

    // R2 (the ABR) is the one that translates it into a real Type-5.
    const r2External = [...ospf2.getLSDB().external.values()];
    expect(r2External.some((l: any) => l.lsType === 5 && l.linkStateId === '172.16.1.0' && l.advertisingRouter === ospf2.getRouterId())).toBe(true);
  });

  it('the translated Type-5 propagates across a second hop into the backbone', async () => {
    const r1 = new CiscoRouter('R1'); // ASBR in NSSA area 1
    const r2 = new CiscoRouter('R2'); // ABR
    const r3 = new CiscoRouter('R3'); // backbone

    await run(r1, [
      'enable', 'configure terminal',
      'ip route 172.16.1.0 255.255.255.0 203.0.113.1',
      'interface G0/0', 'ip address 10.0.12.1 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'area 1 nssa', 'redistribute static subnets', 'network 10.0.12.0 0.0.0.3 area 1', 'end',
    ]);
    await run(r2, [
      'enable', 'configure terminal',
      'interface G0/0', 'ip address 10.0.12.2 255.255.255.252', 'no shutdown', 'exit',
      'interface G0/1', 'ip address 10.0.23.2 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'area 1 nssa', 'network 10.0.12.0 0.0.0.3 area 1', 'network 10.0.23.0 0.0.0.3 area 0', 'end',
    ]);
    await run(r3, [
      'enable', 'configure terminal',
      'interface G0/0', 'ip address 10.0.23.3 255.255.255.252', 'no shutdown', 'exit',
      'router ospf 1', 'network 10.0.23.0 0.0.0.3 area 0', 'end',
    ]);
    new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
    new Cable('c23').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);

    const show = await r3.executeCommand('show ip ospf database external');
    expect(show).toContain('172.16.1.0');
    const route = await r3.executeCommand('show ip route 172.16.1.0');
    expect(route).toContain('O E2 172.16.1.0/24');
  });
});
