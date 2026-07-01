import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
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

describe('HSRP on SVI — interface tracking failover', () => {
  async function buildPair() {
    const swA = new CiscoSwitch('switch-cisco', 'SW-A', 26, 0, 0);
    const swB = new CiscoSwitch('switch-cisco', 'SW-B', 26, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    const uplink = new LinuxPC('stub', 'STUB', 0, 0);
    new Cable('trunk').connect(
      swA.getPort('GigabitEthernet0/1')!,
      swB.getPort('GigabitEthernet0/1')!,
    );
    new Cable('c1').connect(pc1.getPorts()[0], swA.getPort('FastEthernet0/1')!);
    new Cable('up').connect(uplink.getPorts()[0], swA.getPort('GigabitEthernet0/2')!);
    pc1.getPorts()[0].configureIP(new IPAddress('10.0.10.10'), new SubnetMask('255.255.255.0'));
    pc1.setDefaultGateway(new IPAddress('10.0.10.1'));

    const cfgA = [
      'enable', 'configure terminal',
      'vlan 10', 'exit',
      'interface FastEthernet0/1',
      'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface GigabitEthernet0/1',
      'switchport mode trunk', 'switchport trunk allowed vlan 10', 'exit',
      'interface Vlan10',
      'ip address 10.0.10.2 255.255.255.0',
      'standby 1 ip 10.0.10.1',
      'standby 1 priority 200',
      'standby 1 preempt',
      'standby 1 track GigabitEthernet0/2 decrement 60',
      'no shutdown', 'exit', 'end',
    ];
    const cfgB = [
      'enable', 'configure terminal',
      'vlan 10', 'exit',
      'interface FastEthernet0/1',
      'switchport mode access', 'switchport access vlan 10', 'exit',
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
    return { swA, swB, pc1, uplink };
  }

  it('SW-A avec track Up conserve priority 200 et reste Active', async () => {
    const { swA, swB } = await buildPair();
    const gA = swA.getHsrpAgent().listGroups()[0];
    expect(gA.state).toBe('active');
    expect(gA.tracks).toHaveLength(1);
    expect(gA.tracks[0].target).toBe('GigabitEthernet0/2');
    expect(gA.tracks[0].down).toBe(false);
    expect(swB.getHsrpAgent().listGroups()[0].state).toBe('standby');
  });

  it('show standby liste le track et la priorité configurée', async () => {
    const { swA } = await buildPair();
    const out = await swA.executeCommand('show standby');
    expect(out).toMatch(/Vlan10 - Group 1/);
    expect(out).toMatch(/State is Active/);
    expect(out).toMatch(/Priority 200/);
    expect(out).toMatch(/Tracking 1 object\(s\)/);
    expect(out).toMatch(/GigabitEthernet0\/2 Up decrement 60/);
  });

  it('shutdown Gi0/2 sur SW-A → track Down → SW-B préempt et devient Active', async () => {
    const { swA, swB } = await buildPair();
    for (const cmd of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/2', 'shutdown', 'end',
    ]) await swA.executeCommand(cmd);

    const gA = swA.getHsrpAgent().listGroups()[0];
    expect(gA.tracks[0].down).toBe(true);

    expect(swB.getHsrpAgent().listGroups()[0].state).toBe('active');
    expect(swA.getHsrpAgent().listGroups()[0].state).not.toBe('active');
  });

  it('show standby après track Down affiche la priorité effective', async () => {
    const { swA } = await buildPair();
    for (const cmd of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/2', 'shutdown', 'end',
    ]) await swA.executeCommand(cmd);
    const out = await swA.executeCommand('show standby');
    expect(out).toMatch(/Priority 140 \(configured 200\)/);
    expect(out).toMatch(/GigabitEthernet0\/2 Down decrement 60/);
  });
});

