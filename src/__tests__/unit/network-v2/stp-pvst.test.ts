import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

async function provision(sw: CiscoSwitch, port: string): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand('vlan 10');
  await sw.executeCommand('exit');
  await sw.executeCommand('vlan 20');
  await sw.executeCommand('exit');
  await sw.executeCommand(`interface ${port}`);
  await sw.executeCommand('switchport trunk encapsulation dot1q');
  await sw.executeCommand('switchport mode trunk');
  await sw.executeCommand('exit');
  await sw.executeCommand('end');
}

async function setVlanPriority(sw: CiscoSwitch, vlan: number, prio: number): Promise<void> {
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  await sw.executeCommand(`spanning-tree vlan ${vlan} priority ${prio}`);
  await sw.executeCommand('end');
}

describe('PVST+ — per-VLAN root election across a cabled trunk', () => {
  it('elects a different root per VLAN from real per-VLAN BPDUs', async () => {
    const bus = new EventBus();
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    sw1.setEventBus(bus);
    sw2.setEventBus(bus);

    await provision(sw1, 'FastEthernet0/1');
    await provision(sw2, 'FastEthernet0/1');

    new Cable('trunk').connect(
      sw1.getPort('FastEthernet0/1')!,
      sw2.getPort('FastEthernet0/1')!,
    );

    await setVlanPriority(sw1, 10, 4096);
    await setVlanPriority(sw2, 20, 4096);

    const a = sw1.getStpAgent();
    const b = sw2.getStpAgent();

    expect(a.getActiveStpVlans()).toEqual([1, 10, 20]);
    expect(b.getActiveStpVlans()).toEqual([1, 10, 20]);

    expect(a.isRootForVlan(10)).toBe(true);
    expect(b.isRootForVlan(10)).toBe(false);
    expect(b.getRootBridgeForVlan(10).priority).toBe(4096);
    expect(b.getRootPortForVlan(10)).toBe('FastEthernet0/1');

    expect(b.isRootForVlan(20)).toBe(true);
    expect(a.isRootForVlan(20)).toBe(false);
    expect(a.getRootBridgeForVlan(20).priority).toBe(4096);
    expect(a.getRootPortForVlan(20)).toBe('FastEthernet0/1');
  });

  it('breaks a redundant loop independently per VLAN and blocks in the data plane', async () => {
    const bus = new EventBus();
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    sw1.setEventBus(bus);
    sw2.setEventBus(bus);

    for (const sw of [sw1, sw2]) {
      for (const port of ['FastEthernet0/1', 'FastEthernet0/2']) {
        await provision(sw, port);
      }
    }
    await setVlanPriority(sw1, 1, 4096);
    await setVlanPriority(sw1, 10, 4096);

    new Cable('a').connect(sw1.getPort('FastEthernet0/1')!, sw2.getPort('FastEthernet0/1')!);
    new Cable('b').connect(sw1.getPort('FastEthernet0/2')!, sw2.getPort('FastEthernet0/2')!);

    const b = sw2.getStpAgent();
    for (const vlan of [1, 10]) {
      const roles = ['FastEthernet0/1', 'FastEthernet0/2'].map((p) => b.getPortRoleForVlan(vlan, p));
      const blocked = roles.filter((r) => r === 'alternate' || r === 'backup');
      const rootPorts = roles.filter((r) => r === 'root');
      expect(blocked.length).toBe(1);
      expect(rootPorts.length).toBe(1);
      const blockedPort = ['FastEthernet0/1', 'FastEthernet0/2']
        .find((p) => b.getPortRoleForVlan(vlan, p) === 'alternate' || b.getPortRoleForVlan(vlan, p) === 'backup')!;
      expect(sw2.getStpVlanState(blockedPort, vlan)).toBe('blocking');
    }
  });

  it('show spanning-tree vlan N renders the per-VLAN root', async () => {
    const bus = new EventBus();
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    sw1.setEventBus(bus);
    sw2.setEventBus(bus);
    await provision(sw1, 'FastEthernet0/1');
    await provision(sw2, 'FastEthernet0/1');
    new Cable('trunk').connect(
      sw1.getPort('FastEthernet0/1')!,
      sw2.getPort('FastEthernet0/1')!,
    );
    await setVlanPriority(sw1, 10, 4096);
    await setVlanPriority(sw2, 20, 4096);

    await sw1.executeCommand('enable');
    const sw1Vlan10 = await sw1.executeCommand('show spanning-tree vlan 10');
    const sw1Vlan20 = await sw1.executeCommand('show spanning-tree vlan 20');

    expect(sw1Vlan10).toContain('This bridge is the root');
    expect(sw1Vlan20).not.toContain('This bridge is the root');
    expect(sw1Vlan20).toContain('Fa0/1');
  });

  it('VLAN-tagged BPDUs reach the neighbour over the wire', async () => {
    const bus = new EventBus();
    const sw1 = new CiscoSwitch('switch-cisco', 'SW1', 4);
    const sw2 = new CiscoSwitch('switch-cisco', 'SW2', 4);
    sw1.setEventBus(bus);
    sw2.setEventBus(bus);
    await provision(sw1, 'FastEthernet0/1');
    await provision(sw2, 'FastEthernet0/1');

    const received = new Set<number>();
    bus.subscribe('stp.bpdu.received', (e) => {
      const p = e.payload as { deviceId: string; vlan?: number };
      if (p.deviceId === sw2.id && p.vlan !== undefined) received.add(p.vlan);
    });

    new Cable('trunk').connect(
      sw1.getPort('FastEthernet0/1')!,
      sw2.getPort('FastEthernet0/1')!,
    );
    await setVlanPriority(sw1, 1, 4096);
    await setVlanPriority(sw1, 10, 4096);
    await setVlanPriority(sw1, 20, 4096);

    expect(received.has(1)).toBe(true);
    expect(received.has(10)).toBe(true);
    expect(received.has(20)).toBe(true);
  });
});
