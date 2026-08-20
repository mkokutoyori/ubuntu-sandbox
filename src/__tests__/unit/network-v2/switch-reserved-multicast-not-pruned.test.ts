import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import {
  MACAddress, IPAddress, resetCounters,
  type EthernetFrame, type IPv4Packet,
  ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { ipv4MulticastToMac, IP_PROTO_IGMP, type IgmpPacket } from '@/network/igmp/types';
import { IP_PROTO_PIM } from '@/network/pim/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const IP_PROTO_OSPF = 89;
const IP_PROTO_VRRP = 112;

function multicastFrame(srcMac: MACAddress, dstIp: string, protocol: number, payload: unknown): EthernetFrame {
  const ipPkt: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0xc0, totalLength: 40,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
    ttl: 1, protocol, headerChecksum: 0,
    sourceIP: new IPAddress('10.0.0.9'),
    destinationIP: new IPAddress(dstIp),
    payload,
  };
  ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
  return {
    srcMAC: srcMac,
    dstMAC: new MACAddress(ipv4MulticastToMac(dstIp)),
    etherType: ETHERTYPE_IPV4,
    payload: ipPkt,
  };
}

function igmpReportFrame(srcMac: MACAddress, group: string): EthernetFrame {
  const payload: IgmpPacket = {
    type: 'igmp', version: 2, messageType: 'v2-membership-report',
    maxRespTimeDs: 0, groupAddress: group, checksum: 0,
  };
  return multicastFrame(srcMac, group, IP_PROTO_IGMP, payload);
}

function igmpQueryFrame(srcMac: MACAddress): EthernetFrame {
  const payload: IgmpPacket = {
    type: 'igmp', version: 2, messageType: 'membership-query',
    maxRespTimeDs: 100, groupAddress: '0.0.0.0', checksum: 0,
  };
  return multicastFrame(srcMac, '224.0.0.1', IP_PROTO_IGMP, payload);
}

/**
 * Four ports: Fa0/1 is the IGMP router port (a Query arrives there),
 * Fa0/2 has an IGMP receiver for 239.1.1.1, Fa0/3 and Fa0/4 have never
 * spoken IGMP at all.
 */
function lab() {
  const bus = new EventBus();
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  sw.setEventBus(bus);
  const peers = new Map<string, EthernetFrame[]>();
  for (let i = 1; i <= 4; i++) {
    const name = `FastEthernet0/${i}`;
    const port = sw.getPort(name)!;
    // Give every port a live peer so the switch considers it up and
    // connected, and record what actually egresses it.
    const peerSw = new CiscoSwitch('switch-cisco', `P${i}`, 1);
    peerSw.setEventBus(bus);
    new Cable(`c${i}`).connect(port, peerSw.getPort('FastEthernet0/1')!);
    const seen: EthernetFrame[] = [];
    const original = port.sendFrame.bind(port);
    (port as unknown as { sendFrame: (f: EthernetFrame) => void }).sendFrame = (f) => {
      seen.push(f);
      original(f);
    };
    peers.set(name, seen);
  }
  return { bus, sw, peers };
}

/** Make IGMP snooping genuinely active: a router port plus a member. */
function primeIgmpSnooping(sw: CiscoSwitch): void {
  sw.getPort('FastEthernet0/1')!.receiveFrame(igmpQueryFrame(new MACAddress('00:11:22:33:44:01')));
  sw.getPort('FastEthernet0/2')!.receiveFrame(igmpReportFrame(new MACAddress('00:11:22:33:44:02'), '239.1.1.1'));
}