describe('GLBP on SVI — interface tracking weighting', () => {
  async function buildLan() {
    const sw = new CiscoSwitch('switch-cisco', 'L3SW', 26, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    const uplink = new LinuxPC('stub', 'STUB', 0, 0);
    new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('FastEthernet0/1')!);
    new Cable('up').connect(uplink.getPorts()[0], sw.getPort('GigabitEthernet0/2')!);
    pc1.getPorts()[0].configureIP(new IPAddress('10.0.10.10'), new SubnetMask('255.255.255.0'));
    pc1.setDefaultGateway(new IPAddress('10.0.10.1'));

    for (const cmd of [
      'enable', 'configure terminal',
      'vlan 10', 'exit',
      'interface FastEthernet0/1',
      'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface Vlan10',
      'ip address 10.0.10.2 255.255.255.0',
      'glbp 1 ip 10.0.10.1',
      'glbp 1 priority 200',
      'glbp 1 preempt',
      'glbp 1 weighting 150',
      'glbp 1 weighting track GigabitEthernet0/2 decrement 50',
      'no shutdown', 'exit', 'end',
    ]) await sw.executeCommand(cmd);
    return { sw };
  }

  it('track enregistré, weighting configuré conservé quand la piste est Up', async () => {
    const { sw } = await buildLan();
    const g = sw.getGlbpAgent().listGroups()[0];
    expect(g.tracks).toHaveLength(1);
    expect(g.tracks[0].down).toBe(false);
    const out = await sw.executeCommand('show glbp');
    expect(out).toMatch(/Weighting 150/);
    expect(out).toMatch(/GigabitEthernet0\/2 Up decrement 50/);
  });

  it('shutdown de la piste → weighting effectif tombe à 100', async () => {
    const { sw } = await buildLan();
    for (const cmd of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/2', 'shutdown', 'end',
    ]) await sw.executeCommand(cmd);
    const g = sw.getGlbpAgent().listGroups()[0];
    expect(g.tracks[0].down).toBe(true);
    const out = await sw.executeCommand('show glbp');
    expect(out).toMatch(/Weighting 100 \(configured 150\)/);
    expect(out).toMatch(/GigabitEthernet0\/2 Down decrement 50/);
  });
});

describe('VRRP Cisco IOS — vrrp <g> track sur SVI', () => {
  async function buildPair() {
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
      'vlan 10', 'exit',
      'interface GigabitEthernet0/1',
      'switchport mode trunk', 'switchport trunk allowed vlan 10', 'exit',
      'interface Vlan10',
      'ip address 10.0.10.2 255.255.255.0',
      'vrrp 1 ip 10.0.10.1',
      'vrrp 1 priority 200',
      'vrrp 1 preempt',
      'vrrp 1 track GigabitEthernet0/2 decrement 80',
      'no shutdown', 'exit', 'end',
    ];
    const cfgB = [
      'enable', 'configure terminal',
      'vlan 10', 'exit',
      'interface GigabitEthernet0/1',
      'switchport mode trunk', 'switchport trunk allowed vlan 10', 'exit',
      'interface Vlan10',
      'ip address 10.0.10.3 255.255.255.0',
      'vrrp 1 ip 10.0.10.1',
      'vrrp 1 priority 150',
      'vrrp 1 preempt',
      'no shutdown', 'exit', 'end',
    ];
    for (const c of cfgA) await swA.executeCommand(c);
    for (const c of cfgB) await swB.executeCommand(c);
    return { swA, swB };
  }

  it('track enregistré, SW-A reste Master avec la piste Up', async () => {
    const { swA, swB } = await buildPair();
    const gA = swA.getVrrpAgent().listGroups()[0];
    expect(gA.state).toBe('master');
    expect(gA.tracks).toHaveLength(1);
    expect(gA.tracks[0].target).toBe('GigabitEthernet0/2');
    expect(gA.tracks[0].down).toBe(false);
    expect(swB.getVrrpAgent().listGroups()[0].state).toBe('backup');
  });

  it('shutdown Gi0/2 sur SW-A → 200-80=120 < 150 → SW-B préempt Master', async () => {
    const { swA, swB } = await buildPair();
    for (const cmd of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/2', 'shutdown', 'end',
    ]) await swA.executeCommand(cmd);
    expect(swA.getVrrpAgent().listGroups()[0].tracks[0].down).toBe(true);
    expect(swB.getVrrpAgent().listGroups()[0].state).toBe('master');
    expect(swA.getVrrpAgent().listGroups()[0].state).not.toBe('master');
  });

  it('show vrrp affiche la priorité effective + tracks', async () => {
    const { swA } = await buildPair();
    for (const cmd of [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/2', 'shutdown', 'end',
    ]) await swA.executeCommand(cmd);
    const out = await swA.executeCommand('show vrrp');
    expect(out).toMatch(/Priority is 120 \(configured 200\)/);
    expect(out).toMatch(/GigabitEthernet0\/2 Down decrement 80/);
  });
});

