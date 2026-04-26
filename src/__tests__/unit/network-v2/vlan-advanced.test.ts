/**
 * Advanced VLAN Tests — Cisco & Huawei
 *
 * Tests cover:
 *   V-C-01: Cisco trunk allowed-VLAN subcommands (add/remove/except/all/none)
 *   V-C-02: Cisco trunk VLAN filtering at frame level (egress & ingress)
 *   V-C-03: Cisco multi-switch trunk with VLAN restrictions
 *   V-H-01: Huawei port trunk allow-pass vlan additive semantics
 *   V-H-02: Huawei undo port trunk allow-pass vlan
 *   V-H-03: Huawei port trunk allow-pass vlan all / none
 *   V-H-04: Huawei trunk VLAN filtering at frame level
 *   V-H-05: Huawei undo port default vlan / undo port trunk pvid vlan
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
});

// ═══════════════════════════════════════════════════════════════════
// V-C-01: Cisco trunk allowed-VLAN subcommands
// ═══════════════════════════════════════════════════════════════════

describe('V-C-01: Cisco switchport trunk allowed vlan subcommands', () => {

  it('add: appends VLANs to the existing allowed list', async () => {
    const sw = new CiscoSwitch('sw1', 'SW1', 8);

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('switchport mode trunk');
    // Start with a restricted list
    await sw.executeCommand('switchport trunk allowed vlan 10,20');
    // Add one more
    await sw.executeCommand('switchport trunk allowed vlan add 30');
    await sw.executeCommand('end');

    const cfg = sw.getSwitchportConfig('FastEthernet0/0');
    expect(cfg?.trunkAllowedVlans.has(10)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(20)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(30)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(40)).toBe(false);
  });

  it('remove: removes VLANs from the allowed list', async () => {
    const sw = new CiscoSwitch('sw1', 'SW1', 8);

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan 10,20,30,40');
    await sw.executeCommand('switchport trunk allowed vlan remove 20,40');
    await sw.executeCommand('end');

    const cfg = sw.getSwitchportConfig('FastEthernet0/0');
    expect(cfg?.trunkAllowedVlans.has(10)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(20)).toBe(false);
    expect(cfg?.trunkAllowedVlans.has(30)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(40)).toBe(false);
  });

  it('except: allows all VLANs except the specified ones', async () => {
    const sw = new CiscoSwitch('sw1', 'SW1', 8);

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan except 100,200');
    await sw.executeCommand('end');

    const cfg = sw.getSwitchportConfig('FastEthernet0/0');
    expect(cfg?.trunkAllowedVlans.has(1)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(10)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(100)).toBe(false);
    expect(cfg?.trunkAllowedVlans.has(200)).toBe(false);
    expect(cfg?.trunkAllowedVlans.has(300)).toBe(true);
  });

  it('none: removes all VLANs from the allowed list', async () => {
    const sw = new CiscoSwitch('sw1', 'SW1', 8);

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan none');
    await sw.executeCommand('end');

    const cfg = sw.getSwitchportConfig('FastEthernet0/0');
    expect(cfg?.trunkAllowedVlans.size).toBe(0);
  });

  it('all: restores all VLANs 1-4094 to the allowed list', async () => {
    const sw = new CiscoSwitch('sw1', 'SW1', 8);

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('switchport mode trunk');
    // First restrict
    await sw.executeCommand('switchport trunk allowed vlan 10');
    // Then restore all
    await sw.executeCommand('switchport trunk allowed vlan all');
    await sw.executeCommand('end');

    const cfg = sw.getSwitchportConfig('FastEthernet0/0');
    expect(cfg?.trunkAllowedVlans.size).toBe(4094);
    expect(cfg?.trunkAllowedVlans.has(1)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(4094)).toBe(true);
  });

  it('add range: adds a range of VLANs', async () => {
    const sw = new CiscoSwitch('sw1', 'SW1', 8);

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan none');
    await sw.executeCommand('switchport trunk allowed vlan add 10-15');
    await sw.executeCommand('end');

    const cfg = sw.getSwitchportConfig('FastEthernet0/0');
    for (let v = 10; v <= 15; v++) {
      expect(cfg?.trunkAllowedVlans.has(v)).toBe(true);
    }
    expect(cfg?.trunkAllowedVlans.has(9)).toBe(false);
    expect(cfg?.trunkAllowedVlans.has(16)).toBe(false);
  });

  it('shows allowed VLANs in running-config', async () => {
    const sw = new CiscoSwitch('sw1', 'SW1', 8);

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk allowed vlan 10,20,30');
    await sw.executeCommand('end');

    const config = await sw.executeCommand('show running-config');
    expect(config).toContain('switchport trunk allowed vlan');
  });
});

// ═══════════════════════════════════════════════════════════════════
// V-C-02: Cisco trunk VLAN filtering at frame level
// ═══════════════════════════════════════════════════════════════════

describe('V-C-02: Cisco trunk VLAN filtering — frame level', () => {

  it('frames with allowed VLAN pass through trunk', async () => {
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');
    const sw = new CiscoSwitch('sw1', 'SW1', 8);

    new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('interface FastEthernet0/1');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('end');

    await pc1.executeCommand('ifconfig eth0 192.168.10.1');
    await pc2.executeCommand('ifconfig eth0 192.168.10.2');

    const result = await pc1.executeCommand('ping -c 1 192.168.10.2');
    expect(result).toContain('1 received');
  });

  it('trunk egress blocks VLAN not in allowed list (unicast)', async () => {
    // Setup: PC-A on SW1 VLAN 10, PC-B on SW2 VLAN 10
    // SW1↔SW2 trunk only allows VLAN 20 — VLAN 10 is blocked
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');
    const sw1 = new CiscoSwitch('sw1', 'SW1', 8);
    const sw2 = new CiscoSwitch('sw2', 'SW2', 8);

    new Cable('pc1-sw1').connect(pc1.getPort('eth0')!, sw1.getPort('FastEthernet0/0')!);
    new Cable('sw1-sw2').connect(sw1.getPort('FastEthernet0/7')!, sw2.getPort('FastEthernet0/7')!);
    new Cable('sw2-pc2').connect(sw2.getPort('FastEthernet0/0')!, pc2.getPort('eth0')!);

    // Configure SW1
    await sw1.executeCommand('enable');
    await sw1.executeCommand('configure terminal');
    await sw1.executeCommand('interface FastEthernet0/0');
    await sw1.executeCommand('switchport access vlan 10');
    await sw1.executeCommand('interface FastEthernet0/7');
    await sw1.executeCommand('switchport mode trunk');
    // Allow only VLAN 20 on the trunk — blocks VLAN 10
    await sw1.executeCommand('switchport trunk allowed vlan 20');
    await sw1.executeCommand('end');

    // Configure SW2
    await sw2.executeCommand('enable');
    await sw2.executeCommand('configure terminal');
    await sw2.executeCommand('interface FastEthernet0/7');
    await sw2.executeCommand('switchport mode trunk');
    await sw2.executeCommand('switchport trunk allowed vlan 20');
    await sw2.executeCommand('interface FastEthernet0/0');
    await sw2.executeCommand('switchport access vlan 10');
    await sw2.executeCommand('end');

    await pc1.executeCommand('ifconfig eth0 192.168.10.1');
    await pc2.executeCommand('ifconfig eth0 192.168.10.2');

    // VLAN 10 should NOT pass through the trunk (only VLAN 20 is allowed)
    const result = await pc1.executeCommand('ping -c 1 192.168.10.2');
    expect(result).toContain('100% packet loss');
  });

  it('trunk allows VLAN after adding it with add subcommand', async () => {
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');
    const sw1 = new CiscoSwitch('sw1', 'SW1', 8);
    const sw2 = new CiscoSwitch('sw2', 'SW2', 8);

    new Cable('pc1-sw1').connect(pc1.getPort('eth0')!, sw1.getPort('FastEthernet0/0')!);
    new Cable('sw1-sw2').connect(sw1.getPort('FastEthernet0/7')!, sw2.getPort('FastEthernet0/7')!);
    new Cable('sw2-pc2').connect(sw2.getPort('FastEthernet0/0')!, pc2.getPort('eth0')!);

    // Configure both switches: trunk only allows VLAN 20 initially
    for (const [sw, pc, vlan] of [[sw1, pc1, '192.168.10.1'], [sw2, pc2, '192.168.10.2']] as const) {
      await (sw as CiscoSwitch).executeCommand('enable');
      await (sw as CiscoSwitch).executeCommand('configure terminal');
      await (sw as CiscoSwitch).executeCommand('interface FastEthernet0/0');
      await (sw as CiscoSwitch).executeCommand('switchport access vlan 10');
      await (sw as CiscoSwitch).executeCommand('interface FastEthernet0/7');
      await (sw as CiscoSwitch).executeCommand('switchport mode trunk');
      await (sw as CiscoSwitch).executeCommand('switchport trunk allowed vlan 20');
      await (sw as CiscoSwitch).executeCommand('end');
    }

    await pc1.executeCommand('ifconfig eth0 192.168.10.1');
    await pc2.executeCommand('ifconfig eth0 192.168.10.2');

    // Ping fails — VLAN 10 not allowed on trunk
    const before = await pc1.executeCommand('ping -c 1 192.168.10.2');
    expect(before).toContain('100% packet loss');

    // Add VLAN 10 to trunk allowed list on both switches
    await sw1.executeCommand('enable');
    await sw1.executeCommand('configure terminal');
    await sw1.executeCommand('interface FastEthernet0/7');
    await sw1.executeCommand('switchport trunk allowed vlan add 10');
    await sw1.executeCommand('end');

    await sw2.executeCommand('enable');
    await sw2.executeCommand('configure terminal');
    await sw2.executeCommand('interface FastEthernet0/7');
    await sw2.executeCommand('switchport trunk allowed vlan add 10');
    await sw2.executeCommand('end');

    // Now ping should work
    const after = await pc1.executeCommand('ping -c 1 192.168.10.2');
    expect(after).toContain('1 received');
    expect(after).toContain('0% packet loss');
  });
});

// ═══════════════════════════════════════════════════════════════════
// V-C-03: Cisco multi-switch trunk with VLAN restrictions
// ═══════════════════════════════════════════════════════════════════

describe('V-C-03: Cisco multi-switch VLAN isolation via trunk filtering', () => {

  it('two VLANs on same trunk — each isolated to its own VLAN', async () => {
    // PC-A (VLAN 10) and PC-B (VLAN 20) on SW1
    // PC-C (VLAN 10) and PC-D (VLAN 20) on SW2
    // SW1↔SW2 trunk allows both VLAN 10 and 20
    const pcA = new LinuxPC('PC-A');
    const pcB = new LinuxPC('PC-B');
    const pcC = new LinuxPC('PC-C');
    const pcD = new LinuxPC('PC-D');
    const sw1 = new CiscoSwitch('sw1', 'SW1', 8);
    const sw2 = new CiscoSwitch('sw2', 'SW2', 8);

    new Cable('pca-sw1').connect(pcA.getPort('eth0')!, sw1.getPort('FastEthernet0/0')!);
    new Cable('pcb-sw1').connect(pcB.getPort('eth0')!, sw1.getPort('FastEthernet0/1')!);
    new Cable('sw1-sw2').connect(sw1.getPort('FastEthernet0/7')!, sw2.getPort('FastEthernet0/7')!);
    new Cable('sw2-pcc').connect(sw2.getPort('FastEthernet0/0')!, pcC.getPort('eth0')!);
    new Cable('sw2-pcd').connect(sw2.getPort('FastEthernet0/1')!, pcD.getPort('eth0')!);

    for (const sw of [sw1, sw2]) {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/0');
      await sw.executeCommand('switchport access vlan 10');
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport access vlan 20');
      await sw.executeCommand('interface FastEthernet0/7');
      await sw.executeCommand('switchport mode trunk');
      await sw.executeCommand('end');
    }

    await pcA.executeCommand('ifconfig eth0 10.0.10.1');
    await pcB.executeCommand('ifconfig eth0 10.0.20.1');
    await pcC.executeCommand('ifconfig eth0 10.0.10.2');
    await pcD.executeCommand('ifconfig eth0 10.0.20.2');

    // VLAN 10: A ↔ C — should communicate
    const pingAC = await pcA.executeCommand('ping -c 1 10.0.10.2');
    expect(pingAC).toContain('1 received');

    // VLAN 20: B ↔ D — should communicate
    const pingBD = await pcB.executeCommand('ping -c 1 10.0.20.2');
    expect(pingBD).toContain('1 received');

    // Cross-VLAN: A → D — should NOT communicate (same subnet but different VLANs)
    const pingAD = await pcA.executeCommand('ping -c 1 10.0.20.2');
    expect(pingAD).toContain('100% packet loss');
  });

  it('trunk with remove subcommand stops traffic for removed VLAN', async () => {
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');
    const sw1 = new CiscoSwitch('sw1', 'SW1', 8);
    const sw2 = new CiscoSwitch('sw2', 'SW2', 8);

    new Cable('pc1-sw1').connect(pc1.getPort('eth0')!, sw1.getPort('FastEthernet0/0')!);
    new Cable('sw1-sw2').connect(sw1.getPort('FastEthernet0/7')!, sw2.getPort('FastEthernet0/7')!);
    new Cable('sw2-pc2').connect(sw2.getPort('FastEthernet0/0')!, pc2.getPort('eth0')!);

    for (const sw of [sw1, sw2]) {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/0');
      await sw.executeCommand('switchport access vlan 10');
      await sw.executeCommand('interface FastEthernet0/7');
      await sw.executeCommand('switchport mode trunk');
      await sw.executeCommand('end');
    }

    await pc1.executeCommand('ifconfig eth0 192.168.10.1');
    await pc2.executeCommand('ifconfig eth0 192.168.10.2');

    // Verify initial connectivity
    const before = await pc1.executeCommand('ping -c 1 192.168.10.2');
    expect(before).toContain('1 received');

    // Remove VLAN 10 from both trunk ports
    for (const sw of [sw1, sw2]) {
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('interface FastEthernet0/7');
      await sw.executeCommand('switchport trunk allowed vlan remove 10');
      await sw.executeCommand('end');
    }

    // Now traffic should be blocked
    const after = await pc1.executeCommand('ping -c 1 192.168.10.2');
    expect(after).toContain('100% packet loss');
  });
});

// ═══════════════════════════════════════════════════════════════════
// V-H-01: Huawei port trunk allow-pass vlan (additive semantics)
// ═══════════════════════════════════════════════════════════════════

describe('V-H-01: Huawei port trunk allow-pass vlan — additive semantics', () => {

  it('multiple allow-pass commands accumulate VLANs', async () => {
    const sw = new HuaweiSwitch('sw1', 'SW1');

    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan batch 10 20 30');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type trunk');
    // Set initial restricted list
    await sw.executeCommand('port trunk allow-pass vlan none');
    await sw.executeCommand('port trunk allow-pass vlan 10');
    await sw.executeCommand('port trunk allow-pass vlan 20');
    await sw.executeCommand('quit');
    await sw.executeCommand('return');

    const cfg = sw.getSwitchportConfig('GigabitEthernet0/0/0');
    expect(cfg?.trunkAllowedVlans.has(10)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(20)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(30)).toBe(false);
  });

  it('allow-pass vlan with multiple IDs in one command', async () => {
    const sw = new HuaweiSwitch('sw1', 'SW1');

    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('port trunk allow-pass vlan none');
    await sw.executeCommand('port trunk allow-pass vlan 10 20 30');
    await sw.executeCommand('quit');
    await sw.executeCommand('return');

    const cfg = sw.getSwitchportConfig('GigabitEthernet0/0/0');
    expect(cfg?.trunkAllowedVlans.has(10)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(20)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(30)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(40)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// V-H-02: Huawei undo port trunk allow-pass vlan
// ═══════════════════════════════════════════════════════════════════

describe('V-H-02: Huawei undo port trunk allow-pass vlan', () => {

  it('removes specific VLANs from the allowed list', async () => {
    const sw = new HuaweiSwitch('sw1', 'SW1');

    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('port trunk allow-pass vlan none');
    await sw.executeCommand('port trunk allow-pass vlan 10 20 30 40');
    await sw.executeCommand('undo port trunk allow-pass vlan 20 40');
    await sw.executeCommand('quit');
    await sw.executeCommand('return');

    const cfg = sw.getSwitchportConfig('GigabitEthernet0/0/0');
    expect(cfg?.trunkAllowedVlans.has(10)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(20)).toBe(false);
    expect(cfg?.trunkAllowedVlans.has(30)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(40)).toBe(false);
  });

  it('undo all: removes all VLANs from the allowed list', async () => {
    const sw = new HuaweiSwitch('sw1', 'SW1');

    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('undo port trunk allow-pass vlan all');
    await sw.executeCommand('quit');
    await sw.executeCommand('return');

    const cfg = sw.getSwitchportConfig('GigabitEthernet0/0/0');
    expect(cfg?.trunkAllowedVlans.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// V-H-03: Huawei port trunk allow-pass vlan all / none
// ═══════════════════════════════════════════════════════════════════

describe('V-H-03: Huawei port trunk allow-pass vlan all / none', () => {

  it('allow-pass vlan all: allows all VLANs', async () => {
    const sw = new HuaweiSwitch('sw1', 'SW1');

    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type trunk');
    // Restrict first
    await sw.executeCommand('port trunk allow-pass vlan none');
    // Then restore all
    await sw.executeCommand('port trunk allow-pass vlan all');
    await sw.executeCommand('quit');
    await sw.executeCommand('return');

    const cfg = sw.getSwitchportConfig('GigabitEthernet0/0/0');
    expect(cfg?.trunkAllowedVlans.size).toBe(4094);
  });

  it('allow-pass vlan none: removes all VLANs', async () => {
    const sw = new HuaweiSwitch('sw1', 'SW1');

    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('port trunk allow-pass vlan none');
    await sw.executeCommand('quit');
    await sw.executeCommand('return');

    const cfg = sw.getSwitchportConfig('GigabitEthernet0/0/0');
    expect(cfg?.trunkAllowedVlans.size).toBe(0);
  });

  it('display current-configuration shows all for default trunk', async () => {
    const sw = new HuaweiSwitch('sw1', 'SW1');

    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('quit');
    await sw.executeCommand('return');

    const config = await sw.executeCommand('display current-configuration interface GigabitEthernet0/0/0');
    expect(config).toContain('port link-type trunk');
    expect(config).toContain('port trunk allow-pass vlan all');
  });

  it('display current-configuration shows none when no VLANs allowed', async () => {
    const sw = new HuaweiSwitch('sw1', 'SW1');

    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('port trunk allow-pass vlan none');
    await sw.executeCommand('quit');
    await sw.executeCommand('return');

    const config = await sw.executeCommand('display current-configuration interface GigabitEthernet0/0/0');
    expect(config).toContain('port trunk allow-pass vlan none');
  });

  it('display current-configuration shows specific VLANs', async () => {
    const sw = new HuaweiSwitch('sw1', 'SW1');

    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('port trunk allow-pass vlan none');
    await sw.executeCommand('port trunk allow-pass vlan 10 20 30');
    await sw.executeCommand('quit');
    await sw.executeCommand('return');

    const config = await sw.executeCommand('display current-configuration interface GigabitEthernet0/0/0');
    expect(config).toContain('port trunk allow-pass vlan');
    expect(config).toContain('10');
    expect(config).toContain('20');
    expect(config).toContain('30');
  });
});

// ═══════════════════════════════════════════════════════════════════
// V-H-04: Huawei trunk VLAN filtering at frame level
// ═══════════════════════════════════════════════════════════════════

describe('V-H-04: Huawei trunk VLAN filtering — frame level', () => {

  it('frames pass through trunk when VLAN is allowed', async () => {
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');
    const sw1 = new HuaweiSwitch('sw1', 'SW1');
    const sw2 = new HuaweiSwitch('sw2', 'SW2');

    new Cable('pc1-sw1').connect(pc1.getPort('eth0')!, sw1.getPort('GigabitEthernet0/0/0')!);
    new Cable('sw1-sw2').connect(sw1.getPort('GigabitEthernet0/0/23')!, sw2.getPort('GigabitEthernet0/0/23')!);
    new Cable('sw2-pc2').connect(sw2.getPort('GigabitEthernet0/0/0')!, pc2.getPort('eth0')!);

    for (const sw of [sw1, sw2]) {
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/0');
      await sw.executeCommand('port link-type access');
      await sw.executeCommand('port default vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/23');
      await sw.executeCommand('port link-type trunk');
      await sw.executeCommand('return');
      // Huawei ports start in STP listening state; advance to forwarding for VLAN tests
      sw.setAllPortsSTPState('forwarding');
    }

    await pc1.executeCommand('ifconfig eth0 192.168.10.1');
    await pc2.executeCommand('ifconfig eth0 192.168.10.2');

    const result = await pc1.executeCommand('ping -c 1 192.168.10.2');
    expect(result).toContain('1 received');
  });

  it('frames are blocked on trunk when VLAN is not in allow-pass list', async () => {
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');
    const sw1 = new HuaweiSwitch('sw1', 'SW1');
    const sw2 = new HuaweiSwitch('sw2', 'SW2');

    new Cable('pc1-sw1').connect(pc1.getPort('eth0')!, sw1.getPort('GigabitEthernet0/0/0')!);
    new Cable('sw1-sw2').connect(sw1.getPort('GigabitEthernet0/0/23')!, sw2.getPort('GigabitEthernet0/0/23')!);
    new Cable('sw2-pc2').connect(sw2.getPort('GigabitEthernet0/0/0')!, pc2.getPort('eth0')!);

    for (const sw of [sw1, sw2]) {
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/0');
      await sw.executeCommand('port link-type access');
      await sw.executeCommand('port default vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/23');
      await sw.executeCommand('port link-type trunk');
      // Only allow VLAN 20 — blocks VLAN 10
      await sw.executeCommand('port trunk allow-pass vlan none');
      await sw.executeCommand('port trunk allow-pass vlan 20');
      await sw.executeCommand('return');
      sw.setAllPortsSTPState('forwarding');
    }

    await pc1.executeCommand('ifconfig eth0 192.168.10.1');
    await pc2.executeCommand('ifconfig eth0 192.168.10.2');

    const result = await pc1.executeCommand('ping -c 1 192.168.10.2');
    expect(result).toContain('100% packet loss');
  });

  it('traffic resumes after adding VLAN to allow-pass list', async () => {
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');
    const sw1 = new HuaweiSwitch('sw1', 'SW1');
    const sw2 = new HuaweiSwitch('sw2', 'SW2');

    new Cable('pc1-sw1').connect(pc1.getPort('eth0')!, sw1.getPort('GigabitEthernet0/0/0')!);
    new Cable('sw1-sw2').connect(sw1.getPort('GigabitEthernet0/0/23')!, sw2.getPort('GigabitEthernet0/0/23')!);
    new Cable('sw2-pc2').connect(sw2.getPort('GigabitEthernet0/0/0')!, pc2.getPort('eth0')!);

    for (const sw of [sw1, sw2]) {
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/0');
      await sw.executeCommand('port link-type access');
      await sw.executeCommand('port default vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/23');
      await sw.executeCommand('port link-type trunk');
      await sw.executeCommand('port trunk allow-pass vlan none');
      await sw.executeCommand('return');
      sw.setAllPortsSTPState('forwarding');
    }

    await pc1.executeCommand('ifconfig eth0 192.168.10.1');
    await pc2.executeCommand('ifconfig eth0 192.168.10.2');

    const blocked = await pc1.executeCommand('ping -c 1 192.168.10.2');
    expect(blocked).toContain('100% packet loss');

    // Add VLAN 10 to trunk
    for (const sw of [sw1, sw2]) {
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/23');
      await sw.executeCommand('port trunk allow-pass vlan 10');
      await sw.executeCommand('return');
    }

    const allowed = await pc1.executeCommand('ping -c 1 192.168.10.2');
    expect(allowed).toContain('1 received');
    expect(allowed).toContain('0% packet loss');
  });
});

// ═══════════════════════════════════════════════════════════════════
// V-H-05: Huawei undo port default vlan / undo port trunk pvid vlan
// ═══════════════════════════════════════════════════════════════════

describe('V-H-05: Huawei undo port default/pvid vlan commands', () => {

  it('undo port default vlan resets access VLAN to 1', async () => {
    const sw = new HuaweiSwitch('sw1', 'SW1');

    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type access');
    await sw.executeCommand('port default vlan 10');

    let cfg = sw.getSwitchportConfig('GigabitEthernet0/0/0');
    expect(cfg?.accessVlan).toBe(10);

    await sw.executeCommand('undo port default vlan');
    await sw.executeCommand('quit');
    await sw.executeCommand('return');

    cfg = sw.getSwitchportConfig('GigabitEthernet0/0/0');
    expect(cfg?.accessVlan).toBe(1);
  });

  it('undo port trunk pvid vlan resets PVID to 1', async () => {
    const sw = new HuaweiSwitch('sw1', 'SW1');

    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('port trunk pvid vlan 99');

    let cfg = sw.getSwitchportConfig('GigabitEthernet0/0/0');
    expect(cfg?.trunkNativeVlan).toBe(99);

    await sw.executeCommand('undo port trunk pvid vlan');
    await sw.executeCommand('quit');
    await sw.executeCommand('return');

    cfg = sw.getSwitchportConfig('GigabitEthernet0/0/0');
    expect(cfg?.trunkNativeVlan).toBe(1);
  });
});
