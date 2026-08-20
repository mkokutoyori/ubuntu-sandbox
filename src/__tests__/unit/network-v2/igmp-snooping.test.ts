import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import {
  MACAddress, IPAddress, SubnetMask,
  resetCounters,
  type IPv4Packet, type EthernetFrame,
  nextIPv4Id, computeIPv4Checksum, ETHERTYPE_IPV4,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  IP_PROTO_IGMP, IGMP_ALL_SYSTEMS, IGMP_ALL_ROUTERS,
  ipv4MulticastToMac, type IgmpPacket,
} from '@/network/igmp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function sendIgmpFromHostPort(hostPort: import('@/network/hardware/Port').Port, srcIp: string, dstIp: string, payload: IgmpPacket): void {
  const ipPkt: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 6, tos: 0xc0,
    totalLength: 32,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
    ttl: 1, protocol: IP_PROTO_IGMP, headerChecksum: 0,
    sourceIP: new IPAddress(srcIp),
    destinationIP: new IPAddress(dstIp),
    payload,
  };
  ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
  const frame: EthernetFrame = {
    srcMAC: hostPort.getMAC(),
    dstMAC: new MACAddress(ipv4MulticastToMac(dstIp)),
    etherType: ETHERTYPE_IPV4,
    payload: ipPkt,
  };
  hostPort.sendFrame(frame);
}

function sendReport(hostPort: import('@/network/hardware/Port').Port, srcIp: string, group: string): void {
  sendIgmpFromHostPort(hostPort, srcIp, group, {
    type: 'igmp', version: 2,
    messageType: 'v2-membership-report',
    maxRespTimeDs: 0, groupAddress: group, checksum: 0,
  });
}

function sendLeave(hostPort: import('@/network/hardware/Port').Port, srcIp: string, group: string): void {
  sendIgmpFromHostPort(hostPort, srcIp, IGMP_ALL_ROUTERS, {
    type: 'igmp', version: 2,
    messageType: 'leave-group',
    maxRespTimeDs: 0, groupAddress: group, checksum: 0,
  });
}

function sendQuery(hostPort: import('@/network/hardware/Port').Port, srcIp: string): void {
  sendIgmpFromHostPort(hostPort, srcIp, IGMP_ALL_SYSTEMS, {
    type: 'igmp', version: 2,
    messageType: 'membership-query',
    maxRespTimeDs: 100, groupAddress: '0.0.0.0', checksum: 0,
  });
}

describe('IGMP Snooping — Report learning', () => {
  it('a v2 Report on an access port adds (vlan, group, port) to the snooping table', () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const host1 = new CiscoSwitch('switch-cisco', 'H1', 4);
    sw.setEventBus(bus); host1.setEventBus(bus);
    new Cable('c').connect(sw.getPort('FastEthernet0/2')!, host1.getPort('FastEthernet0/1')!);

    sendReport(host1.getPort('FastEthernet0/1')!, '10.0.0.10', '239.1.2.3');
    const groups = sw.getIgmpSnoopingAgent().listGroups();
    expect(groups.length).toBe(1);
    expect(groups[0].vlan).toBe(1);
    expect(groups[0].group.groupAddress).toBe('239.1.2.3');
    expect(Array.from(groups[0].group.members.keys())).toContain('FastEthernet0/2');
  });

  it('publishes igmp.snooping.member.joined the first time a port reports', () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const host1 = new CiscoSwitch('switch-cisco', 'H1', 4);
    sw.setEventBus(bus); host1.setEventBus(bus);
    new Cable('c').connect(sw.getPort('FastEthernet0/2')!, host1.getPort('FastEthernet0/1')!);

    const joins: Array<{ groupAddress: string; port: string }> = [];
    bus.subscribe('igmp.snooping.member.joined', (e) => joins.push(e.payload));
    sendReport(host1.getPort('FastEthernet0/1')!, '10.0.0.10', '239.7.7.7');
    sendReport(host1.getPort('FastEthernet0/1')!, '10.0.0.10', '239.7.7.7');
    expect(joins.length).toBe(1);
    expect(joins[0].groupAddress).toBe('239.7.7.7');
    expect(joins[0].port).toBe('FastEthernet0/2');
  });

  it('reserved 224.0.0.x groups are never tracked', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const host1 = new CiscoSwitch('switch-cisco', 'H1', 4);
    new Cable('c').connect(sw.getPort('FastEthernet0/2')!, host1.getPort('FastEthernet0/1')!);
    sendReport(host1.getPort('FastEthernet0/1')!, '10.0.0.10', '224.0.0.5');
    expect(sw.getIgmpSnoopingAgent().listGroups().length).toBe(0);
  });
});

