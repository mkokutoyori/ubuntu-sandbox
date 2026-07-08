import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters, ETHERTYPE_IPV4, IP_PROTO_TCP, computeIPv4Checksum } from '@/network/core/types';
import { IPAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import type { EthernetFrame, IPv4Packet } from '@/network/core/types';
import type { TaggedEthernetFrame } from '@/network/devices/Switch';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function untaggedTestFrame(src: MACAddress, dst: MACAddress): EthernetFrame {
  return { srcMAC: src, dstMAC: dst, etherType: ETHERTYPE_IPV4, payload: { type: 'test' } };
}

function taggedTestFrame(src: MACAddress, dst: MACAddress, vid: number, pcp: number): TaggedEthernetFrame {
  return {
    srcMAC: src, dstMAC: dst, etherType: ETHERTYPE_IPV4, payload: { type: 'test' },
    dot1q: { tpid: 0x8100, pcp, dei: 0, vid },
  };
}

function ipFrameWithDscp(src: MACAddress, dst: MACAddress, dscp: number): EthernetFrame {
  const ip: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: (dscp << 2) & 0xfc, totalLength: 20,
    identification: 1, flags: 0, fragmentOffset: 0, ttl: 64, protocol: IP_PROTO_TCP,
    headerChecksum: 0, sourceIP: new IPAddress('10.0.0.1'), destinationIP: new IPAddress('10.0.0.2'),
    payload: null,
  };
  ip.headerChecksum = computeIPv4Checksum(ip);
  return { srcMAC: src, dstMAC: dst, etherType: ETHERTYPE_IPV4, payload: ip };
}

function sniff(sw: CiscoSwitch, portName: string): { frames: EthernetFrame[] } {
  const sniffer = new Port(`sniff-${portName}`);
  const box = { frames: [] as EthernetFrame[] };
  sniffer.onFrame((_n, f) => {
    if (f.etherType === ETHERTYPE_IPV4) box.frames.push(f);
  });
  new Cable(`c-${sw.getName()}-${portName}`).connect(sw.getPort(portName)!, sniffer);
  return box;
}

describe('802.1Q Phase 2a — Cisco 802.1p (PCP) trust/classification model', () => {
  it('an untrusted port always tags egress traffic with PCP 0, regardless of an incoming tag', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan 10');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan 10');
    await sw.executeCommand('end');

    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      taggedTestFrame(new MACAddress('aa:bb:cc:00:00:01'), MACAddress.broadcast(), 10, 5));

    expect(out.frames.length).toBe(1);
    expect((out.frames[0] as TaggedEthernetFrame).dot1q?.pcp).toBe(0);
  });

  it('mls qos trust cos preserves the incoming PCP across a trunk-to-trunk hop', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan 10');
    await sw.executeCommand('mls qos trust cos');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan 10');
    await sw.executeCommand('end');

    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      taggedTestFrame(new MACAddress('aa:bb:cc:00:00:02'), MACAddress.broadcast(), 10, 5));

    expect(out.frames.length).toBe(1);
    expect((out.frames[0] as TaggedEthernetFrame).dot1q?.pcp).toBe(5);
  });

  it('mls qos trust dscp derives CoS from the IP DSCP field on untagged ingress', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode access');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('mls qos trust dscp');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan 10');
    await sw.executeCommand('end');

    const out = sniff(sw, 'FastEthernet0/2');
    // DSCP 46 (EF, voice) => CoS 5 (top 3 bits of the 6-bit DSCP value).
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      ipFrameWithDscp(new MACAddress('aa:bb:cc:00:00:03'), MACAddress.broadcast(), 46));

    expect(out.frames.length).toBe(1);
    expect((out.frames[0] as TaggedEthernetFrame).dot1q?.pcp).toBe(5);
  });

  it('mls qos cos sets the default CoS applied to untrusted/untagged traffic', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode access');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('mls qos cos 3');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan 10');
    await sw.executeCommand('end');

    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      untaggedTestFrame(new MACAddress('aa:bb:cc:00:00:04'), MACAddress.broadcast()));

    expect(out.frames.length).toBe(1);
    expect((out.frames[0] as TaggedEthernetFrame).dot1q?.pcp).toBe(3);
  });

  it('switchport priority extend cos remarks downstream PC traffic on a voice-vlan access port', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan 20');
    await sw.executeCommand('exit');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode access');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('switchport voice vlan 20');
    await sw.executeCommand('switchport priority extend cos 2');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan 10,20');
    await sw.executeCommand('end');

    const out = sniff(sw, 'FastEthernet0/2');
    // PC data traffic (native/access VLAN 10, untagged as it arrives from the
    // PC through the phone's pass-through port) must be remarked to CoS 2.
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      untaggedTestFrame(new MACAddress('aa:bb:cc:00:00:05'), MACAddress.broadcast()));

    expect(out.frames.length).toBe(1);
    expect((out.frames[0] as TaggedEthernetFrame).dot1q?.pcp).toBe(2);
  });

  it('switchport priority extend trust falls back to the port\'s normal trust boundary instead of remarking', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('exit');
    await sw.executeCommand('vlan 20');
    await sw.executeCommand('exit');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode access');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('switchport voice vlan 20');
    await sw.executeCommand('switchport priority extend trust');
    await sw.executeCommand('mls qos cos 4');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan 10,20');
    await sw.executeCommand('end');

    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      untaggedTestFrame(new MACAddress('aa:bb:cc:00:00:06'), MACAddress.broadcast()));

    expect(out.frames.length).toBe(1);
    // No fixed remark configured -> falls through to the port's own default CoS.
    expect((out.frames[0] as TaggedEthernetFrame).dot1q?.pcp).toBe(4);
  });

  it('show queuing interface reflects the real trust state and default CoS', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('mls qos trust dscp');
    await sw.executeCommand('mls qos cos 2');
    await sw.executeCommand('end');

    const out = await sw.executeCommand('show queuing interface FastEthernet0/1');
    expect(out).toContain('trust dscp');
    expect(out).toContain('Default COS is 2');
  });

  it('show running-config interface reflects the configured trust/priority-extend lines', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('mls qos trust cos');
    await sw.executeCommand('switchport priority extend cos 1');
    await sw.executeCommand('end');

    const out = await sw.executeCommand('show running-config interface FastEthernet0/1');
    expect(out).toContain('mls qos trust cos');
    expect(out).toContain('switchport priority extend cos 1');
  });
});
