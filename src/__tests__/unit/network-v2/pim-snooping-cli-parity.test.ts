import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import {
  MACAddress, IPAddress, resetCounters,
  type EthernetFrame, type IPv4Packet,
  ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  IP_PROTO_PIM, PIM_ALL_ROUTERS, PIM_ALL_ROUTERS_MAC, type PimPacket,
} from '@/network/pim/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  __setDefaultScheduler(new VirtualTimeScheduler());
});

afterEach(() => {
  __setDefaultScheduler(null);
});

function pimFrame(srcIp: string, payload: PimPacket): EthernetFrame {
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
    srcMAC: new MACAddress('00:11:22:33:44:01'),
    dstMAC: new MACAddress(PIM_ALL_ROUTERS_MAC),
    etherType: ETHERTYPE_IPV4,
    payload: ipPkt,
  };
}

const hello = (srcIp: string): PimPacket => ({
  type: 'pim', version: 2, messageType: 'hello',
  reserved: 0, checksum: 0,
  options: [{ type: 'holdtime', value: 105 }],
  senderIp: srcIp,
});

const join = (srcIp: string, group: string): PimPacket => ({
  type: 'pim', version: 2, messageType: 'join-prune',
  reserved: 0, checksum: 0, options: [], senderIp: srcIp,
  joinPrune: {
    upstreamNeighborIp: '10.0.0.254', holdtimeSec: 210,
    groups: [{
      groupAddress: group, joinedSources: [], prunedSources: [],
      joinStarG: true, pruneStarG: false,
    }],
  },
});

/** Keep each switch's first port cabled so it counts as up and connected. */
function cabled(sw: CiscoSwitch | HuaweiSwitch, bus: EventBus, portName: string): void {
  const peer = new CiscoSwitch('switch-cisco', `peer-${portName}`, 1);
  peer.setEventBus(bus);
  new Cable(`c-${portName}`).connect(sw.getPort(portName)!, peer.getPort('FastEthernet0/1')!);
}

describe('PIM snooping CLI — Cisco (P4)', () => {
  it('ip pim snooping enables it globally', async () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    sw.setEventBus(bus);
    for (const l of ['enable', 'configure terminal', 'ip pim snooping', 'end']) {
      expect(await sw.executeCommand(l)).not.toMatch(/Invalid/);
    }
    expect(sw.getPimSnoopingAgent().getConfig().enabled).toBe(true);
  });

  it('no ip pim snooping turns it off', async () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    sw.setEventBus(bus);
    for (const l of ['enable', 'configure terminal', 'ip pim snooping', 'no ip pim snooping', 'end']) {
      await sw.executeCommand(l);
    }
    expect(sw.getPimSnoopingAgent().getConfig().enabled).toBe(false);
  });

  it('ip pim snooping vlan <n> targets one VLAN', async () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    sw.setEventBus(bus);
    for (const l of ['enable', 'configure terminal', 'ip pim snooping',
      'no ip pim snooping vlan 1', 'end']) await sw.executeCommand(l);
    expect(sw.getPimSnoopingAgent().getVlanState(1)?.enabled).toBe(false);
  });

  it('a bad VLAN id is rejected', async () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    sw.setEventBus(bus);
    for (const l of ['enable', 'configure terminal']) await sw.executeCommand(l);
    expect(await sw.executeCommand('ip pim snooping vlan abc')).toMatch(/Invalid input/);
  });

  it('show ip pim snooping reports global state and per-VLAN counters', async () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    sw.setEventBus(bus);
    cabled(sw, bus, 'FastEthernet0/1');
    for (const l of ['enable', 'configure terminal', 'ip pim snooping', 'end']) {
      await sw.executeCommand(l);
    }
    sw.getPort('FastEthernet0/1')!.receiveFrame(pimFrame('10.0.0.1', hello('10.0.0.1')));
    const out = await sw.executeCommand('show ip pim snooping');
    expect(out).toMatch(/Global runtime status: enabled/);
    expect(out).toMatch(/Vlan 1/);
    expect(out).toMatch(/PIM snooping\s+: Enabled/);
    expect(out).toMatch(/1 neighbor\(s\)/);
  });

  it('show ip pim snooping neighbor and group list the learned state', async () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    sw.setEventBus(bus);
    cabled(sw, bus, 'FastEthernet0/1');
    for (const l of ['enable', 'configure terminal', 'ip pim snooping', 'end']) {
      await sw.executeCommand(l);
    }
    sw.getPort('FastEthernet0/1')!.receiveFrame(pimFrame('10.0.0.1', hello('10.0.0.1')));
    sw.getPort('FastEthernet0/1')!.receiveFrame(pimFrame('10.0.0.1', join('10.0.0.1', '239.1.1.1')));

    const nbr = await sw.executeCommand('show ip pim snooping neighbor');
    expect(nbr).toMatch(/10\.0\.0\.1/);
    expect(nbr).toMatch(/FastEthernet0\/1/);

    const grp = await sw.executeCommand('show ip pim snooping group');
    expect(grp).toMatch(/239\.1\.1\.1/);
    expect(grp).toMatch(/FastEthernet0\/1/);
  });
});

