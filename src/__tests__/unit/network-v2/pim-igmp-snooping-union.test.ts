import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import {
  MACAddress, IPAddress, SubnetMask, resetCounters,
  type EthernetFrame, type IPv4Packet,
  ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { ipv4MulticastToMac } from '@/network/igmp/types';
import {
  IP_PROTO_PIM, PIM_ALL_ROUTERS, PIM_ALL_ROUTERS_MAC, type PimPacket,
} from '@/network/pim/types';

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

const GROUP = '239.7.7.7';

function pimJoinFrame(srcIp: string, group: string): EthernetFrame {
  const payload: PimPacket = {
    type: 'pim', version: 2, messageType: 'join-prune',
    reserved: 0, checksum: 0, options: [], senderIp: srcIp,
    joinPrune: {
      upstreamNeighborIp: '10.0.0.254', holdtimeSec: 210,
      groups: [{
        groupAddress: group, joinedSources: [], prunedSources: [],
        joinStarG: true, pruneStarG: false,
      }],
    },
  };
  const ipPkt: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0xc0, totalLength: 40,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
    ttl: 1, protocol: IP_PROTO_PIM, headerChecksum: 0,
    sourceIP: new IPAddress(srcIp),
    destinationIP: new IPAddress(PIM_ALL_ROUTERS),
    payload,
  };
  ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
  return {
    srcMAC: new MACAddress('00:11:22:33:44:02'),
    dstMAC: new MACAddress(PIM_ALL_ROUTERS_MAC),
    etherType: ETHERTYPE_IPV4,
    payload: ipPkt,
  };
}

function dataFrame(group: string): EthernetFrame {
  const ipPkt: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 60,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
    ttl: 64, protocol: 17, headerChecksum: 0,
    sourceIP: new IPAddress('10.0.0.9'),
    destinationIP: new IPAddress(group),
    payload: { type: 'udp' },
  };
  ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
  return {
    srcMAC: new MACAddress('00:aa:bb:cc:dd:ee'),
    dstMAC: new MACAddress(ipv4MulticastToMac(group)),
    etherType: ETHERTYPE_IPV4,
    payload: ipPkt,
  };
}

/**
 * Fa0/1: an IGMP host (a real LinuxPC that joins the group).
 * Fa0/2: a PIM neighbour that Joins the same group.
 * Fa0/3: the source side. Fa0/4: an uninterested port.
 */
async function lab() {
  const bus = new EventBus();
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  sw.setEventBus(bus);
  const pc = new LinuxPC('PC1');
  pc.setEventBus(bus);
  new Cable('c1').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  pc.getPort('eth0')!.configureIP(new IPAddress('10.0.0.10'), new SubnetMask('255.255.255.0'));

  const peers = new Map<string, EthernetFrame[]>();
  for (let i = 2; i <= 4; i++) {
    const name = `FastEthernet0/${i}`;
    const peerSw = new CiscoSwitch('switch-cisco', `P${i}`, 1);
    peerSw.setEventBus(bus);
    new Cable(`c${i}`).connect(sw.getPort(name)!, peerSw.getPort('FastEthernet0/1')!);
  }
  for (const name of ['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3', 'FastEthernet0/4']) {
    const port = sw.getPort(name)!;
    const seen: EthernetFrame[] = [];
    const original = port.sendFrame.bind(port);
    (port as unknown as { sendFrame: (f: EthernetFrame) => void }).sendFrame = (f) => {
      seen.push(f);
      original(f);
    };
    peers.set(name, seen);
  }

  for (const l of ['enable', 'configure terminal', 'ip pim snooping', 'end']) {
    await sw.executeCommand(l);
  }
  return { bus, sw, pc, peers };
}

describe('PIM + IGMP snooping — union at the flood decision (P3)', () => {
  it('both an IGMP receiver and a PIM neighbour get the flow', async () => {
    const { sw, pc, peers } = await lab();
    pc.joinMulticastGroup('eth0', GROUP);
    sw.getPort('FastEthernet0/2')!.receiveFrame(pimJoinFrame('10.0.0.2', GROUP));
    for (const list of peers.values()) list.length = 0;

    sw.getPort('FastEthernet0/3')!.receiveFrame(dataFrame(GROUP));

    expect(peers.get('FastEthernet0/1')!.length).toBe(1);
    expect(peers.get('FastEthernet0/2')!.length).toBe(1);
    expect(peers.get('FastEthernet0/4')!.length).toBe(0);
  });

  it('the IGMP side alone is unaffected by PIM snooping being on', async () => {
    const { sw, pc, peers } = await lab();
    pc.joinMulticastGroup('eth0', GROUP);
    for (const list of peers.values()) list.length = 0;
    sw.getPort('FastEthernet0/3')!.receiveFrame(dataFrame(GROUP));
    expect(peers.get('FastEthernet0/1')!.length).toBe(1);
    expect(peers.get('FastEthernet0/4')!.length).toBe(0);
  });

  it('the PIM side alone works with no IGMP membership at all', async () => {
    const { sw, peers } = await lab();
    sw.getPort('FastEthernet0/2')!.receiveFrame(pimJoinFrame('10.0.0.2', GROUP));
    for (const list of peers.values()) list.length = 0;
    sw.getPort('FastEthernet0/3')!.receiveFrame(dataFrame(GROUP));
    expect(peers.get('FastEthernet0/2')!.length).toBe(1);
    expect(peers.get('FastEthernet0/4')!.length).toBe(0);
  });

  it('a PIM Prune leaves the IGMP receiver still served', async () => {
    const { sw, pc, peers } = await lab();
    pc.joinMulticastGroup('eth0', GROUP);
    sw.getPort('FastEthernet0/2')!.receiveFrame(pimJoinFrame('10.0.0.2', GROUP));
    const pruneFrame = pimJoinFrame('10.0.0.2', GROUP);
    (pruneFrame.payload as IPv4Packet).payload = {
      ...((pruneFrame.payload as IPv4Packet).payload as PimPacket),
      joinPrune: {
        upstreamNeighborIp: '10.0.0.254', holdtimeSec: 210,
        groups: [{
          groupAddress: GROUP, joinedSources: [], prunedSources: [],
          joinStarG: false, pruneStarG: true,
        }],
      },
    } as PimPacket;
    sw.getPort('FastEthernet0/2')!.receiveFrame(pruneFrame);
    for (const list of peers.values()) list.length = 0;

    sw.getPort('FastEthernet0/3')!.receiveFrame(dataFrame(GROUP));
    expect(peers.get('FastEthernet0/1')!.length).toBe(1);
    // Fa0/2 keeps receiving as a PIM *router* port even after the Prune —
    // the Join state is gone, the neighbour is not.
    expect(peers.get('FastEthernet0/4')!.length).toBe(0);
  });

  it('turning PIM snooping off leaves IGMP snooping in charge', async () => {
    const { sw, pc, peers } = await lab();
    pc.joinMulticastGroup('eth0', GROUP);
    sw.getPort('FastEthernet0/2')!.receiveFrame(pimJoinFrame('10.0.0.2', GROUP));
    for (const l of ['configure terminal', 'no ip pim snooping', 'end']) {
      await sw.executeCommand(l);
    }
    for (const list of peers.values()) list.length = 0;
    sw.getPort('FastEthernet0/3')!.receiveFrame(dataFrame(GROUP));
    expect(peers.get('FastEthernet0/1')!.length).toBe(1);
    expect(peers.get('FastEthernet0/2')!.length).toBe(0);
  });
});
