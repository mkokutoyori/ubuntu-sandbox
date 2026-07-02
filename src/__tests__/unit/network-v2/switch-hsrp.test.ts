import { describe, it, expect, beforeEach, vi } from 'vitest';
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

describe('Cisco L3 switch — HSRP on Vlan SVI', () => {
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
      'standby 1 ip 10.0.10.1',
      'standby 1 priority 150',
      'standby 1 preempt',
      'no shutdown', 'exit', 'end',
    ]) await sw.executeCommand(cmd);

    return { sw, pc1 };
  }

  it('standby 1 ip <vip> enregistre le groupe dans l\'agent', async () => {
    const { sw } = await buildLan();
    const groups = sw.getHsrpAgent().listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].group).toBe(1);
    expect(groups[0].vip).toBe('10.0.10.1');
    expect(groups[0].priority).toBe(150);
    expect(groups[0].preempt).toBe(true);
  });

  it('lone speaker → l\'état bascule à Active', async () => {
    const { sw } = await buildLan();
    expect(sw.getHsrpAgent().listGroups()[0].state).toBe('active');
  });

  it('show standby affiche Active + Virtual IP et Virtual MAC', async () => {
    const { sw } = await buildLan();
    const out = await sw.executeCommand('show standby');
    expect(out).toMatch(/Vlan10 - Group 1/);
    expect(out).toMatch(/State is Active/);
    expect(out).toMatch(/Virtual IP address is 10\.0\.10\.1/);
    expect(out).toMatch(/Virtual MAC address is 0000\.0c07\.ac01/);
    expect(out).toMatch(/Priority 150/);
    expect(out).toMatch(/Preemption enabled/);
  });

  it('PC1 ping VIP : ARP retourne le virtual MAC HSRP', async () => {
    const { sw, pc1 } = await buildLan();
    await pc1.executeCommand('ping -c 1 10.0.10.1');
    const arp = await pc1.executeCommand('arp -n');
    expect(arp).toMatch(/10\.0\.10\.1\s+.*00:00:0c:07:ac:01/);
    expect(sw.getBridgeMac().toString().toLowerCase())
      .not.toBe('00:00:0c:07:ac:01');
  });
});

describe('Cisco L3 switches paire — HSRP failover Active/Standby', () => {
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
      'standby 1 ip 10.0.10.1',
      `standby 1 priority ${prio}`,
      'standby 1 preempt',
      'no shutdown', 'exit', 'end',
    ];
    for (const cmd of cfg('10.0.10.2', 200)) await swA.executeCommand(cmd);
    for (const cmd of cfg('10.0.10.3', 100)) await swB.executeCommand(cmd);
    return { swA, swB, pc1 };
  }

  it('SW-A (priority 200) reste Active ; SW-B (priority 100) passe Standby', async () => {
    const { swA, swB } = await buildPair();
    expect(swA.getHsrpAgent().listGroups()[0].state).toBe('active');
    expect(swB.getHsrpAgent().listGroups()[0].state).toBe('standby');
  });

  it('failover : shutdown Vlan10 sur SW-A → SW-B devient Active', async () => {
    const { swA, swB } = await buildPair();
    for (const cmd of [
      'enable', 'configure terminal', 'interface Vlan10', 'shutdown', 'end',
    ]) await swA.executeCommand(cmd);
    expect(swA.getHsrpAgent().listGroups()[0].state).toBe('init');

    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now + 15_000);
    (swB.getHsrpAgent() as unknown as { expireDue(): void }).expireDue();
    expect(swB.getHsrpAgent().listGroups()[0].state).toBe('active');
    vi.useRealTimers();
  });
});
