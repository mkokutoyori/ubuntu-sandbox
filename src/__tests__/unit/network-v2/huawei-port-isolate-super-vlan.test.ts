import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters, ETHERTYPE_IPV4 } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Port } from '@/network/hardware/Port';
import type { EthernetFrame } from '@/network/core/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function untaggedFrame(src: MACAddress, dst: MACAddress): EthernetFrame {
  return { srcMAC: src, dstMAC: dst, etherType: ETHERTYPE_IPV4, payload: { type: 'test' } };
}

function sniff(sw: HuaweiSwitch, portName: string): { frames: EthernetFrame[] } {
  const sniffer = new Port(`sniff-${portName}`);
  const box = { frames: [] as EthernetFrame[] };
  sniffer.onFrame((_n, f) => {
    if (f.etherType === ETHERTYPE_IPV4 && (f.payload as { type?: string })?.type === 'test') box.frames.push(f);
  });
  new Cable(`c-${portName}`).connect(sw.getPort(portName)!, sniffer);
  return box;
}

describe('Huawei port-isolate — real port isolation', () => {
  async function isolatedSwitch(): Promise<HuaweiSwitch> {
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan batch 10');
    for (const p of ['GigabitEthernet0/0/1', 'GigabitEthernet0/0/2', 'GigabitEthernet0/0/3']) {
      await sw.executeCommand(`interface ${p}`);
      await sw.executeCommand('port link-type access');
      await sw.executeCommand('port default vlan 10');
      await sw.executeCommand('quit');
    }
    await sw.executeCommand('interface GigabitEthernet0/0/1');
    await sw.executeCommand('port-isolate enable');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/2');
    await sw.executeCommand('port-isolate enable');
    await sw.executeCommand('quit');
    for (const p of ['GigabitEthernet0/0/1', 'GigabitEthernet0/0/2', 'GigabitEthernet0/0/3']) {
      sw.setStpVlanState(p, 10, 'forwarding');
    }
    return sw;
  }

  it('two isolated ports in the same group cannot reach each other', async () => {
    const sw = await isolatedSwitch();
    const peer = sniff(sw, 'GigabitEthernet0/0/2');
    const mac = new MACAddress('aa:bb:cc:00:00:01');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(untaggedFrame(mac, MACAddress.broadcast()));
    expect(peer.frames.length).toBe(0);
  });

  it('an isolated port still reaches a non-isolated port', async () => {
    const sw = await isolatedSwitch();
    const nonIsolated = sniff(sw, 'GigabitEthernet0/0/3');
    const mac = new MACAddress('aa:bb:cc:00:00:02');
    sw.getPort('GigabitEthernet0/0/1')!.receiveFrame(untaggedFrame(mac, MACAddress.broadcast()));
    expect(nonIsolated.frames.length).toBe(1);
  });

  it('a non-isolated port reaches both isolated ports', async () => {
    const sw = await isolatedSwitch();
    const isolated1 = sniff(sw, 'GigabitEthernet0/0/1');
    const isolated2 = sniff(sw, 'GigabitEthernet0/0/2');
    const mac = new MACAddress('aa:bb:cc:00:00:03');
    sw.getPort('GigabitEthernet0/0/3')!.receiveFrame(untaggedFrame(mac, MACAddress.broadcast()));
    expect(isolated1.frames.length).toBe(1);
    expect(isolated2.frames.length).toBe(1);
  });
});

describe('Huawei Super-VLAN / Sub-VLAN', () => {
  it('hosts on different sub-VLANs both reach the shared super-VLAN SVI (single L3 gateway)', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'L3SW', 8);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    const pc2 = new LinuxPC('pc2', 'PC2', 0, 0);
    new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('GigabitEthernet0/0/1')!);
    new Cable('c2').connect(pc2.getPorts()[0], sw.getPort('GigabitEthernet0/0/2')!);

    for (const cmd of [
      'system-view',
      'vlan batch 10 20 30',
      'vlan 10', 'aggregate-vlan', 'access-vlan 20 30', 'quit',
      'interface GigabitEthernet0/0/1', 'port link-type access', 'port default vlan 20', 'quit',
      'interface GigabitEthernet0/0/2', 'port link-type access', 'port default vlan 30', 'quit',
      'interface Vlanif10', 'ip address 10.0.100.1 255.255.255.0', 'undo shutdown', 'quit',
    ]) await sw.executeCommand(cmd);

    await pc1.executeCommand('ifconfig eth0 10.0.100.10 netmask 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.100.20 netmask 255.255.255.0');

    const out1 = await pc1.executeCommand('ping -c 1 10.0.100.1');
    expect(out1).toMatch(/64 bytes from 10\.0\.100\.1/);
    expect(out1).toMatch(/1 packets transmitted, 1 received/);
    const out2 = await pc2.executeCommand('ping -c 1 10.0.100.1');
    expect(out2).toMatch(/64 bytes from 10\.0\.100\.1/);
    expect(out2).toMatch(/1 packets transmitted, 1 received/);

    expect(sw.getSuperVlanOf(20)).toBe(10);
    expect(sw.getSuperVlanOf(30)).toBe(10);
  });
});
