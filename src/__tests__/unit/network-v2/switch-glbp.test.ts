import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

describe('Cisco L3 switch — GLBP on Vlan SVI', () => {
  async function buildLan() {
    const sw = new CiscoSwitch('switch-cisco', 'L3SW', 24, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('FastEthernet0/1')!);
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
      'glbp 1 load-balancing round-robin',
      'no shutdown', 'exit', 'end',
    ]) await sw.executeCommand(cmd);

    return { sw, pc1 };
  }

  it('glbp 1 ip <vip> enregistre le groupe + weighting + load-balancing', async () => {
    const { sw } = await buildLan();
    const groups = sw.getGlbpAgent().listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].vip).toBe('10.0.10.1');
    expect(groups[0].priority).toBe(200);
    expect(groups[0].preempt).toBe(true);
    expect(groups[0].weighting).toBe(150);
    expect(groups[0].loadBalancing).toBe('round-robin');
  });

  it('lone speaker → l\'état avgState bascule à Active', async () => {
    const { sw } = await buildLan();
    expect(sw.getGlbpAgent().listGroups()[0].avgState).toBe('active');
  });

  it('show glbp affiche Active + VIP + priority + load-balancing', async () => {
    const { sw } = await buildLan();
    const out = await sw.executeCommand('show glbp');
    expect(out).toMatch(/Vlan10 - Group 1/);
    expect(out).toMatch(/State is Active/);
    expect(out).toMatch(/Virtual IP address is 10\.0\.10\.1/);
    expect(out).toMatch(/Priority 200/);
    expect(out).toMatch(/Weighting 150/);
    expect(out).toMatch(/Load-balancing round-robin/);
    expect(out).toMatch(/Preemption enabled/);
  });

  it('PC1 ping VIP : reçoit un virtual MAC GLBP (AVF)', async () => {
    const { pc1 } = await buildLan();
    await pc1.executeCommand('ping -c 1 10.0.10.1');
    const arp = await pc1.executeCommand('arp -n');
    expect(arp).toMatch(/10\.0\.10\.1\s+.*00:07:b4:00:01:01/);
  });
});

describe('Cisco L3 switches paire — GLBP AVG election', () => {
  async function buildPair() {
    const swA = new CiscoSwitch('switch-cisco', 'SW-A', 26, 0, 0);
    const swB = new CiscoSwitch('switch-cisco', 'SW-B', 26, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    new Cable('trunk').connect(
      swA.getPort('GigabitEthernet0/1')!,
      swB.getPort('GigabitEthernet0/1')!,
    );
    new Cable('c1').connect(pc1.getPorts()[0], swA.getPort('FastEthernet0/1')!);
    pc1.getPorts()[0].configureIP(new IPAddress('10.0.10.10'), new SubnetMask('255.255.255.0'));
    pc1.setDefaultGateway(new IPAddress('10.0.10.1'));

    const cfg = (ip: string, prio: number) => [
      'enable', 'configure terminal',
      'vlan 10', 'exit',
      'interface FastEthernet0/1',
      'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface GigabitEthernet0/1',
      'switchport mode trunk', 'switchport trunk allowed vlan 10', 'exit',
      'interface Vlan10',
      `ip address ${ip} 255.255.255.0`,
      'glbp 1 ip 10.0.10.1',
      `glbp 1 priority ${prio}`,
      'glbp 1 preempt',
      'no shutdown', 'exit', 'end',
    ];
    for (const cmd of cfg('10.0.10.2', 200)) await swA.executeCommand(cmd);
    for (const cmd of cfg('10.0.10.3', 100)) await swB.executeCommand(cmd);
    return { swA, swB, pc1 };
  }

  it('SW-A (priority 200) devient AVG Active ; SW-B (priority 100) passe Standby', async () => {
    const { swA, swB } = await buildPair();
    expect(swA.getGlbpAgent().listGroups()[0].avgState).toBe('active');
    expect(swB.getGlbpAgent().listGroups()[0].avgState).toBe('standby');
  });

  it('show glbp diverge côté Active et Standby', async () => {
    const { swA, swB } = await buildPair();
    const outA = await swA.executeCommand('show glbp');
    const outB = await swB.executeCommand('show glbp');
    expect(outA).toMatch(/State is Active/);
    expect(outB).toMatch(/State is Standby/);
  });
});