describe('IGMP Snooping — Router port detection', () => {
  it('a received General Query marks the ingress port as router port', () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const r = new CiscoRouter('R');
    sw.setEventBus(bus); r.setEventBus(bus);
    new Cable('c').connect(sw.getPort('FastEthernet0/1')!, r.getPort('GigabitEthernet0/0')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);

    const v1 = sw.getIgmpSnoopingAgent().getVlanState(1);
    expect(v1?.routerPorts.has('FastEthernet0/1')).toBe(true);
    expect(v1?.querierIp).toBe('10.0.0.1');
  });

  it('publishes router-port.changed with added=true on first query', () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const r = new CiscoRouter('R');
    sw.setEventBus(bus); r.setEventBus(bus);
    new Cable('c').connect(sw.getPort('FastEthernet0/1')!, r.getPort('GigabitEthernet0/0')!);
    const adds: Array<{ port: string; added: boolean }> = [];
    bus.subscribe('igmp.snooping.router-port.changed', (e) => adds.push(e.payload));
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    expect(adds.some(a => a.port === 'FastEthernet0/1' && a.added)).toBe(true);
  });
});

describe('IGMP Snooping — Leave processing', () => {
  it('immediate-leave removes the member synchronously', () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const host1 = new CiscoSwitch('switch-cisco', 'H1', 4);
    sw.setEventBus(bus); host1.setEventBus(bus);
    new Cable('c').connect(sw.getPort('FastEthernet0/2')!, host1.getPort('FastEthernet0/1')!);

    sw.getIgmpSnoopingAgent().setImmediateLeave(1, true);
    sendReport(host1.getPort('FastEthernet0/1')!, '10.0.0.10', '239.5.5.5');
    expect(sw.getIgmpSnoopingAgent().listGroups().length).toBe(1);
    sendLeave(host1.getPort('FastEthernet0/1')!, '10.0.0.10', '239.5.5.5');
    expect(sw.getIgmpSnoopingAgent().listGroups().length).toBe(0);
  });

  it('non-immediate Leave keeps the member until the membership timeout elapses', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const host1 = new CiscoSwitch('switch-cisco', 'H1', 4);
    new Cable('c').connect(sw.getPort('FastEthernet0/2')!, host1.getPort('FastEthernet0/1')!);
    sendReport(host1.getPort('FastEthernet0/1')!, '10.0.0.10', '239.5.5.5');
    sendLeave(host1.getPort('FastEthernet0/1')!, '10.0.0.10', '239.5.5.5');
    expect(sw.getIgmpSnoopingAgent().listGroups().length).toBe(1);
  });
});

