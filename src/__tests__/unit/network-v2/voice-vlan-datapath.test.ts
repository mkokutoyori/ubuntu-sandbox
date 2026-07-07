import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters, ETHERTYPE_IPV4 } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import type { EthernetFrame } from '@/network/core/types';
import type { TaggedEthernetFrame } from '@/network/devices/Switch';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

function taggedFrame(vid: number, src: MACAddress, dst: MACAddress): TaggedEthernetFrame {
  return {
    srcMAC: src,
    dstMAC: dst,
    etherType: ETHERTYPE_IPV4,
    payload: { type: 'test' },
    dot1q: { tpid: 0x8100, pcp: 0, dei: 0, vid },
  };
}

function untaggedFrame(src: MACAddress, dst: MACAddress): EthernetFrame {
  return { srcMAC: src, dstMAC: dst, etherType: ETHERTYPE_IPV4, payload: { type: 'test' } };
}

async function ciscoAccessWithVoice(port: string, accessVlan: number, voiceVlan: number): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('switchport mode access');
  await sw.executeCommand(`switchport access vlan ${accessVlan}`);
  await sw.executeCommand(`switchport voice vlan ${voiceVlan}`);
  await sw.executeCommand('end');
  return sw;
}

describe('Voice VLAN — dual-channel ingress (common datapath)', () => {
  it('a frame tagged with the voice VLAN on an access port is learned on the voice VLAN, not the access VLAN', async () => {
    const sw = await ciscoAccessWithVoice('FastEthernet0/1', 10, 100);
    const phoneMac = new MACAddress('aa:bb:cc:00:00:01');
    const someDst = new MACAddress('aa:bb:cc:00:00:02');
    sw.getPort('FastEthernet0/1')!.receiveFrame(taggedFrame(100, phoneMac, someDst));

    const entry = sw.getMACTable().find(e => e.mac === phoneMac.toString().toLowerCase());
    expect(entry).toBeDefined();
    expect(entry!.vlan).toBe(100);
  });

  it('an untagged frame on the same port still lands on the access (data) VLAN — unaffected', async () => {
    const sw = await ciscoAccessWithVoice('FastEthernet0/1', 10, 100);
    const pcMac = new MACAddress('aa:bb:cc:00:00:03');
    const someDst = new MACAddress('aa:bb:cc:00:00:04');
    sw.getPort('FastEthernet0/1')!.receiveFrame(untaggedFrame(pcMac, someDst));

    const entry = sw.getMACTable().find(e => e.mac === pcMac.toString().toLowerCase());
    expect(entry).toBeDefined();
    expect(entry!.vlan).toBe(10);
  });

  it('a tagged frame on an access port with no voice VLAN configured keeps today\'s behavior (learned on access VLAN)', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport mode access');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('end');

    const mac = new MACAddress('aa:bb:cc:00:00:05');
    const dst = new MACAddress('aa:bb:cc:00:00:06');
    sw.getPort('FastEthernet0/1')!.receiveFrame(taggedFrame(999, mac, dst));

    const entry = sw.getMACTable().find(e => e.mac === mac.toString().toLowerCase());
    expect(entry).toBeDefined();
    expect(entry!.vlan).toBe(10);
  });
});

describe('Voice VLAN — dual-channel egress (common datapath)', () => {
  it('broadcast voice-VLAN traffic floods to other voice-VLAN access ports tagged, and not into the data VLAN', async () => {
    const sw = await ciscoAccessWithVoice('FastEthernet0/1', 10, 100);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode access');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('switchport voice vlan 100');
    await sw.executeCommand('end');

    const sniffer = new Port('sniffer');
    let capturedOnP2: EthernetFrame | null = null;
    sniffer.onFrame((_name, frame) => { capturedOnP2 = frame; });
    new Cable('sniff').connect(sw.getPort('FastEthernet0/2')!, sniffer);

    const phoneMac = new MACAddress('aa:bb:cc:00:00:07');
    sw.getPort('FastEthernet0/1')!.receiveFrame(taggedFrame(100, phoneMac, MACAddress.broadcast()));

    expect(capturedOnP2).not.toBeNull();
    expect((capturedOnP2 as unknown as TaggedEthernetFrame).dot1q?.vid).toBe(100);
  });

  it('broadcast data-VLAN traffic still floods untagged to other access ports — unaffected', async () => {
    const sw = await ciscoAccessWithVoice('FastEthernet0/1', 10, 100);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/2');
    await sw.executeCommand('switchport mode access');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('switchport voice vlan 100');
    await sw.executeCommand('end');

    const sniffer = new Port('sniffer');
    let capturedOnP2: EthernetFrame | null = null;
    sniffer.onFrame((_name, frame) => { capturedOnP2 = frame; });
    new Cable('sniff').connect(sw.getPort('FastEthernet0/2')!, sniffer);

    const pcMac = new MACAddress('aa:bb:cc:00:00:08');
    sw.getPort('FastEthernet0/1')!.receiveFrame(untaggedFrame(pcMac, MACAddress.broadcast()));

    expect(capturedOnP2).not.toBeNull();
    expect((capturedOnP2 as unknown as TaggedEthernetFrame).dot1q).toBeUndefined();
  });
});