describe('Switch — link-local multicast is never pruned (RFC 4541 §2.1.2, P1)', () => {
  it('the precondition holds: IGMP snooping really is constraining 239.1.1.1', () => {
    const { sw } = lab();
    primeIgmpSnooping(sw);
    const agent = sw.getIgmpSnoopingAgent();
    expect(agent.getVlanState(1)?.routerPorts.has('FastEthernet0/1')).toBe(true);
    const egress = agent.computeEgressPorts('FastEthernet0/3', '239.1.1.1');
    expect(egress.sort()).toEqual(['FastEthernet0/1', 'FastEthernet0/2']);
  });

  it('a PIM Hello (224.0.0.13) still floods every port of the VLAN', () => {
    const { sw, peers } = lab();
    primeIgmpSnooping(sw);
    for (const list of peers.values()) list.length = 0;

    sw.getPort('FastEthernet0/3')!.receiveFrame(
      multicastFrame(new MACAddress('00:11:22:33:44:03'), '224.0.0.13', IP_PROTO_PIM, {
        type: 'pim', version: 2, messageType: 'hello',
        reserved: 0, checksum: 0, options: [], senderIp: '10.0.0.9',
      }));

    // Every port except the ingress must have seen it — in particular
    // FastEthernet0/4, which has never spoken IGMP.
    expect(peers.get('FastEthernet0/1')!.length).toBe(1);
    expect(peers.get('FastEthernet0/2')!.length).toBe(1);
    expect(peers.get('FastEthernet0/4')!.length).toBe(1);
    expect(peers.get('FastEthernet0/3')!.length).toBe(0);
  });

  it('an OSPF Hello (224.0.0.5) is not pruned either', () => {
    const { sw, peers } = lab();
    primeIgmpSnooping(sw);
    for (const list of peers.values()) list.length = 0;
    sw.getPort('FastEthernet0/3')!.receiveFrame(
      multicastFrame(new MACAddress('00:11:22:33:44:03'), '224.0.0.5', IP_PROTO_OSPF, { type: 'ospf' }));
    expect(peers.get('FastEthernet0/4')!.length).toBe(1);
  });

  it('a VRRP advertisement (224.0.0.18) is not pruned either', () => {
    const { sw, peers } = lab();
    primeIgmpSnooping(sw);
    for (const list of peers.values()) list.length = 0;
    sw.getPort('FastEthernet0/3')!.receiveFrame(
      multicastFrame(new MACAddress('00:11:22:33:44:03'), '224.0.0.18', IP_PROTO_VRRP, { type: 'vrrp' }));
    expect(peers.get('FastEthernet0/4')!.length).toBe(1);
  });

  it('an ordinary group outside 224.0.0.0/24 is still constrained', () => {
    const { sw, peers } = lab();
    primeIgmpSnooping(sw);
    for (const list of peers.values()) list.length = 0;
    sw.getPort('FastEthernet0/3')!.receiveFrame(
      multicastFrame(new MACAddress('00:11:22:33:44:03'), '239.1.1.1', 17, { type: 'udp' }));
    expect(peers.get('FastEthernet0/1')!.length).toBe(1);
    expect(peers.get('FastEthernet0/2')!.length).toBe(1);
    // The port that expressed no interest must NOT receive it.
    expect(peers.get('FastEthernet0/4')!.length).toBe(0);
  });

  it('an unjoined group goes to the router ports only, per RFC 4541 §2.1.2', () => {
    const { sw, peers } = lab();
    primeIgmpSnooping(sw);
    for (const list of peers.values()) list.length = 0;
    sw.getPort('FastEthernet0/3')!.receiveFrame(
      multicastFrame(new MACAddress('00:11:22:33:44:03'), '239.9.9.9', 17, { type: 'udp' }));
    expect(peers.get('FastEthernet0/1')!.length).toBe(1);
    expect(peers.get('FastEthernet0/2')!.length).toBe(0);
    expect(peers.get('FastEthernet0/4')!.length).toBe(0);
  });

  it('with no snooping state at all, everything floods', () => {
    const { sw, peers } = lab();
    for (const list of peers.values()) list.length = 0;
    sw.getPort('FastEthernet0/3')!.receiveFrame(
      multicastFrame(new MACAddress('00:11:22:33:44:03'), '239.9.9.9', 17, { type: 'udp' }));
    expect(peers.get('FastEthernet0/1')!.length).toBe(1);
    expect(peers.get('FastEthernet0/4')!.length).toBe(1);
  });
});
