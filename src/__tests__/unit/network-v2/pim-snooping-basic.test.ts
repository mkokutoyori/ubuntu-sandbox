import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

function pimFrame(srcMac: MACAddress, srcIp: string, payload: PimPacket): EthernetFrame {
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
    srcMAC: srcMac,
    dstMAC: new MACAddress(PIM_ALL_ROUTERS_MAC),
    etherType: ETHERTYPE_IPV4,
    payload: ipPkt,
  };
}

function hello(srcIp: string, holdtimeSec = 105): PimPacket {
  return {
    type: 'pim', version: 2, messageType: 'hello',
    reserved: 0, checksum: 0,
    options: [{ type: 'holdtime', value: holdtimeSec }],
    senderIp: srcIp,
  };
}

function joinPrune(srcIp: string, group: string, join: boolean, holdtimeSec = 210): PimPacket {
  return {
    type: 'pim', version: 2, messageType: 'join-prune',
    reserved: 0, checksum: 0, options: [], senderIp: srcIp,
    joinPrune: {
      upstreamNeighborIp: '10.0.0.254',
      holdtimeSec,
      groups: [{
        groupAddress: group,
        joinedSources: [], prunedSources: [],
        joinStarG: join, pruneStarG: !join,
      }],
    },
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

/** A 4-port switch with a live peer on each port and an egress tap. */
function lab() {
  const bus = new EventBus();
  const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
  sw.setEventBus(bus);
  const peers = new Map<string, EthernetFrame[]>();
  for (let i = 1; i <= 4; i++) {
    const name = `FastEthernet0/${i}`;
    const port = sw.getPort(name)!;
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

async function enablePimSnooping(sw: CiscoSwitch): Promise<void> {
  for (const l of ['enable', 'configure terminal', 'ip pim snooping', 'end']) {
    await sw.executeCommand(l);
  }
}

describe('PIM snooping — neighbour discovery (P2)', () => {
  it('a PIM Hello makes the ingress port a PIM router port', async () => {
    const { sw } = lab();
    await enablePimSnooping(sw);
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      pimFrame(new MACAddress('00:11:22:33:44:01'), '10.0.0.1', hello('10.0.0.1')));
    const v = sw.getPimSnoopingAgent().getVlanState(1)!;
    expect(v.routerPorts.has('FastEthernet0/1')).toBe(true);
    expect(v.neighbors.size).toBe(1);
  });

  it('nothing is learned while PIM snooping is disabled', () => {
    const { sw } = lab();
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      pimFrame(new MACAddress('00:11:22:33:44:01'), '10.0.0.1', hello('10.0.0.1')));
    expect(sw.getPimSnoopingAgent().getVlanState(1)?.routerPorts.size ?? 0).toBe(0);
  });

  it('the neighbour ages out on its own Hello holdtime', async () => {
    const { sw } = lab();
    await enablePimSnooping(sw);
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      pimFrame(new MACAddress('00:11:22:33:44:01'), '10.0.0.1', hello('10.0.0.1', 30)));
    vts.advance(20_000);
    expect(sw.getPimSnoopingAgent().getVlanState(1)!.routerPorts.has('FastEthernet0/1')).toBe(true);
    vts.advance(15_000);
    expect(sw.getPimSnoopingAgent().getVlanState(1)!.routerPorts.has('FastEthernet0/1')).toBe(false);
  });

  it('a link-down forgets the neighbour immediately', async () => {
    const { sw } = lab();
    await enablePimSnooping(sw);
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      pimFrame(new MACAddress('00:11:22:33:44:01'), '10.0.0.1', hello('10.0.0.1')));
    sw.getPort('FastEthernet0/1')!.setUp(false);
    expect(sw.getPimSnoopingAgent().getVlanState(1)!.routerPorts.has('FastEthernet0/1')).toBe(false);
  });

  it('publishes pim.snooping.neighbor.changed', async () => {
    const { bus, sw } = lab();
    await enablePimSnooping(sw);
    const seen: Array<{ port: string; neighborIp: string; added: boolean }> = [];
    bus.subscribeWhere('pim.snooping.neighbor.changed', (p) => p.deviceId === sw.id,
      (e) => seen.push(e.payload));
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      pimFrame(new MACAddress('00:11:22:33:44:01'), '10.0.0.1', hello('10.0.0.1')));
    expect(seen.some(e => e.port === 'FastEthernet0/1' && e.neighborIp === '10.0.0.1' && e.added)).toBe(true);
  });
});

