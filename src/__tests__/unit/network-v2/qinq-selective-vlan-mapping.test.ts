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

function clientTaggedFrame(src: MACAddress, dst: MACAddress, cvlan: number): TaggedEthernetFrame {
  return {
    srcMAC: src, dstMAC: dst, etherType: ETHERTYPE_IPV4, payload: { type: 'test' },
    dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid: cvlan },
  };
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

describe('802.1Q Phase 4 — Cisco selective QinQ / VLAN mapping', () => {
  async function ciscoSwitch(): Promise<CiscoSwitch> {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode dot1q-tunnel');
    await sw.executeCommand('switchport access vlan 900');
    await sw.executeCommand('switchport vlan mapping 10 100');
    await sw.executeCommand('switchport vlan mapping 20 200');
    await sw.executeCommand('switchport vlan mapping 30 500');
    await sw.executeCommand('switchport vlan mapping 40 500');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan 100,200,500,900');
    await sw.executeCommand('end');
    return sw;
  }

  it('a 1:1 mapped C-VLAN is encapsulated with its own dedicated S-VLAN, not the port default', async () => {
    const sw = await ciscoSwitch();
    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      clientTaggedFrame(new MACAddress('aa:bb:cc:00:00:01'), MACAddress.broadcast(), 10));

    expect(out.frames.length).toBe(1);
    const f = out.frames[0] as TaggedEthernetFrame;
    expect(f.outerDot1q?.vid).toBe(100);
    expect(f.dot1q?.vid).toBe(10);
  });

  it('a different mapped C-VLAN on the same port lands on its own distinct S-VLAN (1:1 isolation)', async () => {
    const sw = await ciscoSwitch();
    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      clientTaggedFrame(new MACAddress('aa:bb:cc:00:00:02'), MACAddress.broadcast(), 20));

    expect(out.frames.length).toBe(1);
    const f = out.frames[0] as TaggedEthernetFrame;
    expect(f.outerDot1q?.vid).toBe(200);
    expect(f.dot1q?.vid).toBe(20);
  });

  it('two mapped C-VLANs sharing the same target S-VLAN aggregate onto one broadcast domain (N:1)', async () => {
    const sw = await ciscoSwitch();
    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      clientTaggedFrame(new MACAddress('aa:bb:cc:00:00:03'), MACAddress.broadcast(), 30));
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      clientTaggedFrame(new MACAddress('aa:bb:cc:00:00:04'), MACAddress.broadcast(), 40));

    expect(out.frames.length).toBe(2);
    expect((out.frames[0] as TaggedEthernetFrame).outerDot1q?.vid).toBe(500);
    expect((out.frames[1] as TaggedEthernetFrame).outerDot1q?.vid).toBe(500);
  });

  it('a doubly-tagged frame for a mapped S-VLAN is symmetrically de-encapsulated back through the tunnel port', async () => {
    const sw = await ciscoSwitch();
    const out = sniff(sw, 'FastEthernet0/1');
    const doubly: TaggedEthernetFrame = {
      srcMAC: new MACAddress('aa:bb:cc:00:00:05'), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: { type: 'test' },
      outerDot1q: { tpid: 0x88a8, pcp: 0, dei: 0, vid: 200 },
      dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid: 20 },
    };
    sw.getPort('FastEthernet0/2')!.receiveFrame(doubly);

    expect(out.frames.length).toBe(1);
    const f = out.frames[0] as TaggedEthernetFrame;
    expect(f.outerDot1q).toBeUndefined();
    expect(f.dot1q?.vid).toBe(20);
  });

  it('an unmapped C-VLAN on the same tunnel port still falls back to the port default S-VLAN (regression, Phase 3 behaviour)', async () => {
    const sw = await ciscoSwitch();
    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      clientTaggedFrame(new MACAddress('aa:bb:cc:00:00:06'), MACAddress.broadcast(), 999));

    expect(out.frames.length).toBe(1);
    const f = out.frames[0] as TaggedEthernetFrame;
    expect(f.outerDot1q?.vid).toBe(900);
    expect(f.dot1q?.vid).toBe(999);
  });
});

describe('802.1Q Phase 4 — Huawei selective QinQ / VLAN mapping', () => {
  async function huaweiSwitch(): Promise<HuaweiSwitch> {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan batch 100 200 500 900');
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    await sw.executeCommand('qinq enable');
    await sw.executeCommand('port default vlan 900');
    await sw.executeCommand('port vlan-mapping vlan 10 map-vlan 100');
    await sw.executeCommand('port vlan-mapping vlan 20 map-vlan 200');
    await sw.executeCommand('port vlan-mapping vlan 30 map-vlan 500');
    await sw.executeCommand('port vlan-mapping vlan 40 map-vlan 500');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/2');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('port trunk allow-pass vlan 100 200 500 900');
    await sw.executeCommand('quit');
    for (const v of [100, 200, 500, 900]) {
      sw.setStpVlanState('GigabitEthernet0/0/1', v, 'forwarding');
      sw.setStpVlanState('GigabitEthernet0/0/2', v, 'forwarding');
    }
    return sw;
  }

  it('a 1:1 mapped C-VLAN is encapsulated with its own dedicated S-VLAN, not the port default', async () => {
    const sw = await huaweiSwitch();
    const out = sniff(sw, 'GigabitEthernet0/0/2');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(
      clientTaggedFrame(new MACAddress('aa:bb:cc:00:01:01'), MACAddress.broadcast(), 10));

    expect(out.frames.length).toBe(1);
    const f = out.frames[0] as TaggedEthernetFrame;
    expect(f.outerDot1q?.vid).toBe(100);
    expect(f.dot1q?.vid).toBe(10);
  });

  it('two mapped C-VLANs sharing the same target S-VLAN aggregate onto one broadcast domain (N:1)', async () => {
    const sw = await huaweiSwitch();
    const out = sniff(sw, 'GigabitEthernet0/0/2');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(
      clientTaggedFrame(new MACAddress('aa:bb:cc:00:01:02'), MACAddress.broadcast(), 30));
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(
      clientTaggedFrame(new MACAddress('aa:bb:cc:00:01:03'), MACAddress.broadcast(), 40));

    expect(out.frames.length).toBe(2);
    expect((out.frames[0] as TaggedEthernetFrame).outerDot1q?.vid).toBe(500);
    expect((out.frames[1] as TaggedEthernetFrame).outerDot1q?.vid).toBe(500);
  });

  it('an unmapped C-VLAN on the same tunnel port still falls back to the port default S-VLAN (regression, Phase 3 behaviour)', async () => {
    const sw = await huaweiSwitch();
    const out = sniff(sw, 'GigabitEthernet0/0/2');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(
      clientTaggedFrame(new MACAddress('aa:bb:cc:00:01:04'), MACAddress.broadcast(), 999));

    expect(out.frames.length).toBe(1);
    const f = out.frames[0] as TaggedEthernetFrame;
    expect(f.outerDot1q?.vid).toBe(900);
    expect(f.dot1q?.vid).toBe(999);
  });

  it('display current-configuration interface reflects the vlan-mapping rules', async () => {
    const sw = await huaweiSwitch();
    const out = await sw.executeCommand('display current-configuration interface GigabitEthernet0/0/1');
    expect(out).toContain('port vlan-mapping vlan 10 map-vlan 100');
  });
});
