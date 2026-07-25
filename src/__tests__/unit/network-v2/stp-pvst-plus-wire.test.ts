/**
 * PVST+ BPDU wire encapsulation (rapport 01 audit).
 *
 * Before this, every BPDU — access port, trunk native VLAN, or trunk
 * non-native VLAN — was sent to the plain IEEE bridge MAC with no 802.1Q
 * tag, regardless of port mode. Real IOS only does that for the CST BPDU
 * (access ports, and a trunk's native VLAN); every other VLAN on a trunk
 * gets its own 802.1Q-tagged BPDU to Cisco's proprietary PVST+/SSTP MAC
 * `01:00:0c:cc:cc:cd`. VLAN demux inside this engine still runs off the
 * BPDU payload's `vlan` field either way — this only fixes what a
 * `tcpdump` capture or wire inspection would see, not the internal
 * per-VLAN dispatch mechanism (see the comment in StpAgent.sendBpdu).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, resetCounters, type EthernetFrame } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { ETHERTYPE_STP, STP_BRIDGE_MAC, PVST_PLUS_MAC, type StpBpdu } from '@/network/stp/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface SeenBpdu { dst: string; vlan: number | undefined; tagVid: number | undefined }

function captureBpdus(bus: EventBus, cable: Cable): SeenBpdu[] {
  const seen: SeenBpdu[] = [];
  bus.subscribe('cable.frame.delivered', (e) => {
    const frame = e.payload.frame as EthernetFrame & { dot1q?: { vid: number } };
    if (frame.etherType !== ETHERTYPE_STP) return;
    const payload = frame.payload as StpBpdu;
    if (payload.bpduType !== 'config') return;
    seen.push({
      dst: frame.dstMAC.toString().toLowerCase(),
      vlan: payload.vlan,
      tagVid: frame.dot1q?.vid,
    });
  });
  cable.setEventBus(bus);
  return seen;
}

describe('Cisco PVST+ — access port and trunk native VLAN stay plain IEEE, untagged', () => {
  it('an access port BPDU uses the IEEE bridge MAC with no 802.1Q tag', () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    const cable = new Cable('w');
    const seen = captureBpdus(bus, cable);

    cable.connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);

    expect(seen.length).toBeGreaterThan(0);
    for (const f of seen) {
      expect(f.dst).toBe(STP_BRIDGE_MAC);
      expect(f.tagVid).toBeUndefined();
    }
  });

  it("a trunk port's native-VLAN BPDU is also untagged IEEE, even though the port is a trunk", async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    await s1.executeCommand('enable');
    await s1.executeCommand('configure terminal');
    await s1.executeCommand('interface FastEthernet0/1');
    await s1.executeCommand('switchport mode trunk');
    await s1.executeCommand('end');
    const cable = new Cable('w');
    const seen = captureBpdus(bus, cable);

    cable.connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);

    const nativeVlanBpdus = seen.filter((f) => f.vlan === 1);
    expect(nativeVlanBpdus.length).toBeGreaterThan(0);
    for (const f of nativeVlanBpdus) {
      expect(f.dst).toBe(STP_BRIDGE_MAC);
      expect(f.tagVid).toBeUndefined();
    }
  });
});

describe('Cisco PVST+ — a trunk\'s non-native VLAN gets the real PVST+ dressing', () => {
  it('sends an 802.1Q-tagged BPDU to the proprietary PVST+ MAC for VLAN 10 on a trunk', async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    await s1.executeCommand('enable');
    await s1.executeCommand('configure terminal');
    await s1.executeCommand('vlan 10');
    await s1.executeCommand('exit');
    await s1.executeCommand('interface FastEthernet0/1');
    await s1.executeCommand('switchport mode trunk');
    await s1.executeCommand('end');
    const cable = new Cable('w');
    const seen = captureBpdus(bus, cable);

    cable.connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);

    const vlan10Bpdus = seen.filter((f) => f.vlan === 10);
    expect(vlan10Bpdus.length).toBeGreaterThan(0);
    for (const f of vlan10Bpdus) {
      expect(f.dst).toBe(PVST_PLUS_MAC);
      expect(f.tagVid).toBe(10);
    }

    // The native VLAN (1) on that same trunk is unaffected.
    const nativeVlanBpdus = seen.filter((f) => f.vlan === 1);
    expect(nativeVlanBpdus.length).toBeGreaterThan(0);
    for (const f of nativeVlanBpdus) {
      expect(f.dst).toBe(STP_BRIDGE_MAC);
      expect(f.tagVid).toBeUndefined();
    }
  });

  it('a non-default trunk native VLAN shifts which VLAN stays untagged', async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    await s1.executeCommand('enable');
    await s1.executeCommand('configure terminal');
    await s1.executeCommand('vlan 10');
    await s1.executeCommand('exit');
    await s1.executeCommand('interface FastEthernet0/1');
    await s1.executeCommand('switchport mode trunk');
    await s1.executeCommand('switchport trunk native vlan 10');
    await s1.executeCommand('end');
    const cable = new Cable('w');
    const seen = captureBpdus(bus, cable);

    cable.connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);

    const vlan10Bpdus = seen.filter((f) => f.vlan === 10);
    const vlan1Bpdus = seen.filter((f) => f.vlan === 1);
    expect(vlan10Bpdus.length).toBeGreaterThan(0);
    expect(vlan1Bpdus.length).toBeGreaterThan(0);
    for (const f of vlan10Bpdus) expect(f.dst).toBe(STP_BRIDGE_MAC); // now native
    for (const f of vlan1Bpdus) expect(f.dst).toBe(PVST_PLUS_MAC); // no longer native
  });
});

describe('Cisco PVST+ — MST mode never gets PVST+ dressing', () => {
  it('a trunk port in mst mode stays on the plain IEEE MAC, untagged', async () => {
    const bus = new EventBus();
    const s1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const s2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    await s1.executeCommand('enable');
    await s1.executeCommand('configure terminal');
    await s1.executeCommand('spanning-tree mode mst');
    await s1.executeCommand('vlan 10');
    await s1.executeCommand('exit');
    await s1.executeCommand('interface FastEthernet0/1');
    await s1.executeCommand('switchport mode trunk');
    await s1.executeCommand('end');
    const cable = new Cable('w');
    const seen = captureBpdus(bus, cable);

    cable.connect(s1.getPort('FastEthernet0/1')!, s2.getPort('FastEthernet0/1')!);

    expect(seen.length).toBeGreaterThan(0);
    for (const f of seen) {
      expect(f.dst).toBe(STP_BRIDGE_MAC);
      expect(f.tagVid).toBeUndefined();
    }
  });
});

describe('Huawei — no PVST+ dressing (Cisco-proprietary, not part of VRP)', () => {
  it('a Huawei trunk port with a non-default VLAN never uses the Cisco PVST+ MAC or a tag', async () => {
    const bus = new EventBus();
    const s1 = new HuaweiSwitch('switch-huawei', 'SW1', 24);
    const s2 = new HuaweiSwitch('switch-huawei', 'SW2', 24);
    s1.setEventBus(bus);
    s2.setEventBus(bus);
    await s1.executeCommand('system-view');
    await s1.executeCommand('vlan batch 10');
    await s1.executeCommand('interface GigabitEthernet0/0/1');
    await s1.executeCommand('port link-type trunk');
    await s1.executeCommand('port trunk allow-pass vlan 10');
    await s1.executeCommand('quit');
    await s1.executeCommand('return');
    const cable = new Cable('w');
    const seen = captureBpdus(bus, cable);

    cable.connect(s1.getPort('GigabitEthernet0/0/1')!, s2.getPort('GigabitEthernet0/0/1')!);

    expect(seen.length).toBeGreaterThan(0);
    for (const f of seen) {
      expect(f.dst).toBe(STP_BRIDGE_MAC);
      expect(f.tagVid).toBeUndefined();
    }
  });
});
