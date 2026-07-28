import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import {
  MACAddress, IPAddress, SubnetMask, resetCounters,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

let vts: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  vts = new VirtualTimeScheduler();
  __setDefaultScheduler(vts);
});

afterEach(() => {
  __setDefaultScheduler(null);
});

function ciscoLab() {
  const bus = new EventBus();
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const r = new CiscoRouter('R1');
  sw.setEventBus(bus); r.setEventBus(bus);
  new Cable('c1').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
  r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  return { bus, sw, r };
}

async function run(sw: CiscoSwitch, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of lines) out.push(await sw.executeCommand(l));
  return out;
}

describe('IGMP snooping — static mrouter port (P5, Cisco)', () => {
  it('ip igmp snooping vlan X mrouter interface Y pins the port', async () => {
    const { sw } = ciscoLab();
    await run(sw, [
      'enable', 'configure terminal',
      'ip igmp snooping vlan 1 mrouter interface FastEthernet0/1',
      'end',
    ]);
    const agent = sw.getIgmpSnoopingAgent();
    expect(agent.isStaticRouterPort(1, 'FastEthernet0/1')).toBe(true);
    expect(agent.getVlanState(1)?.routerPorts.has('FastEthernet0/1')).toBe(true);
  });

  it('the static port never ages out, while a learned one does', async () => {
    const { sw, r } = ciscoLab();
    await run(sw, [
      'enable', 'configure terminal',
      'ip igmp snooping vlan 1 mrouter interface FastEthernet0/1',
      'end',
    ]);
    // A real Query from the router makes FastEthernet0/2 a *dynamic* router port.
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    const agent = sw.getIgmpSnoopingAgent();
    expect(agent.getVlanState(1)?.routerPorts.has('FastEthernet0/2')).toBe(true);

    // Router-port age is 260 s with no further Query observed.
    r.getIgmpAgent().stop();
    vts.advance(300_000);
    expect(agent.getVlanState(1)?.routerPorts.has('FastEthernet0/2')).toBe(false);
    expect(agent.getVlanState(1)?.routerPorts.has('FastEthernet0/1')).toBe(true);
  });

  it('multicast traffic still egresses the static mrouter port', async () => {
    const { sw } = ciscoLab();
    await run(sw, [
      'enable', 'configure terminal',
      'ip igmp snooping vlan 1 mrouter interface FastEthernet0/1',
      'end',
    ]);
    const egress = sw.getIgmpSnoopingAgent().computeEgressPorts('FastEthernet0/3', '239.1.1.1');
    expect(egress).toContain('FastEthernet0/1');
  });

  it('the configuration survives a link flap on that port', async () => {
    const { sw } = ciscoLab();
    await run(sw, [
      'enable', 'configure terminal',
      'ip igmp snooping vlan 1 mrouter interface FastEthernet0/1',
      'end',
    ]);
    const agent = sw.getIgmpSnoopingAgent();
    sw.getPort('FastEthernet0/1')!.setUp(false);
    expect(agent.getVlanState(1)?.routerPorts.has('FastEthernet0/1')).toBe(false);
    expect(agent.isStaticRouterPort(1, 'FastEthernet0/1')).toBe(true);
    sw.getPort('FastEthernet0/1')!.setUp(true);
    expect(agent.getVlanState(1)?.routerPorts.has('FastEthernet0/1')).toBe(true);
  });

  it('no ip igmp snooping vlan X mrouter interface Y removes it', async () => {
    const { sw } = ciscoLab();
    await run(sw, [
      'enable', 'configure terminal',
      'ip igmp snooping vlan 1 mrouter interface FastEthernet0/1',
      'no ip igmp snooping vlan 1 mrouter interface FastEthernet0/1',
      'end',
    ]);
    const agent = sw.getIgmpSnoopingAgent();
    expect(agent.isStaticRouterPort(1, 'FastEthernet0/1')).toBe(false);
    expect(agent.getVlanState(1)?.routerPorts.has('FastEthernet0/1')).toBe(false);
  });

  it('show ip igmp snooping mrouter distinguishes static from dynamic', async () => {
    const { sw, r } = ciscoLab();
    await run(sw, [
      'enable', 'configure terminal',
      'ip igmp snooping vlan 1 mrouter interface FastEthernet0/1',
      'end',
    ]);
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    const out = await sw.executeCommand('show ip igmp snooping mrouter');
    expect(out).toMatch(/FastEthernet0\/1\(static\)/);
    expect(out).toMatch(/FastEthernet0\/2\(dynamic\)/);
  });

  it('rejects an unknown interface name', async () => {
    const { sw } = ciscoLab();
    await run(sw, ['enable', 'configure terminal']);
    const out = await sw.executeCommand('ip igmp snooping vlan 1 mrouter interface FastEthernet9/9');
    expect(out).toMatch(/Invalid interface/);
  });
});

describe('IGMP snooping — static router port (P5, Huawei)', () => {
  it('igmp-snooping static-router-port pins the port in VLAN view', async () => {
    const bus = new EventBus();
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    sw.setEventBus(bus);
    const names = sw.getPortNames();
    for (const l of [
      'system-view',
      'vlan 1',
      `igmp-snooping static-router-port interface ${names[0]}`,
      'quit',
    ]) await sw.executeCommand(l);
    const agent = sw.getIgmpSnoopingAgent();
    expect(agent.isStaticRouterPort(1, names[0])).toBe(true);

    const out = await sw.executeCommand('display igmp-snooping');
    expect(out).toMatch(new RegExp(`Static router ports:.*${names[0].replace(/\//g, '\\/')}`));
  });

  it('undo igmp-snooping static-router-port removes it', async () => {
    const bus = new EventBus();
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    sw.setEventBus(bus);
    const names = sw.getPortNames();
    for (const l of [
      'system-view',
      'vlan 1',
      `igmp-snooping static-router-port interface ${names[0]}`,
      `undo igmp-snooping static-router-port interface ${names[0]}`,
    ]) await sw.executeCommand(l);
    expect(sw.getIgmpSnoopingAgent().isStaticRouterPort(1, names[0])).toBe(false);
  });
});