describe('PIM snooping CLI — Huawei (P4)', () => {
  it('pim-snooping enable in VLAN view enables it', async () => {
    const bus = new EventBus();
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    sw.setEventBus(bus);
    for (const l of ['system-view', 'vlan 1', 'pim-snooping enable']) {
      expect(await sw.executeCommand(l)).not.toMatch(/Unrecognized/);
    }
    const agent = sw.getPimSnoopingAgent();
    expect(agent.getConfig().enabled).toBe(true);
    expect(agent.getVlanState(1)?.enabled).toBe(true);
  });

  it('undo pim-snooping disables the VLAN', async () => {
    const bus = new EventBus();
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    sw.setEventBus(bus);
    for (const l of ['system-view', 'vlan 1', 'pim-snooping enable', 'undo pim-snooping enable']) {
      await sw.executeCommand(l);
    }
    expect(sw.getPimSnoopingAgent().getVlanState(1)?.enabled).toBe(false);
  });

  it('display pim-snooping says so when nothing is enabled', async () => {
    const bus = new EventBus();
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    sw.setEventBus(bus);
    expect(await sw.executeCommand('display pim-snooping'))
      .toMatch(/PIM snooping is not enabled/);
  });

  it('display pim-snooping reports the enabled VLAN and its learned state', async () => {
    const bus = new EventBus();
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    sw.setEventBus(bus);
    const first = sw.getPortNames()[0];
    const peer = new HuaweiSwitch('switch-huawei', 'P1', 1);
    peer.setEventBus(bus);
    new Cable('c1').connect(sw.getPort(first)!, peer.getPort(peer.getPortNames()[0])!);
    for (const l of ['system-view', 'vlan 1', 'pim-snooping enable', 'quit', 'quit']) {
      await sw.executeCommand(l);
    }
    sw.getPort(first)!.receiveFrame(pimFrame('10.0.0.1', hello('10.0.0.1')));
    sw.getPort(first)!.receiveFrame(pimFrame('10.0.0.1', join('10.0.0.1', '239.1.1.1')));

    const out = await sw.executeCommand('display pim-snooping');
    expect(out).toMatch(/VLAN ID: 1/);
    expect(out).toMatch(/PIM snooping: enabled/);
    expect(out).toMatch(/Neighbors: 1/);
    expect(out).toMatch(/Groups: 1/);

    const nbr = await sw.executeCommand('display pim-snooping neighbor');
    expect(nbr).toMatch(/Neighbor: 10\.0\.0\.1/);

    const grp = await sw.executeCommand('display pim-snooping group');
    expect(grp).toMatch(/Group address: 239\.1\.1\.1/);
  });

  it('the two vendors reach functionally identical engine state', async () => {
    const bus = new EventBus();
    const cs = new CiscoSwitch('switch-cisco', 'SW', 4);
    const hs = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    cs.setEventBus(bus); hs.setEventBus(bus);
    cabled(cs, bus, 'FastEthernet0/1');
    const hFirst = hs.getPortNames()[0];
    const hPeer = new HuaweiSwitch('switch-huawei', 'P1', 1);
    hPeer.setEventBus(bus);
    new Cable('ch').connect(hs.getPort(hFirst)!, hPeer.getPort(hPeer.getPortNames()[0])!);

    for (const l of ['enable', 'configure terminal', 'ip pim snooping', 'end']) {
      await cs.executeCommand(l);
    }
    for (const l of ['system-view', 'vlan 1', 'pim-snooping enable', 'quit', 'quit']) {
      await hs.executeCommand(l);
    }
    cs.getPort('FastEthernet0/1')!.receiveFrame(pimFrame('10.0.0.1', join('10.0.0.1', '239.5.5.5')));
    hs.getPort(hFirst)!.receiveFrame(pimFrame('10.0.0.1', join('10.0.0.1', '239.5.5.5')));

    expect(cs.getPimSnoopingAgent().listGroups(1).map(g => g.group.groupAddress))
      .toEqual(hs.getPimSnoopingAgent().listGroups(1).map(g => g.group.groupAddress));
    expect(cs.getPimSnoopingAgent().getVlanState(1)!.routerPorts.size)
      .toBe(hs.getPimSnoopingAgent().getVlanState(1)!.routerPorts.size);
  });
});
