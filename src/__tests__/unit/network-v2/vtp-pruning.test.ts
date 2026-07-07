import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EventBus } from '@/events/EventBus';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function trunk(sw: CiscoSwitch, port: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('switchport mode trunk');
  await sw.executeCommand('exit');
  await sw.executeCommand('end');
}

async function accessVlan(sw: CiscoSwitch, port: string, vlan: number): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`vlan ${vlan}`);
  await sw.executeCommand('exit');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('switchport mode access');
  await sw.executeCommand(`switchport access vlan ${vlan}`);
  await sw.executeCommand('exit');
  await sw.executeCommand('end');
}

async function enablePruning(sw: CiscoSwitch): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('vtp pruning');
  await sw.executeCommand('end');
}

async function defineVlan(sw: CiscoSwitch, vlan: number): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`vlan ${vlan}`);
  await sw.executeCommand('exit');
  await sw.executeCommand('end');
}

describe('VTP pruning — a chain with no downstream interest never floods past the last switch', () => {
  it('a broadcast never crosses the last trunk when nobody there wants VLAN 10', async () => {
    const bus = new EventBus();
    const sA = new CiscoSwitch('switch-cisco', 'SA', 8);
    const sB = new CiscoSwitch('switch-cisco', 'SB', 8);
    const sC = new CiscoSwitch('switch-cisco', 'SC', 8);
    const pcA = new LinuxPC('linux-pc', 'PCA');
    sA.setEventBus(bus);
    sB.setEventBus(bus);
    sC.setEventBus(bus);

    await defineVlan(sA, 10);
    await defineVlan(sB, 10);
    await defineVlan(sC, 10);
    await accessVlan(sA, 'FastEthernet0/1', 10);
    await trunk(sA, 'FastEthernet0/2');
    await trunk(sB, 'FastEthernet0/1');
    await trunk(sB, 'FastEthernet0/2');
    await trunk(sC, 'FastEthernet0/1');
    await enablePruning(sA);
    await enablePruning(sB);
    await enablePruning(sC);

    new Cable('pcA-sA').connect(pcA.getPort('eth0')!, sA.getPort('FastEthernet0/1')!);
    const trunkAB = new Cable('sA-sB');
    trunkAB.setEventBus(bus);
    trunkAB.connect(sA.getPort('FastEthernet0/2')!, sB.getPort('FastEthernet0/1')!);
    const trunkBC = new Cable('sB-sC');
    trunkBC.setEventBus(bus);
    trunkBC.connect(sB.getPort('FastEthernet0/2')!, sC.getPort('FastEthernet0/1')!);

    await pcA.executeCommand('sudo ip addr add 192.168.10.1/24 dev eth0');

    let sawOnAB = false;
    let sawOnBC = false;
    bus.subscribe('cable.frame.delivered', (e) => {
      if (e.payload.cableId === 'sA-sB') sawOnAB = true;
      if (e.payload.cableId === 'sB-sC') sawOnBC = true;
    });

    await pcA.executeCommand('ping -c 1 192.168.10.99');

    expect(sawOnAB).toBe(false);
    expect(sawOnBC).toBe(false);
  });

  it('the same broadcast reaches the far end once a host there actually wants VLAN 10', async () => {
    const bus = new EventBus();
    const sA = new CiscoSwitch('switch-cisco', 'SA', 8);
    const sB = new CiscoSwitch('switch-cisco', 'SB', 8);
    const sC = new CiscoSwitch('switch-cisco', 'SC', 8);
    const pcA = new LinuxPC('linux-pc', 'PCA');
    const pcC = new LinuxPC('linux-pc', 'PCC');
    sA.setEventBus(bus);
    sB.setEventBus(bus);
    sC.setEventBus(bus);

    await defineVlan(sA, 10);
    await defineVlan(sB, 10);
    await defineVlan(sC, 10);
    await accessVlan(sA, 'FastEthernet0/1', 10);
    await trunk(sA, 'FastEthernet0/2');
    await trunk(sB, 'FastEthernet0/1');
    await trunk(sB, 'FastEthernet0/2');
    await trunk(sC, 'FastEthernet0/1');
    await accessVlan(sC, 'FastEthernet0/2', 10);
    await enablePruning(sA);
    await enablePruning(sB);
    await enablePruning(sC);

    new Cable('pcA-sA').connect(pcA.getPort('eth0')!, sA.getPort('FastEthernet0/1')!);
    const trunkAB = new Cable('sA-sB');
    trunkAB.setEventBus(bus);
    trunkAB.connect(sA.getPort('FastEthernet0/2')!, sB.getPort('FastEthernet0/1')!);
    const trunkBC = new Cable('sB-sC');
    trunkBC.setEventBus(bus);
    trunkBC.connect(sB.getPort('FastEthernet0/2')!, sC.getPort('FastEthernet0/1')!);
    new Cable('pcC-sC').connect(pcC.getPort('eth0')!, sC.getPort('FastEthernet0/2')!);

    await pcA.executeCommand('sudo ip addr add 192.168.10.1/24 dev eth0');
    await pcC.executeCommand('sudo ip addr add 192.168.10.2/24 dev eth0');

    const ping = await pcA.executeCommand('ping -c 1 192.168.10.2');
    expect(ping).toContain('1 received');
  });
});
