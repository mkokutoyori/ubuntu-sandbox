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

function priorityTaggedFrame(src: MACAddress, dst: MACAddress, pcp: number): TaggedEthernetFrame {
  return {
    srcMAC: src, dstMAC: dst, etherType: ETHERTYPE_IPV4, payload: { type: 'test' },
    dot1q: { tpid: 0x8100, pcp, dei: 0, vid: 0 },
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

describe('Reserved VLAN range — universal IEEE bounds', () => {
  it('createVLAN rejects VID 0 and 4095 on both vendors', () => {
    const cisco = new CiscoSwitch('switch-cisco', 'SW1', 8);
    const huawei = new HuaweiSwitch('switch-huawei', 'SW2', 8);
    for (const sw of [cisco, huawei]) {
      expect(sw.createVLAN(0)).toBe(false);
      expect(sw.createVLAN(4095)).toBe(false);
    }
  });
});

describe('Reserved VLAN range — Cisco 1002-1005 (legacy FDDI/Token Ring)', () => {
  it('the CLI refuses vlan 1002-1005 with an explicit message', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    const out = await sw.executeCommand('vlan 1002');
    expect(out).toContain('%');
    expect(out).toMatch(/reserved/i);
    expect(sw.getVLAN(1002)).toBeUndefined();
    const range = await sw.executeCommand('vlan 1000-1003');
    expect(range).toMatch(/reserved/i);
    expect(sw.getVLAN(1000)).toBeUndefined();
  });

  it('the engine rejects create and delete of 1002-1005 even when bypassing the CLI', () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    for (const id of [1002, 1003, 1004, 1005]) {
      expect(sw.createVLAN(id)).toBe(false);
      expect(sw.deleteVLAN(id)).toBe(false);
    }
  });

  it('adjacent VIDs 1001 stay usable on Cisco', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 1001');
    await sw.executeCommand('end');
    expect(sw.getVLAN(1001)).toBeDefined();
  });

  it('Huawei does NOT reserve 1002-1005 (no artificial vendor parity)', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan 1002');
    await sw.executeCommand('quit');
    expect(sw.getVLAN(1002)).toBeDefined();
    expect(sw.createVLAN(1003)).toBe(true);
  });
});

describe('802.1Q Phase 6 — VID 0 priority-tag handling (both vendors)', () => {
  it('Cisco: a priority-tagged frame on a trunk rides the native VLAN instead of being filtered', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('end');

    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      priorityTaggedFrame(new MACAddress('aa:bb:cc:00:00:01'), MACAddress.broadcast(), 5));

    expect(out.frames.length).toBe(1);
    expect((out.frames[0] as TaggedEthernetFrame).dot1q).toBeUndefined();
  });

  it('Cisco: the priority-tag\'s CoS is still honored under mls qos trust cos', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('mls qos trust cos');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk native vlan 99');
    await sw.executeCommand('end');

    const out = sniff(sw, 'FastEthernet0/2');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      priorityTaggedFrame(new MACAddress('aa:bb:cc:00:00:02'), MACAddress.broadcast(), 5));

    expect(out.frames.length).toBe(1);
    const f = out.frames[0] as TaggedEthernetFrame;
    expect(f.dot1q?.vid).toBe(1);
    expect(f.dot1q?.pcp).toBe(5);
  });

  it('Cisco: a real, disallowed VLAN tag is still filtered on a trunk (regression control)', async () => {
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
    sw.getPort('FastEthernet0/1')!.receiveFrame({
      srcMAC: new MACAddress('aa:bb:cc:00:00:03'), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: { type: 'test' },
      dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid: 20 },
    } as TaggedEthernetFrame);

    expect(out.frames.length).toBe(0);
  });

  it('Huawei: a priority-tagged frame on a trunk rides the native (PVID) VLAN instead of being filtered', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/2');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('quit');
    sw.setStpVlanState('GigabitEthernet0/0/1', 1, 'forwarding');
    sw.setStpVlanState('GigabitEthernet0/0/2', 1, 'forwarding');

    const out = sniff(sw, 'GigabitEthernet0/0/2');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(
      priorityTaggedFrame(new MACAddress('aa:bb:cc:00:01:01'), MACAddress.broadcast(), 5));

    expect(out.frames.length).toBe(1);
    expect((out.frames[0] as TaggedEthernetFrame).dot1q).toBeUndefined();
  });

  it('Huawei: a real, disallowed VLAN tag is still filtered on a trunk (regression control)', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan batch 10');
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('port trunk allow-pass vlan none');
    await sw.executeCommand('port trunk allow-pass vlan 10');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/2');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('port trunk allow-pass vlan none');
    await sw.executeCommand('port trunk allow-pass vlan 10');
    await sw.executeCommand('quit');
    sw.setStpVlanState('GigabitEthernet0/0/1', 20, 'forwarding');
    sw.setStpVlanState('GigabitEthernet0/0/2', 20, 'forwarding');

    const out = sniff(sw, 'GigabitEthernet0/0/2');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame({
      srcMAC: new MACAddress('aa:bb:cc:00:01:02'), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: { type: 'test' },
      dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid: 20 },
    } as TaggedEthernetFrame);

    expect(out.frames.length).toBe(0);
  });
});