describe('PIM snooping — group interest from Join/Prune (P2)', () => {
  it('a (*,G) Join records the port as interested', async () => {
    const { sw } = lab();
    await enablePimSnooping(sw);
    sw.getPort('FastEthernet0/2')!.receiveFrame(
      pimFrame(new MACAddress('00:11:22:33:44:02'), '10.0.0.2', joinPrune('10.0.0.2', '239.1.1.1', true)));
    const groups = sw.getPimSnoopingAgent().listGroups(1);
    expect(groups[0].group.groupAddress).toBe('239.1.1.1');
    expect(groups[0].group.members.has('FastEthernet0/2')).toBe(true);
  });

  it('a Join also proves a PIM router lives on that port', async () => {
    const { sw } = lab();
    await enablePimSnooping(sw);
    sw.getPort('FastEthernet0/2')!.receiveFrame(
      pimFrame(new MACAddress('00:11:22:33:44:02'), '10.0.0.2', joinPrune('10.0.0.2', '239.1.1.1', true)));
    expect(sw.getPimSnoopingAgent().getVlanState(1)!.routerPorts.has('FastEthernet0/2')).toBe(true);
  });

  it('a Prune removes the interest', async () => {
    const { sw } = lab();
    await enablePimSnooping(sw);
    const port = sw.getPort('FastEthernet0/2')!;
    port.receiveFrame(pimFrame(new MACAddress('00:11:22:33:44:02'), '10.0.0.2', joinPrune('10.0.0.2', '239.1.1.1', true)));
    port.receiveFrame(pimFrame(new MACAddress('00:11:22:33:44:02'), '10.0.0.2', joinPrune('10.0.0.2', '239.1.1.1', false)));
    expect(sw.getPimSnoopingAgent().listGroups(1).length).toBe(0);
  });

  it('the interest ages out on the Join holdtime', async () => {
    const { sw } = lab();
    await enablePimSnooping(sw);
    sw.getPort('FastEthernet0/2')!.receiveFrame(
      pimFrame(new MACAddress('00:11:22:33:44:02'), '10.0.0.2', joinPrune('10.0.0.2', '239.1.1.1', true, 60)));
    vts.advance(50_000);
    expect(sw.getPimSnoopingAgent().listGroups(1).length).toBe(1);
    vts.advance(15_000);
    expect(sw.getPimSnoopingAgent().listGroups(1).length).toBe(0);
  });

  it('a Join for a link-local group is ignored', async () => {
    const { sw } = lab();
    await enablePimSnooping(sw);
    sw.getPort('FastEthernet0/2')!.receiveFrame(
      pimFrame(new MACAddress('00:11:22:33:44:02'), '10.0.0.2', joinPrune('10.0.0.2', '224.0.0.13', true)));
    expect(sw.getPimSnoopingAgent().listGroups(1).length).toBe(0);
  });

  it('a Bootstrap message is never mistaken for a Hello or a Join', async () => {
    const { sw } = lab();
    await enablePimSnooping(sw);
    sw.getPort('FastEthernet0/2')!.receiveFrame(
      pimFrame(new MACAddress('00:11:22:33:44:02'), '10.0.0.2', {
        type: 'pim', version: 2, messageType: 'bootstrap',
        reserved: 0, checksum: 0, options: [], senderIp: '10.0.0.2',
        bootstrap: {
          bsrAddress: '10.0.0.2', bsrPriority: 100, fragmentTag: 1,
          groups: [{
            groupRangeAddress: '224.0.0.0', groupRangeMaskBits: 4,
            rps: [{ rpAddress: '10.0.0.7', priority: 0, holdtimeSec: 150 }],
          }],
        },
      }));
    const agent = sw.getPimSnoopingAgent();
    expect(agent.listGroups(1).length).toBe(0);
    expect(agent.getVlanState(1)!.routerPorts.size).toBe(0);
  });
});

describe('PIM snooping — constrained forwarding (P2)', () => {
  it('the group flows only to the joining port and other PIM router ports', async () => {
    const { sw, peers } = lab();
    await enablePimSnooping(sw);
    // Fa0/1 has a plain PIM neighbour, Fa0/2 joined the group.
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      pimFrame(new MACAddress('00:11:22:33:44:01'), '10.0.0.1', hello('10.0.0.1')));
    sw.getPort('FastEthernet0/2')!.receiveFrame(
      pimFrame(new MACAddress('00:11:22:33:44:02'), '10.0.0.2', joinPrune('10.0.0.2', '239.1.1.1', true)));
    for (const list of peers.values()) list.length = 0;

    sw.getPort('FastEthernet0/3')!.receiveFrame(dataFrame('239.1.1.1'));

    expect(peers.get('FastEthernet0/1')!.length).toBe(1);
    expect(peers.get('FastEthernet0/2')!.length).toBe(1);
    expect(peers.get('FastEthernet0/4')!.length).toBe(0);
  });

  it('a PIM Hello itself is still flooded everywhere (RFC 4541 §2.1.2)', async () => {
    const { sw, peers } = lab();
    await enablePimSnooping(sw);
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      pimFrame(new MACAddress('00:11:22:33:44:01'), '10.0.0.1', hello('10.0.0.1')));
    for (const list of peers.values()) list.length = 0;
    sw.getPort('FastEthernet0/3')!.receiveFrame(
      pimFrame(new MACAddress('00:11:22:33:44:03'), '10.0.0.3', hello('10.0.0.3')));
    expect(peers.get('FastEthernet0/4')!.length).toBe(1);
  });

  it('a real Cisco router\'s own PIM Hello is learned through the switch', async () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const r = new CiscoRouter('R1');
    sw.setEventBus(bus); r.setEventBus(bus);
    new Cable('c1').connect(r.getPort('GigabitEthernet0/0')!, sw.getPort('FastEthernet0/1')!);
    r.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    await enablePimSnooping(sw);
    for (const l of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip pim sparse-mode', 'end']) await r.executeCommand(l);
    expect(sw.getPimSnoopingAgent().getVlanState(1)!.routerPorts.has('FastEthernet0/1')).toBe(true);
  });
});
