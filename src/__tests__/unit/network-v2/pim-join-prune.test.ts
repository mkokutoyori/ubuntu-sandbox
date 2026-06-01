import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { matchesGroupRange, ipToUint32 } from '@/network/pim/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('PIM helpers — group-range matching', () => {
  it('ipToUint32 round-trips dotted-quad to host order', () => {
    expect(ipToUint32('0.0.0.0')).toBe(0);
    expect(ipToUint32('255.255.255.255')).toBe(0xffffffff);
    expect(ipToUint32('10.1.2.3')).toBe((10 << 24 | 1 << 16 | 2 << 8 | 3) >>> 0);
  });

  it('matchesGroupRange covers IPv4 multicast 224.0.0.0/4', () => {
    expect(matchesGroupRange('239.1.2.3', '224.0.0.0', 4)).toBe(true);
    expect(matchesGroupRange('224.0.0.1', '224.0.0.0', 4)).toBe(true);
    expect(matchesGroupRange('192.168.1.1', '224.0.0.0', 4)).toBe(false);
  });

  it('matchesGroupRange respects narrower group ranges', () => {
    expect(matchesGroupRange('239.10.0.5', '239.10.0.0', 16)).toBe(true);
    expect(matchesGroupRange('239.11.0.5', '239.10.0.0', 16)).toBe(false);
  });
});

describe('PIM RP — static configuration', () => {
  it('addStaticRp resolves the RP for a covered group', () => {
    const r = new CiscoRouter('R1');
    r.getPimAgent().addStaticRp('10.0.0.99');
    expect(r.getPimAgent().resolveRpForGroup('239.1.2.3')).toBe('10.0.0.99');
  });

  it('most-specific group-range wins when multiple RPs are configured', () => {
    const r = new CiscoRouter('R1');
    r.getPimAgent().addStaticRp('10.0.0.99');
    r.getPimAgent().addStaticRp('10.0.0.42', '239.10.0.0', 16);
    expect(r.getPimAgent().resolveRpForGroup('239.10.0.5')).toBe('10.0.0.42');
    expect(r.getPimAgent().resolveRpForGroup('239.11.0.5')).toBe('10.0.0.99');
  });

  it('removeStaticRp falls back to the next matching RP', () => {
    const r = new CiscoRouter('R1');
    r.getPimAgent().addStaticRp('10.0.0.99');
    r.getPimAgent().addStaticRp('10.0.0.42', '239.10.0.0', 16);
    r.getPimAgent().removeStaticRp('10.0.0.42');
    expect(r.getPimAgent().resolveRpForGroup('239.10.0.5')).toBe('10.0.0.99');
  });
});

describe('PIM (*,G) — local joinGroup / leaveGroup', () => {
  it('joinGroup populates a (*,G) mroute with the OIF, IIF, and upstream', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r1.getPort('GigabitEthernet0/1')!.configureIP(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/1', 'sparse');
    r2.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');

    r1.getPimAgent().addStaticRp('10.0.0.2');
    r1.getPimAgent().joinGroup('239.5.5.5', 'GigabitEthernet0/1');

    const m = r1.getPimAgent().getMroute('239.5.5.5');
    expect(m).toBeDefined();
    expect(m!.entryType).toBe('star-g');
    expect(m!.rpAddress).toBe('10.0.0.2');
    expect(Array.from(m!.outgoingInterfaces)).toEqual(['GigabitEthernet0/1']);
    expect(m!.incomingInterface).toBe('GigabitEthernet0/0');
    expect(m!.upstreamNeighborIp).toBe('10.0.0.2');
  });

  it('joinGroup sends a (*,G) Join upstream and the RP router learns the OIF', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r1.getPort('GigabitEthernet0/1')!.configureIP(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/1', 'sparse');
    r2.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');

    r1.getPimAgent().addStaticRp('10.0.0.2');
    r1.getPimAgent().joinGroup('239.5.5.5', 'GigabitEthernet0/1');

    const m2 = r2.getPimAgent().getMroute('239.5.5.5');
    expect(m2).toBeDefined();
    expect(Array.from(m2!.outgoingInterfaces)).toEqual(['GigabitEthernet0/0']);
  });

  it('leaveGroup with the last OIF sends a Prune and removes the mroute', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r1.getPort('GigabitEthernet0/1')!.configureIP(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/1', 'sparse');
    r2.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');

    r1.getPimAgent().addStaticRp('10.0.0.2');
    r1.getPimAgent().joinGroup('239.5.5.5', 'GigabitEthernet0/1');
    expect(r2.getPimAgent().getMroute('239.5.5.5')).toBeDefined();

    r1.getPimAgent().leaveGroup('239.5.5.5', 'GigabitEthernet0/1');
    expect(r1.getPimAgent().getMroute('239.5.5.5')).toBeUndefined();
    expect(r2.getPimAgent().getMroute('239.5.5.5')).toBeUndefined();
  });
});

describe('PIM (*,G) — multiple OIFs', () => {
  it('a second joinGroup OIF adds to the OIL without rewriting upstream', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r1.getPort('GigabitEthernet0/1')!.configureIP(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
    r1.getPort('GigabitEthernet0/2')!.configureIP(new IPAddress('192.168.2.1'), new SubnetMask('255.255.255.0'));
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/1', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/2', 'sparse');
    r2.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');

    r1.getPimAgent().addStaticRp('10.0.0.2');
    r1.getPimAgent().joinGroup('239.5.5.5', 'GigabitEthernet0/1');
    r1.getPimAgent().joinGroup('239.5.5.5', 'GigabitEthernet0/2');
    const m = r1.getPimAgent().getMroute('239.5.5.5');
    expect(Array.from(m!.outgoingInterfaces).sort()).toEqual(['GigabitEthernet0/1', 'GigabitEthernet0/2']);
    expect(m!.incomingInterface).toBe('GigabitEthernet0/0');
  });
});

describe('PIM (*,G) — Join/Prune reactive bus', () => {
  it('publishes pim.mroute.changed with reason=join when a Join goes out', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r1.getPort('GigabitEthernet0/1')!.configureIP(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/1', 'sparse');
    r2.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().addStaticRp('10.0.0.2');
    const changes: Array<{ group: string; reason: string }> = [];
    bus.subscribe('pim.mroute.changed', (e) => changes.push(e.payload));
    r1.getPimAgent().joinGroup('239.5.5.5', 'GigabitEthernet0/1');
    expect(changes.some(c => c.group === '239.5.5.5' && c.reason === 'join')).toBe(true);
  });
});

describe('PIM Join/Prune — upstream-neighbor filter', () => {
  it('a Join addressed to a different upstream neighbor is ignored', () => {
    const bus = new EventBus();
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const r3 = new CiscoRouter('R3');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r1.setEventBus(bus); r2.setEventBus(bus); r3.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('b').connect(r2.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('c').connect(r3.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/2')!);
    r1.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r2.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    r3.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.3'), new SubnetMask('255.255.255.0'));
    r1.getPort('GigabitEthernet0/1')!.configureIP(new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/1', 'sparse');
    r2.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r3.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');
    r1.getPimAgent().enableInterface('GigabitEthernet0/0', 'sparse');

    r1.getPimAgent().addStaticRp('10.0.0.2');
    r1.getPimAgent().joinGroup('239.9.9.9', 'GigabitEthernet0/1');

    expect(r2.getPimAgent().getMroute('239.9.9.9')).toBeDefined();
    expect(r3.getPimAgent().getMroute('239.9.9.9')).toBeUndefined();
  });
});