describe('IGMP Snooping — Egress port resolution', () => {
  it('computeEgressPorts returns only member ports and router ports', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    const r = new CiscoRouter('R');
    const h1 = new CiscoSwitch('switch-cisco', 'H1', 4);
    const h2 = new CiscoSwitch('switch-cisco', 'H2', 4);
    const h3 = new CiscoSwitch('switch-cisco', 'H3', 4);
    new Cable('a').connect(sw.getPort('FastEthernet0/1')!, r.getPort('GigabitEthernet0/0')!);
    new Cable('b').connect(sw.getPort('FastEthernet0/2')!, h1.getPort('FastEthernet0/1')!);
    new Cable('c').connect(sw.getPort('FastEthernet0/3')!, h2.getPort('FastEthernet0/1')!);
    new Cable('d').connect(sw.getPort('FastEthernet0/4')!, h3.getPort('FastEthernet0/1')!);

    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    sendReport(h1.getPort('FastEthernet0/1')!, '10.0.0.11', '239.9.9.9');
    sendReport(h3.getPort('FastEthernet0/1')!, '10.0.0.13', '239.9.9.9');

    const egress = sw.getIgmpSnoopingAgent().computeEgressPorts('FastEthernet0/1', '239.9.9.9');
    expect(egress.sort()).toEqual(['FastEthernet0/2', 'FastEthernet0/4']);
  });

  it('returns empty list when snooping is globally disabled', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const h1 = new CiscoSwitch('switch-cisco', 'H1', 4);
    new Cable('c').connect(sw.getPort('FastEthernet0/2')!, h1.getPort('FastEthernet0/1')!);
    sendReport(h1.getPort('FastEthernet0/1')!, '10.0.0.10', '239.5.5.5');
    sw.getIgmpSnoopingAgent().setEnabled(false);
    expect(sw.getIgmpSnoopingAgent().computeEgressPorts('FastEthernet0/1', '239.5.5.5')).toEqual([]);
  });
});

describe('IGMP Snooping — Link-down housekeeping', () => {
  it('shutting a port flushes its memberships and router-port flag', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const r = new CiscoRouter('R');
    const h1 = new CiscoSwitch('switch-cisco', 'H1', 4);
    new Cable('a').connect(sw.getPort('FastEthernet0/1')!, r.getPort('GigabitEthernet0/0')!);
    new Cable('b').connect(sw.getPort('FastEthernet0/2')!, h1.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    sendReport(h1.getPort('FastEthernet0/1')!, '10.0.0.11', '239.1.1.1');
    expect(sw.getIgmpSnoopingAgent().listGroups().length).toBe(1);
    expect(sw.getIgmpSnoopingAgent().getVlanState(1)?.routerPorts.has('FastEthernet0/1')).toBe(true);
    sw.getPort('FastEthernet0/1')!.setUp(false);
    sw.getPort('FastEthernet0/2')!.setUp(false);
    expect(sw.getIgmpSnoopingAgent().listGroups().length).toBe(0);
    expect(sw.getIgmpSnoopingAgent().getVlanState(1)?.routerPorts.has('FastEthernet0/1')).toBe(false);
  });
});

describe('IGMP Snooping — Per-VLAN disable', () => {
  it('disabling snooping on a VLAN tears down its members and stops tracking new ones', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const h1 = new CiscoSwitch('switch-cisco', 'H1', 4);
    new Cable('c').connect(sw.getPort('FastEthernet0/2')!, h1.getPort('FastEthernet0/1')!);
    sendReport(h1.getPort('FastEthernet0/1')!, '10.0.0.10', '239.5.5.5');
    expect(sw.getIgmpSnoopingAgent().listGroups().length).toBe(1);
    sw.getIgmpSnoopingAgent().setVlanEnabled(1, false);
    expect(sw.getIgmpSnoopingAgent().listGroups().length).toBe(0);
    sendReport(h1.getPort('FastEthernet0/1')!, '10.0.0.10', '239.5.5.5');
    expect(sw.getIgmpSnoopingAgent().listGroups().length).toBe(0);
  });
});

describe('IGMP Snooping — show ip igmp snooping', () => {
  it('show ip igmp snooping groups renders the active membership table', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const h1 = new CiscoSwitch('switch-cisco', 'H1', 4);
    new Cable('c').connect(sw.getPort('FastEthernet0/2')!, h1.getPort('FastEthernet0/1')!);
    sendReport(h1.getPort('FastEthernet0/1')!, '10.0.0.10', '239.2.2.2');
    const out = await sw.executeCommand('show ip igmp snooping groups');
    expect(out).toMatch(/239\.2\.2\.2/);
    expect(out).toMatch(/FastEthernet0\/2/);
  });

  it('show ip igmp snooping mrouter lists the router ports', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const r = new CiscoRouter('R');
    new Cable('c').connect(sw.getPort('FastEthernet0/1')!, r.getPort('GigabitEthernet0/0')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
    const out = await sw.executeCommand('show ip igmp snooping mrouter');
    expect(out).toMatch(/FastEthernet0\/1/);
  });
});

