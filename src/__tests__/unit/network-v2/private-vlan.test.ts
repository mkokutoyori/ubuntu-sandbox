import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters, ETHERTYPE_IPV4 } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import type { EthernetFrame } from '@/network/core/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

function untaggedFrame(src: MACAddress, dst: MACAddress): EthernetFrame {
  return { srcMAC: src, dstMAC: dst, etherType: ETHERTYPE_IPV4, payload: { type: 'test' } };
}

function sniff(sw: CiscoSwitch, portName: string): { frames: EthernetFrame[] } {
  const sniffer = new Port(`sniff-${portName}`);
  const box = { frames: [] as EthernetFrame[] };
  sniffer.onFrame((_n, f) => {
    if (f.etherType === ETHERTYPE_IPV4 && (f.payload as { type?: string })?.type === 'test') box.frames.push(f);
  });
  new Cable(`c-${portName}`).connect(sw.getPort(portName)!, sniffer);
  return box;
}

async function pvlanSwitch(): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('vlan 100');
  await sw.executeCommand('private-vlan primary');
  await sw.executeCommand('vlan 101');
  await sw.executeCommand('private-vlan isolated');
  await sw.executeCommand('vlan 102');
  await sw.executeCommand('private-vlan community');
  await sw.executeCommand('vlan 100');
  await sw.executeCommand('private-vlan association 101,102');
  await sw.executeCommand('end');

  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('interface FastEthernet0/1');
  await sw.executeCommand('switchport mode private-vlan promiscuous');
  await sw.executeCommand('switchport private-vlan mapping 100 101,102');
  await sw.executeCommand('exit');
  await sw.executeCommand('interface FastEthernet0/2');
  await sw.executeCommand('switchport mode private-vlan host');
  await sw.executeCommand('switchport private-vlan host-association 100 101');
  await sw.executeCommand('exit');
  await sw.executeCommand('interface FastEthernet0/3');
  await sw.executeCommand('switchport mode private-vlan host');
  await sw.executeCommand('switchport private-vlan host-association 100 101');
  await sw.executeCommand('exit');
  await sw.executeCommand('interface FastEthernet0/4');
  await sw.executeCommand('switchport mode private-vlan host');
  await sw.executeCommand('switchport private-vlan host-association 100 102');
  await sw.executeCommand('exit');
  await sw.executeCommand('interface FastEthernet0/5');
  await sw.executeCommand('switchport mode private-vlan host');
  await sw.executeCommand('switchport private-vlan host-association 100 102');
  await sw.executeCommand('end');
  return sw;
}

describe('Private VLAN — VLAN role & association CLI', () => {
  it('rejects associating a VLAN with no secondary role to a primary VLAN', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('private-vlan primary');
    await sw.executeCommand('vlan 20');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan 10');
    const out = await sw.executeCommand('private-vlan association 20');
    expect(out).toContain('%');
    await sw.executeCommand('end');
    expect(sw.getPrivateVlanRole(10)).toBe('primary');
    expect(sw.getPrivateVlanAssociations(10).size).toBe(0);
  });

  it('rejects associating a private VLAN from a non-primary VLAN', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 30');
    await sw.executeCommand('private-vlan isolated');
    await sw.executeCommand('vlan 20');
    const out = await sw.executeCommand('private-vlan association 30');
    expect(out).toContain('%');
  });
});

describe('Private VLAN — isolated port reachability', () => {
  it('an isolated port broadcast reaches only the promiscuous port', async () => {
    const sw = await pvlanSwitch();
    const promisc = sniff(sw, 'FastEthernet0/1');
    const isolatedPeer = sniff(sw, 'FastEthernet0/3');
    const community1 = sniff(sw, 'FastEthernet0/4');
    const community2 = sniff(sw, 'FastEthernet0/5');

    const mac = new MACAddress('aa:bb:cc:00:00:01');
    sw.getPort('FastEthernet0/2')!.receiveFrame(untaggedFrame(mac, MACAddress.broadcast()));

    expect(promisc.frames.length).toBe(1);
    expect(isolatedPeer.frames.length).toBe(0);
    expect(community1.frames.length).toBe(0);
    expect(community2.frames.length).toBe(0);
  });
});

describe('Private VLAN — community port reachability', () => {
  it('a community port broadcast reaches the promiscuous port and same-secondary community peers, not isolated ports', async () => {
    const sw = await pvlanSwitch();
    const promisc = sniff(sw, 'FastEthernet0/1');
    const isolated1 = sniff(sw, 'FastEthernet0/2');
    const isolated2 = sniff(sw, 'FastEthernet0/3');
    const communityPeer = sniff(sw, 'FastEthernet0/5');

    const mac = new MACAddress('aa:bb:cc:00:00:02');
    sw.getPort('FastEthernet0/4')!.receiveFrame(untaggedFrame(mac, MACAddress.broadcast()));

    expect(promisc.frames.length).toBe(1);
    expect(communityPeer.frames.length).toBe(1);
    expect(isolated1.frames.length).toBe(0);
    expect(isolated2.frames.length).toBe(0);
  });
});

describe('Private VLAN — promiscuous port reachability', () => {
  it('a promiscuous port broadcast reaches every host port on the primary VLAN', async () => {
    const sw = await pvlanSwitch();
    const isolated1 = sniff(sw, 'FastEthernet0/2');
    const isolated2 = sniff(sw, 'FastEthernet0/3');
    const community1 = sniff(sw, 'FastEthernet0/4');
    const community2 = sniff(sw, 'FastEthernet0/5');

    const mac = new MACAddress('aa:bb:cc:00:00:03');
    sw.getPort('FastEthernet0/1')!.receiveFrame(untaggedFrame(mac, MACAddress.broadcast()));

    expect(isolated1.frames.length).toBe(1);
    expect(isolated2.frames.length).toBe(1);
    expect(community1.frames.length).toBe(1);
    expect(community2.frames.length).toBe(1);
  });
});

describe('Private VLAN — known-unicast isolation still blocked', () => {
  it('a known-unicast frame between two isolated ports on the same secondary VLAN is dropped, not just unknown/broadcast', async () => {
    const sw = await pvlanSwitch();
    const isolatedPeer = sniff(sw, 'FastEthernet0/3');
    const peerMac = new MACAddress('aa:bb:cc:00:00:04');
    sw.getPort('FastEthernet0/3')!.receiveFrame(untaggedFrame(peerMac, new MACAddress('aa:bb:cc:00:00:05')));
    expect(sw.getMACTable().some(e => e.mac === peerMac.toString().toLowerCase() && e.vlan === 101)).toBe(true);

    const srcMac = new MACAddress('aa:bb:cc:00:00:05');
    sw.getPort('FastEthernet0/2')!.receiveFrame(untaggedFrame(srcMac, peerMac));

    expect(isolatedPeer.frames.length).toBe(0);
  });
});
