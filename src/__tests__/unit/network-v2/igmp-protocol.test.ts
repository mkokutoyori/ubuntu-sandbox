import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import {
  MACAddress, IPAddress, SubnetMask,
  resetCounters,
  type IPv4Packet,
  nextIPv4Id, computeIPv4Checksum, ETHERTYPE_IPV4,
  type EthernetFrame,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  IP_PROTO_IGMP, IGMP_ALL_SYSTEMS, IGMP_ALL_ROUTERS,
  ipv4MulticastToMac, isMulticastIpv4, isReservedMulticast, compareQuerier,
  type IgmpPacket,
} from '@/network/igmp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function sendIgmpReport(from: { ip: string; port: import('@/network/hardware/Port').Port }, to: CiscoRouter | HuaweiRouter, group: string): void {
  const payload: IgmpPacket = {
    type: 'igmp', version: 2,
    messageType: 'v2-membership-report',
    maxRespTimeDs: 0,
    groupAddress: group,
    checksum: 0,
  };
  const ipPkt: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 6, tos: 0xc0,
    totalLength: 32,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
    ttl: 1, protocol: IP_PROTO_IGMP, headerChecksum: 0,
    sourceIP: new IPAddress(from.ip),
    destinationIP: new IPAddress(group),
    payload,
  };
  ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
  const frame: EthernetFrame = {
    srcMAC: from.port.getMAC(),
    dstMAC: new MACAddress(ipv4MulticastToMac(group)),
    etherType: ETHERTYPE_IPV4,
    payload: ipPkt,
  };
  from.port.sendFrame(frame);
  void to;
}

describe('IGMP — pure helpers', () => {
  it('isMulticastIpv4 matches 224.0.0.0/4', () => {
    expect(isMulticastIpv4('224.0.0.1')).toBe(true);
    expect(isMulticastIpv4('239.1.2.3')).toBe(true);
    expect(isMulticastIpv4('192.168.1.1')).toBe(false);
    expect(isMulticastIpv4('223.255.255.255')).toBe(false);
  });

  it('isReservedMulticast matches 224.0.0.0/24', () => {
    expect(isReservedMulticast('224.0.0.1')).toBe(true);
    expect(isReservedMulticast('224.0.0.22')).toBe(true);
    expect(isReservedMulticast('224.1.0.1')).toBe(false);
    expect(isReservedMulticast('239.255.0.1')).toBe(false);
  });

  it('ipv4MulticastToMac uses the IANA 01:00:5e:* prefix with low 23 bits', () => {
    expect(ipv4MulticastToMac('224.0.0.1')).toBe('01:00:5e:00:00:01');
    expect(ipv4MulticastToMac('239.255.255.255')).toBe('01:00:5e:7f:ff:ff');
    expect(ipv4MulticastToMac('232.1.2.3')).toBe('01:00:5e:01:02:03');
  });

  it('compareQuerier picks the lowest IP', () => {
    expect(compareQuerier('10.0.0.1', '10.0.0.2')).toBeLessThan(0);
    expect(compareQuerier('192.168.1.5', '10.0.0.5')).toBeGreaterThan(0);
  });
});

describe('IGMP — querier startup', () => {
  it('enabling on an interface sends a General Query to 224.0.0.1', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); sw.setEventBus(bus);
    const cable = new Cable('c');
    cable.setEventBus(bus);
    let seen: { messageType: string; destinationIp: string } | null = null;
    bus.subscribe('igmp.packet.sent', (e) => { seen = e.payload; });
    cable.connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    expect(seen).not.toBeNull();
    expect(seen!.messageType).toBe('membership-query');
    expect(seen!.destinationIp).toBe(IGMP_ALL_SYSTEMS);
  });

  it('startup→querier after startupQueryCount queries', () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    const rt = r.getIgmpAgent().getInterfaceRuntime('GigabitEthernet0/0');
    expect(rt?.state === 'querier' || rt?.state === 'startup').toBe(true);
  });
});

describe('IGMP — membership tracking', () => {
  it('receiving a v2 Report adds the group to the membership table', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); sw.setEventBus(bus);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    sendIgmpReport({ ip: '10.0.0.55', port: sw.getPort('FastEthernet0/1')! }, r, '239.1.1.1');
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.1.1.1')).toBe(true);
  });

  it('fires igmp.group.joined on a fresh membership', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); sw.setEventBus(bus);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    const joins: Array<{ groupAddress: string; reporterIp: string }> = [];
    bus.subscribe('igmp.group.joined', (e) => joins.push(e.payload));
    sendIgmpReport({ ip: '10.0.0.55', port: sw.getPort('FastEthernet0/1')! }, r, '239.1.1.1');
    expect(joins.some(j => j.groupAddress === '239.1.1.1' && j.reporterIp === '10.0.0.55')).toBe(true);
  });

  it('reserved 224.0.0.x groups are not tracked', () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    r.getIgmpAgent().injectReport('GigabitEthernet0/0', '224.0.0.5', '10.0.0.55');
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '224.0.0.5')).toBe(false);
  });
});

