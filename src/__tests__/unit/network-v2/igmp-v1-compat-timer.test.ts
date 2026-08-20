import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import {
  MACAddress, IPAddress, SubnetMask, resetCounters,
  type IPv4Packet, type EthernetFrame,
  nextIPv4Id, computeIPv4Checksum, ETHERTYPE_IPV4,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  IP_PROTO_IGMP, IGMP_ALL_ROUTERS, ipv4MulticastToMac, type IgmpPacket,
} from '@/network/igmp/types';

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

function send(hostPort: import('@/network/hardware/Port').Port, srcIp: string, dstIp: string, payload: IgmpPacket): void {
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

function v1Report(port: import('@/network/hardware/Port').Port, srcIp: string, group: string): void {
  send(port, srcIp, group, {
    type: 'igmp', version: 2, messageType: 'v1-membership-report',
    maxRespTimeDs: 0, groupAddress: group, checksum: 0,
  });
}

function v2Report(port: import('@/network/hardware/Port').Port, srcIp: string, group: string): void {
  send(port, srcIp, group, {
    type: 'igmp', version: 2, messageType: 'v2-membership-report',
    maxRespTimeDs: 0, groupAddress: group, checksum: 0,
  });
}

function leave(port: import('@/network/hardware/Port').Port, srcIp: string, group: string): void {
  send(port, srcIp, IGMP_ALL_ROUTERS, {
    type: 'igmp', version: 2, messageType: 'leave-group',
    maxRespTimeDs: 0, groupAddress: group, checksum: 0,
  });
}

function lab() {
  const bus = new EventBus();
  const r = new CiscoRouter('R1');
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  r.setEventBus(bus); sw.setEventBus(bus);
  new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
  r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  r.getIgmpAgent().enableInterface('GigabitEthernet0/0', 2);
  return { bus, r, sw, hostPort: sw.getPort('FastEthernet0/1')! };
}

/**
 * The Version 1 Host Present timer runs for one Group Membership Interval:
 * robustness (2) × queryInterval (125 s) + maxRespTime (10 s) = 260 s.
 */
const GROUP_MEMBERSHIP_MS = 260_000;

describe('IGMP — Version 1 Host Present timer (RFC 2236 §4)', () => {
  it('a v1 Report marks the group as having an IGMPv1 member', () => {
    const { r, hostPort } = lab();
    v1Report(hostPort, '10.0.0.55', '239.1.1.1');
    const rec = r.getIgmpAgent().getConfig().groups.get('GigabitEthernet0/0|239.1.1.1');
    expect(rec?.v1CompatUntilMs).toBe(vts.now() + GROUP_MEMBERSHIP_MS);
  });

  it('a Leave Group is ignored while the compatibility timer runs', () => {
    const { r, hostPort } = lab();
    v1Report(hostPort, '10.0.0.55', '239.2.2.2');
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.2.2.2')).toBe(true);
    leave(hostPort, '10.0.0.55', '239.2.2.2');
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.2.2.2')).toBe(true);
  });

  it('no Group-Specific Query is sent for a v1 group on Leave', () => {
    const { bus, r, hostPort } = lab();
    v1Report(hostPort, '10.0.0.55', '239.3.3.3');
    const sent: Array<{ messageType: string; groupAddress: string }> = [];
    bus.subscribe('igmp.packet.sent', (e) => sent.push(e.payload));
    leave(hostPort, '10.0.0.55', '239.3.3.3');
    expect(sent.some(s => s.messageType === 'membership-query' && s.groupAddress === '239.3.3.3')).toBe(false);
    void r;
  });

  it('once the timer expires, a Leave is processed normally again', () => {
    const { r, hostPort } = lab();
    v1Report(hostPort, '10.0.0.55', '239.4.4.4');
    // Keep the membership alive with v2 Reports so only the v1 timer lapses,
    // not the membership itself.
    for (let elapsed = 0; elapsed < GROUP_MEMBERSHIP_MS; elapsed += 60_000) {
      vts.advance(60_000);
      v2Report(hostPort, '10.0.0.55', '239.4.4.4');
    }
    vts.advance(1_000);
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.4.4.4')).toBe(true);
    leave(hostPort, '10.0.0.55', '239.4.4.4');
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.4.4.4')).toBe(false);
  });

  it('a fresh v1 Report re-arms the timer', () => {
    const { r, hostPort } = lab();
    v1Report(hostPort, '10.0.0.55', '239.5.5.5');
    vts.advance(200_000);
    v1Report(hostPort, '10.0.0.55', '239.5.5.5');
    const rec = r.getIgmpAgent().getConfig().groups.get('GigabitEthernet0/0|239.5.5.5');
    expect(rec?.v1CompatUntilMs).toBe(vts.now() + GROUP_MEMBERSHIP_MS);
    vts.advance(100_000);
    leave(hostPort, '10.0.0.55', '239.5.5.5');
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.5.5.5')).toBe(true);
  });

  it('a v2-only group still honours Leave immediately', () => {
    const { r, hostPort } = lab();
    v2Report(hostPort, '10.0.0.55', '239.6.6.6');
    leave(hostPort, '10.0.0.55', '239.6.6.6');
    expect(r.getIgmpAgent().hasMember('GigabitEthernet0/0', '239.6.6.6')).toBe(false);
  });

  it('show ip igmp groups detail reports IGMPv1 mode only while the timer runs', async () => {
    const { r, hostPort } = lab();
    v1Report(hostPort, '10.0.0.55', '239.7.7.7');
    expect(await r.executeCommand('show ip igmp groups detail')).toMatch(/Group mode:\s+IGMPv1/);
    for (let elapsed = 0; elapsed < GROUP_MEMBERSHIP_MS; elapsed += 60_000) {
      vts.advance(60_000);
      v2Report(hostPort, '10.0.0.55', '239.7.7.7');
    }
    vts.advance(1_000);
    expect(await r.executeCommand('show ip igmp groups detail')).toMatch(/Group mode:\s+IGMPv2/);
  });
});