describe('IGMP Snooping — Direct query injection from host port', () => {
  it('treats received Query as router-port even without a real router agent', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const h1 = new CiscoSwitch('switch-cisco', 'H1', 4);
    new Cable('c').connect(sw.getPort('FastEthernet0/3')!, h1.getPort('FastEthernet0/1')!);
    sendQuery(h1.getPort('FastEthernet0/1')!, '10.0.0.99');
    expect(sw.getIgmpSnoopingAgent().getVlanState(1)?.routerPorts.has('FastEthernet0/3')).toBe(true);
  });
});

describe('IGMP Snooping — constrained data-path forwarding (RFC 4541 §2.1.2)', () => {
  function dataFrame(srcPort: import('@/network/hardware/Port').Port, group: string): EthernetFrame {
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0,
      totalLength: 28,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 16, protocol: 17, headerChecksum: 0,
      sourceIP: new IPAddress('10.0.0.30'),
      destinationIP: new IPAddress(group),
      payload: { type: 'udp', sourcePort: 5000, destinationPort: 5000, length: 8, checksum: 0, payload: null },
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    return {
      srcMAC: srcPort.getMAC(),
      dstMAC: new MACAddress(ipv4MulticastToMac(group)),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    };
  }

  function threeHostSetup() {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    const h1 = new CiscoSwitch('switch-cisco', 'H1', 4);
    const h2 = new CiscoSwitch('switch-cisco', 'H2', 4);
    const h3 = new CiscoSwitch('switch-cisco', 'H3', 4);
    for (const d of [sw, h1, h2, h3]) d.setEventBus(bus);
    new Cable('c1').connect(sw.getPort('FastEthernet0/2')!, h1.getPort('FastEthernet0/1')!);
    new Cable('c2').connect(sw.getPort('FastEthernet0/3')!, h2.getPort('FastEthernet0/1')!);
    new Cable('c3').connect(sw.getPort('FastEthernet0/4')!, h3.getPort('FastEthernet0/1')!);
    const nameById = new Map<string, string>([
      [h1.getPort('FastEthernet0/1')!.getEquipmentId(), 'H1'],
      [h2.getPort('FastEthernet0/1')!.getEquipmentId(), 'H2'],
      [h3.getPort('FastEthernet0/1')!.getEquipmentId(), 'H3'],
    ]);
    const received: string[] = [];
    bus.subscribe('port.frame.received', (e) => {
      const p = e.payload as { deviceId: string; portName: string; frame: EthernetFrame };
      const ip = p.frame.payload as IPv4Packet | undefined;
      if (ip?.type === 'ipv4' && ip.protocol === 17) {
        const name = nameById.get(p.deviceId);
        if (name) received.push(name);
      }
    });
    return { sw, h1, h2, h3, received };
  }

  it('a registered group egresses ONLY member ports (01:00:5e MAC is snooped, not flooded)', () => {
    const { sw, h1, h3, received } = threeHostSetup();
    // H1 joins 239.1.2.3 — snooping learns (vlan 1, group, Fa0/2).
    sendReport(h1.getPort('FastEthernet0/1')!, '10.0.0.10', '239.1.2.3');
    expect(sw.getIgmpSnoopingAgent().listGroups().length).toBe(1);

    // H3 sends multicast data to the group.
    h3.getPort('FastEthernet0/1')!.sendFrame(dataFrame(h3.getPort('FastEthernet0/1')!, '239.1.2.3'));

    expect(received).toContain('H1');       // member
    expect(received).not.toContain('H2');    // non-member
  });

  it('an unregistered group still floods within the VLAN', () => {
    const { h1, h3, received } = threeHostSetup();
    sendReport(h1.getPort('FastEthernet0/1')!, '10.0.0.10', '239.1.2.3');

    h3.getPort('FastEthernet0/1')!.sendFrame(dataFrame(h3.getPort('FastEthernet0/1')!, '239.9.9.9'));

    expect(received).toContain('H1');
    expect(received).toContain('H2'); // unknown group ⇒ classic flood
  });
});
