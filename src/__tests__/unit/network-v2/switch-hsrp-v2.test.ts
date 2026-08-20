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

describe('HSRPv2 on Cisco L3 switch — standby version 2 sur SVI', () => {
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
      'standby version 2',
      'standby 300 ip 10.0.10.1',
      `standby 300 priority ${prio}`,
      'standby 300 preempt',
      'no shutdown', 'exit', 'end',
    ];
    for (const c of cfg('10.0.10.2', 200)) await swA.executeCommand(c);
    for (const c of cfg('10.0.10.3', 100)) await swB.executeCommand(c);
    return { swA, swB, pc1 };
  }

  it('groupe 300 (au-delà du max v1) accepté ; version = 2 enregistrée', async () => {
    const { swA } = await buildPair();
    const g = swA.getHsrpAgent().listGroups()[0];
    expect(g.group).toBe(300);
    expect(g.version).toBe(2);
  });

  it('SW-A active ; SW-B standby via annonces multicast 224.0.0.102', async () => {
    const { swA, swB } = await buildPair();
    expect(swA.getHsrpAgent().listGroups()[0].state).toBe('active');
    expect(swB.getHsrpAgent().listGroups()[0].state).toBe('standby');
  });

  it('virtual MAC v2 : 0000.0c9f.f<group hex>', async () => {
    const { swA } = await buildPair();
    const out = await swA.executeCommand('show standby');
    expect(out).toMatch(/Virtual MAC address is 0000\.0c9f\.f12c/);
    expect(out).toMatch(/\(v2 default\)/);
  });

  it('PC1 ping VIP : ARP cache stocke la vMAC v2', async () => {
    const { pc1 } = await buildPair();
    await pc1.executeCommand('ping -c 1 10.0.10.1');
    const arp = await pc1.executeCommand('arp -n');
    expect(arp).toMatch(/10\.0\.10\.1\s+.*00:00:0c:9f:f1:2c/);
  });
});
