import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import {
  MACAddress, IPAddress, SubnetMask, resetCounters,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function routerLab() {
  const bus = new EventBus();
  const r = new HuaweiRouter('AR1');
  const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
  r.setEventBus(bus); sw.setEventBus(bus);
  const rPort = r.getPortNames()[0];
  const swPort = sw.getPortNames()[0];
  new Cable('c1').connect(r.getPort(rPort)!, sw.getPort(swPort)!);
  r.getPort(rPort)!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  return { bus, r, sw, rPort };
}

async function run(dev: HuaweiRouter | HuaweiSwitch, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of lines) out.push(await dev.executeCommand(l));
  return out;
}

describe('Huawei VRP IGMP CLI — router (P6)', () => {
  it('igmp enable turns IGMP on for the interface', async () => {
    const { r, rPort } = routerLab();
    await run(r, ['system-view', `interface ${rPort}`, 'igmp enable', 'quit', 'quit']);
    expect(r.getIgmpAgent().getInterfaceRuntime(rPort)?.enabled).toBe(true);
  });

  it('undo igmp enable turns it back off', async () => {
    const { r, rPort } = routerLab();
    await run(r, [
      'system-view', `interface ${rPort}`, 'igmp enable', 'undo igmp enable', 'quit', 'quit',
    ]);
    expect(r.getIgmpAgent().getInterfaceRuntime(rPort)?.enabled).toBe(false);
  });

  it('igmp version 1 sets the interface version; version 3 is refused with the RFC reason', async () => {
    const { r, rPort } = routerLab();
    await run(r, ['system-view', `interface ${rPort}`]);
    expect(await r.executeCommand('igmp version 1')).toBe('');
    expect(r.getIgmpAgent().getInterfaceRuntime(rPort)?.version).toBe(1);
    const refusal = await r.executeCommand('igmp version 3');
    expect(refusal).toMatch(/IGMPv3 is not supported/);
    expect(refusal).toMatch(/RFC 3376/);
    expect(r.getIgmpAgent().getInterfaceRuntime(rPort)?.version).toBe(1);
  });

  it('igmp static-group makes the router a configured member', async () => {
    const { r, rPort } = routerLab();
    await run(r, [
      'system-view', `interface ${rPort}`, 'igmp enable', 'igmp static-group 239.1.1.1',
    ]);
    expect(r.getIgmpAgent().hasMember(rPort, '239.1.1.1')).toBe(true);
    await r.executeCommand('undo igmp static-group 239.1.1.1');
    expect(r.getIgmpAgent().hasMember(rPort, '239.1.1.1')).toBe(false);
  });

  it('igmp static-group rejects a non-multicast address', async () => {
    const { r, rPort } = routerLab();
    await run(r, ['system-view', `interface ${rPort}`, 'igmp enable']);
    expect(await r.executeCommand('igmp static-group 10.1.1.1')).toMatch(/Invalid group address/);
    expect(r.getIgmpAgent().listGroups().length).toBe(0);
  });

  it('a configured group reaches PIM, like on Cisco', async () => {
    const { bus, r, rPort } = routerLab();
    const joins: Array<{ groupAddress: string }> = [];
    bus.subscribe('igmp.group.joined', (e) => joins.push(e.payload));
    await run(r, [
      'system-view', `interface ${rPort}`, 'igmp enable', 'igmp static-group 239.2.2.2',
    ]);
    expect(joins.some(j => j.groupAddress === '239.2.2.2')).toBe(true);
    expect(r.getPimAgent().getMroute('239.2.2.2')).toBeDefined();
  });

  it('display igmp group lists the membership', async () => {
    const { r, rPort } = routerLab();
    await run(r, [
      'system-view', `interface ${rPort}`, 'igmp enable', 'igmp static-group 239.3.3.3',
      'quit', 'quit',
    ]);
    const out = await r.executeCommand('display igmp group');
    expect(out).toMatch(/Total 1 IGMP Group reported/);
    expect(out).toMatch(/239\.3\.3\.3/);
    expect(out).toMatch(/never/);
  });

  it('display igmp group says so when nothing is joined', async () => {
    const { r } = routerLab();
    expect(await r.executeCommand('display igmp group')).toMatch(/No IGMP group information/);
  });

  it('display igmp interface reports the interface state and IGMP version', async () => {
    const { r, rPort } = routerLab();
    await run(r, ['system-view', `interface ${rPort}`, 'igmp enable', 'quit', 'quit']);
    const out = await r.executeCommand('display igmp interface');
    expect(out).toMatch(new RegExp(`${rPort.replace(/\//g, '\\/')}\\(10\\.0\\.0\\.1\\)`));
    expect(out).toMatch(/IGMP is enabled/);
    expect(out).toMatch(/Current IGMP version is 2/);
    expect(out).toMatch(/IGMPv3 .* is not supported/);
  });
});

describe('Huawei VRP IGMP snooping CLI — switch (P6)', () => {
  it('fast-leave drives immediate-leave, and display reflects it', async () => {
    const bus = new EventBus();
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    sw.setEventBus(bus);
    await run(sw, ['system-view', 'vlan 1', 'igmp-snooping enable', 'igmp-snooping fast-leave', 'quit']);
    expect(sw.getIgmpSnoopingAgent().getConfig().immediateLeave.has(1)).toBe(true);
    expect(await sw.executeCommand('display igmp-snooping')).toMatch(/Immediate leave: enabled/);
  });

  it('undo igmp-snooping fast-leave turns it back off without disabling snooping', async () => {
    const bus = new EventBus();
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    sw.setEventBus(bus);
    await run(sw, [
      'system-view', 'vlan 1', 'igmp-snooping enable',
      'igmp-snooping fast-leave', 'undo igmp-snooping fast-leave', 'quit',
    ]);
    const agent = sw.getIgmpSnoopingAgent();
    expect(agent.getConfig().immediateLeave.has(1)).toBe(false);
    expect(agent.getVlanState(1)?.enabled).toBe(true);
  });
});
