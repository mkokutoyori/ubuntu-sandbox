import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters, ETHERTYPE_IPV4 } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Port } from '@/network/hardware/Port';
import { Cable } from '@/network/hardware/Cable';
import type { EthernetFrame } from '@/network/core/types';
import type { TaggedEthernetFrame } from '@/network/devices/Switch';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
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
  new Cable(`c-${sw.getName()}-${portName}`).connect(sw.getPort(portName)!, sniffer);
  return box;
}

async function definePvlan(sw: CiscoSwitch): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('vlan 100');
  await sw.executeCommand('private-vlan primary');
  await sw.executeCommand('vlan 101');
  await sw.executeCommand('private-vlan isolated');
  await sw.executeCommand('vlan 100');
  await sw.executeCommand('private-vlan association 101');
  await sw.executeCommand('end');
}

async function hostPort(sw: CiscoSwitch, port: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('switchport mode private-vlan host');
  await sw.executeCommand('switchport private-vlan host-association 100 101');
  await sw.executeCommand('end');
}

async function promiscuousPort(sw: CiscoSwitch, port: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('switchport mode private-vlan promiscuous');
  await sw.executeCommand('switchport private-vlan mapping 100 101');
  await sw.executeCommand('end');
}

async function plainTrunk(sw: CiscoSwitch, port: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('switchport mode trunk');
  await sw.executeCommand('end');
}

describe('PVLAN across two switches over a standard trunk', () => {
  async function twoSwitchLab() {
    const a = new CiscoSwitch('switch-cisco', 'SWA', 8);
    const b = new CiscoSwitch('switch-cisco', 'SWB', 8);
    await definePvlan(a);
    await definePvlan(b);
    await promiscuousPort(a, 'FastEthernet0/1');
    await hostPort(a, 'FastEthernet0/2');
    await hostPort(b, 'FastEthernet0/1');
    await hostPort(b, 'FastEthernet0/2');
    await plainTrunk(a, 'FastEthernet0/8');
    await plainTrunk(b, 'FastEthernet0/8');
    new Cable('ab').connect(a.getPort('FastEthernet0/8')!, b.getPort('FastEthernet0/8')!);
    return { a, b };
  }

  it('an isolated host on switch B reaches the promiscuous port on switch A, and nothing else', async () => {
    const { a, b } = await twoSwitchLab();
    const promiscA = sniff(a, 'FastEthernet0/1');
    const isolatedA = sniff(a, 'FastEthernet0/2');
    const isolatedB2 = sniff(b, 'FastEthernet0/2');

    b.getPort('FastEthernet0/1')!.receiveFrame(
      untaggedFrame(new MACAddress('aa:bb:cc:00:00:01'), MACAddress.broadcast()));

    expect(promiscA.frames.length).toBe(1);
    expect(isolatedA.frames.length).toBe(0);
    expect(isolatedB2.frames.length).toBe(0);
  });

  it('a promiscuous broadcast on switch A reaches every isolated host on both switches', async () => {
    const { a, b } = await twoSwitchLab();
    const isolatedA = sniff(a, 'FastEthernet0/2');
    const isolatedB1 = sniff(b, 'FastEthernet0/1');
    const isolatedB2 = sniff(b, 'FastEthernet0/2');

    a.getPort('FastEthernet0/1')!.receiveFrame(
      untaggedFrame(new MACAddress('aa:bb:cc:00:00:02'), MACAddress.broadcast()));

    expect(isolatedA.frames.length).toBe(1);
    expect(isolatedB1.frames.length).toBe(1);
    expect(isolatedB2.frames.length).toBe(1);
  });
});

describe('PVLAN promiscuous trunk — secondary traffic remapped to the primary VLAN', () => {
  it('an isolated host broadcast egresses the promiscuous trunk tagged with the primary VLAN', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await definePvlan(sw);
    await hostPort(sw, 'FastEthernet0/1');
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/8');
    await sw.executeCommand('switchport mode private-vlan trunk promiscuous');
    await sw.executeCommand('switchport private-vlan mapping trunk 100 101');
    await sw.executeCommand('end');

    const uplink = sniff(sw, 'FastEthernet0/8');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      untaggedFrame(new MACAddress('aa:bb:cc:00:00:03'), MACAddress.broadcast()));

    expect(uplink.frames.length).toBe(1);
    expect((uplink.frames[0] as TaggedEthernetFrame).dot1q?.vid).toBe(100);
  });

  it('mapping trunk with a non-associated secondary VLAN is rejected', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await definePvlan(sw);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/8');
    await sw.executeCommand('switchport mode private-vlan trunk promiscuous');
    const out = await sw.executeCommand('switchport private-vlan mapping trunk 100 999');
    expect(out).toContain('%');
  });
});

describe('PVLAN isolated trunk — primary traffic remapped to the secondary VLAN', () => {
  it('a promiscuous broadcast egresses the isolated trunk tagged with the secondary VLAN', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await definePvlan(sw);
    await promiscuousPort(sw, 'FastEthernet0/1');
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/8');
    await sw.executeCommand('switchport mode private-vlan trunk host');
    await sw.executeCommand('switchport private-vlan association trunk 100 101');
    await sw.executeCommand('end');

    const downlink = sniff(sw, 'FastEthernet0/8');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      untaggedFrame(new MACAddress('aa:bb:cc:00:00:04'), MACAddress.broadcast()));

    expect(downlink.frames.length).toBe(1);
    expect((downlink.frames[0] as TaggedEthernetFrame).dot1q?.vid).toBe(101);
  });

  it('an isolated host broadcast never egresses another isolated trunk', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await definePvlan(sw);
    await hostPort(sw, 'FastEthernet0/1');
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/8');
    await sw.executeCommand('switchport mode private-vlan trunk host');
    await sw.executeCommand('switchport private-vlan association trunk 100 101');
    await sw.executeCommand('end');

    const downlink = sniff(sw, 'FastEthernet0/8');
    sw.getPort('FastEthernet0/1')!.receiveFrame(
      untaggedFrame(new MACAddress('aa:bb:cc:00:00:05'), MACAddress.broadcast()));

    expect(downlink.frames.length).toBe(0);
  });
});
