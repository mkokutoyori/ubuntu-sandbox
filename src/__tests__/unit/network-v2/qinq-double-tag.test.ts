import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { MACAddress, resetCounters, ETHERTYPE_IPV4 } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import type { EthernetFrame } from '@/network/core/types';
import type { Switch, TaggedEthernetFrame } from '@/network/devices/Switch';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function untaggedFrame(src: MACAddress, dst: MACAddress): EthernetFrame {
  return { srcMAC: src, dstMAC: dst, etherType: ETHERTYPE_IPV4, payload: { type: 'test' } };
}

function clientTaggedFrame(src: MACAddress, dst: MACAddress, cvlan: number): TaggedEthernetFrame {
  return {
    srcMAC: src, dstMAC: dst, etherType: ETHERTYPE_IPV4, payload: { type: 'test' },
    dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid: cvlan },
  };
}

function doublyTaggedFrame(src: MACAddress, dst: MACAddress, svlan: number, cvlan?: number): TaggedEthernetFrame {
  const frame: TaggedEthernetFrame = {
    srcMAC: src, dstMAC: dst, etherType: ETHERTYPE_IPV4, payload: { type: 'test' },
    outerDot1q: { tpid: 0x88a8, pcp: 0, dei: 0, vid: svlan },
  };
  if (cvlan !== undefined) frame.dot1q = { tpid: 0x8100, pcp: 0, dei: 0, vid: cvlan };
  return frame;
}

function sniff(sw: Switch, portName: string): { frames: EthernetFrame[] } {
  const sniffer = new Port(`sniff-${portName}`);
  const box = { frames: [] as EthernetFrame[] };
  sniffer.onFrame((_n, f) => {
    if (f.etherType === ETHERTYPE_IPV4) box.frames.push(f);
  });
  new Cable(`c-${sw.getName()}-${portName}`).connect(sw.getPort(portName)!, sniffer);
  return box;
}

describe('802.1Q Phase 3 — Cisco QinQ base (switchport mode dot1q-tunnel)', () => {
  async function ciscoQinqSwitch(): Promise<CiscoSwitch> {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode dot1q-tunnel');
    await sw.executeCommand('switchport access vlan 100');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan 100');
    await sw.executeCommand('end');
    return sw;
  }

  it('an untagged client frame is wrapped with an S-VLAN outer tag (EtherType 0x88a8) crossing the provider trunk', async () => {
    const sw = await ciscoQinqSwitch();
    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      untaggedFrame(new MACAddress('aa:bb:cc:00:00:01'), MACAddress.broadcast()));

    expect(out.frames.length).toBe(1);
    const f = out.frames[0] as TaggedEthernetFrame;
    expect(f.outerDot1q?.tpid).toBe(0x88a8);
    expect(f.outerDot1q?.vid).toBe(100);
    expect(f.dot1q).toBeUndefined();
  });

  it('a client-tagged frame keeps its own C-VLAN tag intact underneath the new S-VLAN outer tag', async () => {
    const sw = await ciscoQinqSwitch();
    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      clientTaggedFrame(new MACAddress('aa:bb:cc:00:00:02'), MACAddress.broadcast(), 20));

    expect(out.frames.length).toBe(1);
    const f = out.frames[0] as TaggedEthernetFrame;
    expect(f.outerDot1q?.tpid).toBe(0x88a8);
    expect(f.outerDot1q?.vid).toBe(100);
    expect(f.dot1q?.vid).toBe(20);
  });

  it('a doubly-tagged frame arriving from the provider trunk is symmetrically de-encapsulated back to the exact original client frame', async () => {
    const sw = await ciscoQinqSwitch();
    const out = sniff(sw, 'FastEthernet0/1');
    sw.getPort('FastEthernet0/2')!.receiveFrame(
      doublyTaggedFrame(new MACAddress('aa:bb:cc:00:00:03'), MACAddress.broadcast(), 100, 20));

    expect(out.frames.length).toBe(1);
    const f = out.frames[0] as TaggedEthernetFrame;
    expect(f.outerDot1q).toBeUndefined();
    expect(f.dot1q?.vid).toBe(20);
  });

  it('show running-config interface reflects the dot1q-tunnel mode', async () => {
    const sw = await ciscoQinqSwitch();
    const out = await sw.executeCommand('show running-config interface FastEthernet0/1');
    expect(out).toContain('switchport mode dot1q-tunnel');
    expect(out).toContain('switchport access vlan 100');
  });
});

describe('802.1Q Phase 3 — Huawei QinQ base (qinq enable)', () => {
  async function huaweiQinqSwitch(): Promise<HuaweiSwitch> {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan batch 100');
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    await sw.executeCommand('qinq enable');
    await sw.executeCommand('port default vlan 100');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/2');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('port trunk allow-pass vlan 100');
    await sw.executeCommand('quit');
    sw.setStpVlanState('GigabitEthernet0/0/1', 100, 'forwarding');
    sw.setStpVlanState('GigabitEthernet0/0/2', 100, 'forwarding');
    return sw;
  }

  it('an untagged client frame is wrapped with an S-VLAN outer tag (EtherType 0x88a8) crossing the provider trunk', async () => {
    const sw = await huaweiQinqSwitch();
    const out = sniff(sw, 'GigabitEthernet0/0/2');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(
      untaggedFrame(new MACAddress('aa:bb:cc:00:01:01'), MACAddress.broadcast()));

    expect(out.frames.length).toBe(1);
    const f = out.frames[0] as TaggedEthernetFrame;
    expect(f.outerDot1q?.tpid).toBe(0x88a8);
    expect(f.outerDot1q?.vid).toBe(100);
    expect(f.dot1q).toBeUndefined();
  });

  it('a client-tagged frame keeps its own C-VLAN tag intact underneath the new S-VLAN outer tag', async () => {
    const sw = await huaweiQinqSwitch();
    const out = sniff(sw, 'GigabitEthernet0/0/2');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(
      clientTaggedFrame(new MACAddress('aa:bb:cc:00:01:02'), MACAddress.broadcast(), 20));

    expect(out.frames.length).toBe(1);
    const f = out.frames[0] as TaggedEthernetFrame;
    expect(f.outerDot1q?.tpid).toBe(0x88a8);
    expect(f.outerDot1q?.vid).toBe(100);
    expect(f.dot1q?.vid).toBe(20);
  });

  it('a doubly-tagged frame arriving from the provider trunk is symmetrically de-encapsulated back to the exact original client frame', async () => {
    const sw = await huaweiQinqSwitch();
    const out = sniff(sw, 'GigabitEthernet0/0/1');
    sw.getPort('GigabitEthernet0/0/2')!.receiveFrame(
      doublyTaggedFrame(new MACAddress('aa:bb:cc:00:01:03'), MACAddress.broadcast(), 100, 20));

    expect(out.frames.length).toBe(1);
    const f = out.frames[0] as TaggedEthernetFrame;
    expect(f.outerDot1q).toBeUndefined();
    expect(f.dot1q?.vid).toBe(20);
  });

  it('display current-configuration interface reflects qinq enable on the tunnel port', async () => {
    const sw = await huaweiQinqSwitch();
    const out = await sw.executeCommand('display current-configuration interface GigabitEthernet0/0/1');
    expect(out).toContain('qinq enable');
  });
});