describe('VRRP Huawei VRP — vrrp vrid <n> track interface sur Vlanif', () => {
  async function buildPair() {
    const swA = new HuaweiSwitch('switch-huawei', 'SW-A', 8, 0, 0);
    const swB = new HuaweiSwitch('switch-huawei', 'SW-B', 8, 0, 0);
    const uplink = new LinuxPC('stub', 'STUB', 0, 0);
    new Cable('trunk').connect(
      swA.getPort('GigabitEthernet0/0/2')!,
      swB.getPort('GigabitEthernet0/0/2')!,
    );
    new Cable('up').connect(uplink.getPorts()[0], swA.getPort('GigabitEthernet0/0/3')!);

    const cfgA = [
      'system-view',
      'vlan batch 10',
      'interface GigabitEthernet0/0/2',
      'port link-type trunk', 'port trunk allow-pass vlan 10', 'quit',
      'interface Vlanif10',
      'ip address 10.0.10.2 255.255.255.0', 'undo shutdown',
      'vrrp vrid 1 virtual-ip 10.0.10.1',
      'vrrp vrid 1 priority 200',
      'vrrp vrid 1 preempt-mode',
      'vrrp vrid 1 track interface GigabitEthernet0/0/3 reduced 80',
      'quit', 'quit',
    ];
    const cfgB = [
      'system-view',
      'vlan batch 10',
      'interface GigabitEthernet0/0/2',
      'port link-type trunk', 'port trunk allow-pass vlan 10', 'quit',
      'interface Vlanif10',
      'ip address 10.0.10.3 255.255.255.0', 'undo shutdown',
      'vrrp vrid 1 virtual-ip 10.0.10.1',
      'vrrp vrid 1 priority 150',
      'vrrp vrid 1 preempt-mode',
      'quit', 'quit',
    ];
    for (const c of cfgA) await swA.executeCommand(c);
    for (const c of cfgB) await swB.executeCommand(c);
    return { swA, swB };
  }

  it('track interface enregistré + SW-A Master, SW-B Backup', async () => {
    const { swA, swB } = await buildPair();
    const gA = swA.getVrrpAgent().listGroups()[0];
    expect(gA.state).toBe('master');
    expect(gA.tracks).toHaveLength(1);
    expect(gA.tracks[0].target).toBe('GigabitEthernet0/0/3');
    expect(gA.tracks[0].decrement).toBe(80);
    expect(swB.getVrrpAgent().listGroups()[0].state).toBe('backup');
  });

  it('shutdown de la piste → SW-B devient Master via annonce sur trunk', async () => {
    const { swA, swB } = await buildPair();
    for (const cmd of [
      'system-view', 'interface GigabitEthernet0/0/3', 'shutdown', 'quit', 'quit',
    ]) await swA.executeCommand(cmd);
    expect(swA.getVrrpAgent().listGroups()[0].tracks[0].down).toBe(true);
    expect(swB.getVrrpAgent().listGroups()[0].state).toBe('master');
  });

  it('display vrrp montre PriorityRun/PriorityConfig + Track IF', async () => {
    const { swA } = await buildPair();
    for (const cmd of [
      'system-view', 'interface GigabitEthernet0/0/3', 'shutdown', 'quit', 'quit',
    ]) await swA.executeCommand(cmd);
    const out = await swA.executeCommand('display vrrp');
    expect(out).toMatch(/PriorityRun : 120/);
    expect(out).toMatch(/PriorityConfig : 200/);
    expect(out).toMatch(/Track IF : 1/);
    expect(out).toMatch(/GigabitEthernet0\/0\/3 Priority reduced : 80 State : Down/);
  });
});
