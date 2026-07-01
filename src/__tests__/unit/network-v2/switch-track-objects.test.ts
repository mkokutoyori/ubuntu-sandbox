import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('Cisco track object registry sur L3 switch', () => {
  async function build() {
    const swA = new CiscoSwitch('switch-cisco', 'SW-A', 26, 0, 0);
    const swB = new CiscoSwitch('switch-cisco', 'SW-B', 26, 0, 0);
    const uplink = new LinuxPC('stub', 'STUB', 0, 0);
    new Cable('trunk').connect(
      swA.getPort('GigabitEthernet0/1')!,
      swB.getPort('GigabitEthernet0/1')!,
    );
    new Cable('up').connect(uplink.getPorts()[0], swA.getPort('GigabitEthernet0/2')!);

    const cfgA = [
      'enable', 'configure terminal',
      'track 1 interface GigabitEthernet0/2 line-protocol',
      'vlan 10', 'exit',
      'interface GigabitEthernet0/1',
      'switchport mode trunk', 'switchport trunk allowed vlan 10', 'exit',
      'interface Vlan10',
      'ip address 10.0.10.2 255.255.255.0',
      'standby 1 ip 10.0.10.1',
      'standby 1 priority 200',
      'standby 1 preempt',
      'standby 1 track 1 decrement 80',
      'no shutdown', 'exit', 'end',
    ];
    const cfgB = [
      'enable', 'configure terminal',
      'vlan 10', 'exit',
      'interface GigabitEthernet0/1',
      'switchport mode trunk', 'switchport trunk allowed vlan 10', 'exit',
      'interface Vlan10',
      'ip address 10.0.10.3 255.255.255.0',
      'standby 1 ip 10.0.10.1',
      'standby 1 priority 150',
      'standby 1 preempt',
      'no shutdown', 'exit', 'end',
    ];
    for (const c of cfgA) await swA.executeCommand(c);
    for (const c of cfgB) await swB.executeCommand(c);
    return { swA, swB };
  }

  it('standby 1 track 1 résout via le registry vers GigabitEthernet0/2', async () => {
    const { swA } = await build();
    const g = swA.getHsrpAgent().listGroups()[0];
    expect(g.tracks).toHaveLength(1);
    expect(g.tracks[0].target).toBe('GigabitEthernet0/2');
    expect(g.tracks[0].decrement).toBe(80);
  });

  it('show track affiche l\'objet + son état Up', async () => {
    const { swA } = await build();
    const out = await swA.executeCommand('show track');
    expect(out).toMatch(/Track 1/);
    expect(out).toMatch(/Interface GigabitEthernet0\/2 line-protocol/);
    expect(out).toMatch(/line-protocol is Up/);
  });

  it('shutdown de Gi0/2 → objet Down → SW-B devient Active', async () => {
    const { swA, swB } = await build();
    for (const cmd of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/2', 'shutdown', 'end',
    ]) await swA.executeCommand(cmd);

    const out = await swA.executeCommand('show track');
    expect(out).toMatch(/line-protocol is Down/);

    expect(swA.getHsrpAgent().listGroups()[0].tracks[0].down).toBe(true);
    expect(swB.getHsrpAgent().listGroups()[0].state).toBe('active');
    expect(swA.getHsrpAgent().listGroups()[0].state).not.toBe('active');
  });

  it('running-config restitue track + standby track <id>', async () => {
    const { swA } = await build();
    const out = await swA.executeCommand('show running-config');
    expect(out).toMatch(/track 1 interface GigabitEthernet0\/2 line-protocol/);
    expect(out).toMatch(/ standby 1 track GigabitEthernet0\/2 decrement 80/);
  });
});
