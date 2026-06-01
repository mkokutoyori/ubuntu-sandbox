import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  IP_PROTO_PIM, PIM_ALL_ROUTERS, PIM_ALL_ROUTERS_MAC,
  compareDrCandidate,
} from '@/network/pim/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('PIM — pure helpers', () => {
  it('compareDrCandidate: higher DR priority wins when both advertise it', () => {
    expect(compareDrCandidate(
      { drPriority: 200, hasDrPriority: true, ip: '10.0.0.1' },
      { drPriority: 100, hasDrPriority: true, ip: '10.0.0.99' },
    )).toBeLessThan(0);
  });

  it('compareDrCandidate: tie on priority broken by highest IP', () => {
    expect(compareDrCandidate(
      { drPriority: 1, hasDrPriority: true, ip: '10.0.0.2' },
      { drPriority: 1, hasDrPriority: true, ip: '10.0.0.1' },
    )).toBeLessThan(0);
  });

  it('compareDrCandidate: missing DR-priority option forces highest-IP tiebreak', () => {
    expect(compareDrCandidate(
      { drPriority: 1, hasDrPriority: false, ip: '10.0.0.2' },
      { drPriority: 50, hasDrPriority: true, ip: '10.0.0.1' },
    )).toBeLessThan(0);
  });
});

describe('PIM — Hello wire format', () => {
  it('a Hello uses IP proto 103 to 224.0.0.13 with MAC 01:00:5e:00:00:0d', async () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); sw.setEventBus(bus);
    const cable = new Cable('c');
    cable.setEventBus(bus);
    let seen: { proto: number; dst: string; mac: string } | null = null;
    bus.subscribe('cable.frame.delivered', (e) => {
      const ipPkt = (e.payload.frame.payload as unknown) as { protocol?: number; destinationIP?: { toString: () => string } } | undefined;
      if (ipPkt?.protocol === IP_PROTO_PIM) {
        seen = {
          proto: ipPkt.protocol,
          dst: ipPkt.destinationIP!.toString(),
          mac: e.payload.frame.dstMAC.toString().toLowerCase(),
        };
      }
    });
    cable.connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');

    expect(seen).not.toBeNull();
    expect(seen!.proto).toBe(IP_PROTO_PIM);
    expect(seen!.dst).toBe(PIM_ALL_ROUTERS);
    expect(seen!.mac).toBe(PIM_ALL_ROUTERS_MAC);
  });
});

describe('PIM — Neighbor discovery', () => {
  it('two cabled PIM-enabled routers learn each other as neighbors', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r2.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');

    const n1 = r1.getPimAgent().listNeighbors('GigabitEthernet0/0');
    const n2 = r2.getPimAgent().listNeighbors('GigabitEthernet0/0');
    expect(n1.length).toBe(1);
    expect(n1[0].neighborIp).toBe('10.0.0.2');
    expect(n2.length).toBe(1);
    expect(n2[0].neighborIp).toBe('10.0.0.1');
  });

  it('fires pim.neighbor.added when the peer first appears', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    const adds: Array<{ deviceId: string; neighborIp: string }> = [];
    bus.subscribe('pim.neighbor.added', (e) => adds.push(e.payload));
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r2.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    expect(adds.some(a => a.deviceId === r1.id && a.neighborIp === '10.0.0.2')).toBe(true);
    expect(adds.some(a => a.deviceId === r2.id && a.neighborIp === '10.0.0.1')).toBe(true);
  });
});

describe('PIM — DR election', () => {
  it('highest IP wins DR with equal priorities (default)', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r2.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    expect(r1.getPimAgent().getInterfaceRuntime('GigabitEthernet0/0')?.designatedRouterIp).toBe('10.0.0.2');
    expect(r2.getPimAgent().getInterfaceRuntime('GigabitEthernet0/0')?.designatedRouterIp).toBe('10.0.0.2');
  });

  it('higher DR priority overrides the IP tiebreaker', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r1.getPimAgent().setDrPriority('GigabitEthernet0/0', 200);
    r2.getPimAgent().setDrPriority('GigabitEthernet0/0', 50);
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r2.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    expect(r1.getPimAgent().getInterfaceRuntime('GigabitEthernet0/0')?.designatedRouterIp).toBe('10.0.0.1');
    expect(r2.getPimAgent().getInterfaceRuntime('GigabitEthernet0/0')?.designatedRouterIp).toBe('10.0.0.1');
  });

  it('publishes pim.dr.changed on DR transition', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    const drs: Array<{ deviceId: string; newDrIp: string }> = [];
    bus.subscribe('pim.dr.changed', (e) => drs.push(e.payload));
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r2.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    expect(drs.some(d => d.deviceId === r1.id && d.newDrIp === '10.0.0.2')).toBe(true);
  });
});

describe('PIM — Link-down', () => {
  it('losing the link drops the neighbor and clears the DR', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r2.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    expect(r1.getPimAgent().listNeighbors('GigabitEthernet0/0').length).toBe(1);
    r1.getPort('GigabitEthernet0/0')!.setUp(false);
    expect(r1.getPimAgent().listNeighbors('GigabitEthernet0/0').length).toBe(0);
    expect(r1.getPimAgent().getInterfaceRuntime('GigabitEthernet0/0')?.designatedRouterIp).toBeNull();
  });
});

describe('PIM — Cisco↔Huawei interop', () => {
  it('vendor-neutral PIM Hello establishes mutual neighbor adjacency', () => {
    const bus = new EventBus();
    const cisco = new CiscoRouter('CSCO');
    const huawei = new HuaweiRouter('HW');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cisco.setEventBus(bus); huawei.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cisco.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(huawei.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/1')!);
    cisco.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    huawei.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    cisco.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    huawei.getPimAgent().enableInterface('GE0/0/0', 'sparse');
    cisco.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    expect(cisco.getPimAgent().listNeighbors('GigabitEthernet0/0').map(n => n.neighborIp)).toEqual(['10.0.0.2']);
    expect(huawei.getPimAgent().listNeighbors('GE0/0/0').map(n => n.neighborIp)).toEqual(['10.0.0.1']);
  });
});

describe('PIM — Disable interface', () => {
  it('disableInterface drops all neighbors and clears DR', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r2.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    expect(r1.getPimAgent().listNeighbors('GigabitEthernet0/0').length).toBe(1);
    r1.getPimAgent().disableInterface('GigabitEthernet0/0');
    expect(r1.getPimAgent().listNeighbors('GigabitEthernet0/0').length).toBe(0);
    expect(r1.getPimAgent().getInterfaceRuntime('GigabitEthernet0/0')?.designatedRouterIp).toBeNull();
  });
});