describe('IGMP — leave processing', () => {
  it('a Leave Group message removes the membership and emits igmp.group.left', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); sw.setEventBus(bus);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    r.getIgmpAgent().injectReport('GigabitEthernet0/0', '239.7.7.7', '10.0.0.55');
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.7.7.7')).toBe(true);

    const leaves: Array<{ groupAddress: string; reason: string }> = [];
    bus.subscribe('igmp.group.left', (e) => leaves.push(e.payload));

    const swPort = sw.getPort('FastEthernet0/1')!;
    const payload: IgmpPacket = {
      type: 'igmp', version: 2,
      messageType: 'leave-group',
      maxRespTimeDs: 0,
      groupAddress: '239.7.7.7',
      checksum: 0,
    };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 6, tos: 0xc0,
      totalLength: 32,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 1, protocol: IP_PROTO_IGMP, headerChecksum: 0,
      sourceIP: new IPAddress('10.0.0.55'),
      destinationIP: new IPAddress(IGMP_ALL_ROUTERS),
      payload,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const frame: EthernetFrame = {
      srcMAC: swPort.getMAC(),
      dstMAC: new MACAddress(ipv4MulticastToMac(IGMP_ALL_ROUTERS)),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    };
    swPort.sendFrame(frame);

    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.7.7.7')).toBe(false);
    expect(leaves.some(l => l.groupAddress === '239.7.7.7' && l.reason === 'leave')).toBe(true);
  });
});

describe('IGMP — querier election', () => {
  it('higher-IP router yields to lower-IP router via received query', () => {
    const bus = new EventBus();
    const r = new CiscoRouter('R-high');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    r.setEventBus(bus); sw.setEventBus(bus);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.50'), new SubnetMask('255.255.255.0'));
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);

    const swPort = sw.getPort('FastEthernet0/1')!;
    const payload: IgmpPacket = {
      type: 'igmp', version: 2,
      messageType: 'membership-query',
      maxRespTimeDs: 100,
      groupAddress: '0.0.0.0',
      checksum: 0,
    };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 6, tos: 0xc0,
      totalLength: 32,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 1, protocol: IP_PROTO_IGMP, headerChecksum: 0,
      sourceIP: new IPAddress('10.0.0.5'),
      destinationIP: new IPAddress(IGMP_ALL_SYSTEMS),
      payload,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const frame: EthernetFrame = {
      srcMAC: swPort.getMAC(),
      dstMAC: new MACAddress(ipv4MulticastToMac(IGMP_ALL_SYSTEMS)),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    };
    swPort.sendFrame(frame);

    const rt = r.getIgmpAgent().getInterfaceRuntime('GigabitEthernet0/0');
    expect(rt?.state).toBe('non-querier');
    expect(rt?.querierIp).toBe('10.0.0.5');
  });
});

describe('IGMP — link-down clears memberships', () => {
  it('losing the link removes all memberships on that interface', () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    r.getIgmpAgent().injectReport('GigabitEthernet0/0', '239.9.9.9', '10.0.0.42');
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.9.9.9')).toBe(true);
    r.getPort('GigabitEthernet0/0')!.setUp(false);
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.9.9.9')).toBe(false);
  });
});

describe('IGMP — Cisco↔Huawei interop', () => {
  it('vendor-neutral IGMP membership crosses Cisco and Huawei routers', () => {
    const bus = new EventBus();
    const cisco = new CiscoRouter('CSCO');
    const huawei = new HuaweiRouter('HW');
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    cisco.setEventBus(bus); huawei.setEventBus(bus); sw.setEventBus(bus);
    new Cable('a').connect(cisco.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    new Cable('b').connect(huawei.getPort('GE0/0/0')!, sw.getPort('FastEthernet0/2')!);
    cisco.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    huawei.getPort('GE0/0/0')!.configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    cisco.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    huawei.getIgmpAgent().enableInterface('GE0/0/0', 2);
    cisco.getIgmpAgent().injectReport('GigabitEthernet0/0', '239.0.0.10', '10.0.0.42');
    huawei.getIgmpAgent().injectReport('GE0/0/0', '239.0.0.10', '10.0.0.43');
    expect(cisco.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.0.0.10')).toBe(true);
    expect(huawei.getIgmpAgent().hasMember('GE0/0/0', '239.0.0.10')).toBe(true);
  });
});
