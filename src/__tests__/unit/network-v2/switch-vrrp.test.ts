/**
 * VRRP redundancy on L3 switches — the SVI answers ARP for the VIP
 * with the group's virtual MAC (RFC 5798 §7.3), and CLI shape matches
 * both Cisco IOS (`vrrp <g> ip <vip>`) and Huawei VRP (`vrrp vrid <n>
 * virtual-ip <ip>`).
 *
 * Single-switch scope keeps the wire-election machinery out of the way
 * (no peer → lone speaker becomes Master), which is enough to validate:
 *  - the config surface writes through to the same VrrpAgent the
 *    routers already use,
 *  - the SVI intercept consults the agent for VIP ARP replies,
 *  - a host in the VLAN learns the virtual MAC (the whole point of
 *    FHRP: a stable gateway MAC across failovers).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

describe('Cisco L3 switch — VRRP on Vlan SVI', () => {
  async function buildLan() {
    const sw = new CiscoSwitch('switch-cisco', 'L3SW', 24, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('FastEthernet0/1')!);
    pc1.getPorts()[0].configureIP(new IPAddress('10.0.10.10'), new SubnetMask('255.255.255.0'));
    // PC1 uses the VIP as its default gateway — the whole point of VRRP.
    pc1.setDefaultGateway(new IPAddress('10.0.10.1'));

    for (const cmd of [
      'enable', 'configure terminal',
      'vlan 10', 'exit',
      'interface FastEthernet0/1',
      'switchport mode access', 'switchport access vlan 10', 'exit',
      'interface Vlan10',
      'ip address 10.0.10.2 255.255.255.0',
      'vrrp 1 ip 10.0.10.1',
      'vrrp 1 priority 150',
      'vrrp 1 preempt',
      'no shutdown', 'exit', 'end',
    ]) await sw.executeCommand(cmd);

    return { sw, pc1 };
  }

  it('vrrp 1 ip <vip> enregistre le groupe sur l\'agent', async () => {
    const { sw } = await buildLan();
    const groups = sw.getVrrpAgent().listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].vrid).toBe(1);
    expect(groups[0].vip).toBe('10.0.10.1');
    expect(groups[0].priority).toBe(150);
    expect(groups[0].preempt).toBe(true);
  });

  it('lone speaker → l\'agent bascule l\'état à Master', async () => {
    const { sw } = await buildLan();
    const groups = sw.getVrrpAgent().listGroups();
    expect(groups[0].state).toBe('master');
  });

  it('show vrrp affiche l\'état Master + le virtual IP/MAC', async () => {
    const { sw } = await buildLan();
    const out = await sw.executeCommand('show vrrp');
    expect(out).toMatch(/Vlan10 - Group 1/);
    expect(out).toMatch(/State is Master/);
    expect(out).toMatch(/Virtual IP address is 10\.0\.10\.1/);
    expect(out).toMatch(/Virtual MAC address is 00:00:5e:00:01:01/);
    expect(out).toMatch(/Priority is 150/);
    expect(out).toMatch(/Preemption is enabled/);
  });

  it('PC1 ping VIP : l\'ARP retourne le virtual MAC (pas la bridge MAC)', async () => {
    const { sw, pc1 } = await buildLan();
    await pc1.executeCommand('ping -c 1 10.0.10.1');
    const arpOut = await pc1.executeCommand('arp -n');
    // PC's ARP cache learned the VIP → virtual MAC (00:00:5e:00:01:01),
    // not the switch's bridge MAC.
    expect(arpOut).toMatch(/10\.0\.10\.1\s+.*00:00:5e:00:01:01/);
    expect(sw.getBridgeMac().toString().toLowerCase())
      .not.toBe('00:00:5e:00:01:01');
  });
});

describe('Huawei L3 switch — VRRP on Vlanif SVI', () => {
  async function buildLan() {
    const sw = new HuaweiSwitch('switch-huawei', 'L3SW', 8, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);
    new Cable('c1').connect(pc1.getPorts()[0], sw.getPort('GigabitEthernet0/0/1')!);
    pc1.getPorts()[0].configureIP(new IPAddress('10.0.10.10'), new SubnetMask('255.255.255.0'));
    pc1.setDefaultGateway(new IPAddress('10.0.10.1'));

    for (const cmd of [
      'system-view',
      'vlan batch 10',
      'interface GigabitEthernet0/0/1',
      'port link-type access', 'port default vlan 10', 'quit',
      'interface Vlanif10',
      'ip address 10.0.10.2 255.255.255.0', 'undo shutdown',
      'vrrp vrid 1 virtual-ip 10.0.10.1',
      'vrrp vrid 1 priority 150',
      'vrrp vrid 1 preempt-mode',
      'quit', 'quit',
    ]) await sw.executeCommand(cmd);

    return { sw, pc1 };
  }

  it('vrrp vrid <n> virtual-ip enregistre le groupe (VIP + priorité)', async () => {
    const { sw } = await buildLan();
    const groups = sw.getVrrpAgent().listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].vip).toBe('10.0.10.1');
    expect(groups[0].priority).toBe(150);
    expect(groups[0].preempt).toBe(true);
  });

  it('display vrrp montre le groupe Master + Virtual IP/MAC', async () => {
    const { sw } = await buildLan();
    const out = await sw.executeCommand('display vrrp');
    expect(out).toMatch(/Vlanif10 \| Virtual Router 1/);
    expect(out).toMatch(/State : Master/);
    expect(out).toMatch(/Virtual IP : 10\.0\.10\.1/);
    expect(out).toMatch(/Virtual MAC : 00:00:5e:00:01:01/);
  });

  it('PC1 ping VIP : le cache ARP porte le virtual MAC', async () => {
    const { pc1 } = await buildLan();
    await pc1.executeCommand('ping -c 1 10.0.10.1');
    const arpOut = await pc1.executeCommand('arp -n');
    expect(arpOut).toMatch(/10\.0\.10\.1\s+.*00:00:5e:00:01:01/);
  });
});

describe('L3 switches paire — VRRP failover Master/Backup', () => {
  /**
   * Two Huawei L3 switches on the same VLAN, VRRP group 1 shared. The
   * higher-priority switch owns the VIP as Master; the peer stays
   * Backup and only takes over when the Master's SVI goes down.
   * A PC in the VLAN uses the VIP as its gateway — its ARP entry for
   * the VIP is the virtual MAC and survives the failover.
   */
  async function buildRedundantLan() {
    const swA = new HuaweiSwitch('switch-huawei', 'SW-A', 8, 0, 0);
    const swB = new HuaweiSwitch('switch-huawei', 'SW-B', 8, 0, 0);
    const pc1 = new LinuxPC('pc1', 'PC1', 0, 0);

    // Trunk between the two switches carries VLAN 10; PC1 sits on
    // SW-A's access port.
    new Cable('trunk').connect(
      swA.getPort('GigabitEthernet0/0/2')!,
      swB.getPort('GigabitEthernet0/0/2')!,
    );
    new Cable('c1').connect(pc1.getPorts()[0], swA.getPort('GigabitEthernet0/0/1')!);
    pc1.getPorts()[0].configureIP(new IPAddress('10.0.10.10'), new SubnetMask('255.255.255.0'));
    pc1.setDefaultGateway(new IPAddress('10.0.10.1'));

    const cfg = (sw: HuaweiSwitch, ip: string, prio: number) => [
      'system-view',
      'vlan batch 10',
      'interface GigabitEthernet0/0/1',
      'port link-type access', 'port default vlan 10', 'quit',
      'interface GigabitEthernet0/0/2',
      'port link-type trunk', 'port trunk allow-pass vlan 10', 'quit',
      'interface Vlanif10',
      `ip address ${ip} 255.255.255.0`, 'undo shutdown',
      'vrrp vrid 1 virtual-ip 10.0.10.1',
      `vrrp vrid 1 priority ${prio}`,
      'vrrp vrid 1 preempt-mode',
      'quit', 'quit',
    ];
    for (const cmd of cfg(swA, '10.0.10.2', 200)) await swA.executeCommand(cmd);
    for (const cmd of cfg(swB, '10.0.10.3', 100)) await swB.executeCommand(cmd);
    return { swA, swB, pc1 };
  }

  it('SW-A (priority 200) reste Master ; SW-B (priority 100) passe Backup', async () => {
    const { swA, swB } = await buildRedundantLan();
    const a = swA.getVrrpAgent().listGroups()[0];
    const b = swB.getVrrpAgent().listGroups()[0];
    expect(a.state).toBe('master');
    expect(b.state).toBe('backup');
  });

  it('display vrrp diverge côté Master et Backup', async () => {
    const { swA, swB } = await buildRedundantLan();
    const outA = await swA.executeCommand('display vrrp');
    const outB = await swB.executeCommand('display vrrp');
    expect(outA).toMatch(/State : Master/);
    expect(outB).toMatch(/State : Backup/);
  });

  it('failover : shutdown Vlanif10 sur le Master → SW-B devient Master', async () => {
    const { swA, swB } = await buildRedundantLan();
    for (const cmd of [
      'system-view', 'interface Vlanif10', 'shutdown', 'quit', 'quit',
    ]) await swA.executeCommand(cmd);
    // SW-A's group returns to Init (its Vlanif is down).
    expect(swA.getVrrpAgent().listGroups()[0].state).toBe('init');
    // SW-B stops hearing Master hellos → after the master-down
    // interval (3 × advert + skew ≈ 3.6s at priority 100), it
    // elects itself. Fast-forward the clock past that window and
    // drive the expiry sweep.
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now + 5_000);
    (swB.getVrrpAgent() as unknown as { expireDue(): void }).expireDue();
    expect(swB.getVrrpAgent().listGroups()[0].state).toBe('master');
    vi.useRealTimers();
  });
});
