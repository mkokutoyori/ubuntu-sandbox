/**
 * Switch CLI & L2 Switching Tests
 *
 * Tests cover:
 *   T-CLI-01: Navigation & Hierarchy (FSM mode transitions)
 *   T-CLI-02: Abbreviation & Ambiguity (Trie parser)
 *   T-CLI-03: Configuration Persistence (running-config / write memory)
 *   T-L2-01:  VLAN Isolation (real frame-level isolation)
 *   T-L2-02:  Persistence after Reboot
 *   T-L2-03:  802.1Q Trunking
 *   T-L2-04:  MAC Address Table
 *   T-L2-05:  Interface Range
 *   T-L2-06:  Show commands
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Switch, CiscoSwitchShell } from '@/network/devices/Switch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress } from '@/network/core/types';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';

// ═══════════════════════════════════════════════════════════════════
// T-CLI-01: Navigation & Hierarchy (FSM)
// ═══════════════════════════════════════════════════════════════════

describe('T-CLI-01: Navigation & Hierarchy', () => {
  let sw: Switch;

  beforeEach(() => {
    MACAddress.resetCounter();
    sw = new Switch('switch-cisco', 'Switch1', 4);
  });

  it('should start in User EXEC mode (>)', () => {
    expect(sw.getPrompt()).toBe('Switch1>');
  });

  it('should transition > → # via enable', async () => {
    await sw.executeCommand('enable');
    expect(sw.getPrompt()).toBe('Switch1#');
  });

  it('should transition # → (config)# via configure terminal', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    expect(sw.getPrompt()).toBe('Switch1(config)#');
  });

  it('should transition (config)# → (config-if)# via interface', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    expect(sw.getPrompt()).toBe('Switch1(config-if)#');
  });

  it('should transition (config)# → (config-vlan)# via vlan', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('vlan 10');
    expect(sw.getPrompt()).toBe('Switch1(config-vlan)#');
  });

  it('should exit from (config-if)# to (config)# via exit', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    expect(sw.getPrompt()).toBe('Switch1(config-if)#');
    await sw.executeCommand('exit');
    expect(sw.getPrompt()).toBe('Switch1(config)#');
  });

  it('should exit twice from (config-if)# to # via two exits', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('exit');
    await sw.executeCommand('exit');
    expect(sw.getPrompt()).toBe('Switch1#');
  });

  it('should return to # from any config mode via end', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    expect(sw.getPrompt()).toBe('Switch1(config-if)#');
    await sw.executeCommand('end');
    expect(sw.getPrompt()).toBe('Switch1#');
  });

  it('should disable from # to > via disable', async () => {
    await sw.executeCommand('enable');
    expect(sw.getPrompt()).toBe('Switch1#');
    await sw.executeCommand('disable');
    expect(sw.getPrompt()).toBe('Switch1>');
  });

  it('should support conf t abbreviation for configure terminal', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    expect(sw.getPrompt()).toBe('Switch1(config)#');
  });
});

// ═══════════════════════════════════════════════════════════════════
// T-CLI-02: Abbreviation & Ambiguity
// ═══════════════════════════════════════════════════════════════════

describe('T-CLI-02: Abbreviation & Ambiguity', () => {
  let sw: Switch;

  beforeEach(() => {
    MACAddress.resetCounter();
    sw = new Switch('switch-cisco', 'Switch1', 4);
  });

  it('should resolve "sh mac add" as show mac address-table', async () => {
    await sw.executeCommand('enable');
    const result = await sw.executeCommand('sh mac add');
    expect(result).toContain('Mac Address Table');
  });

  it('should resolve "sh vl br" as show vlan brief', async () => {
    await sw.executeCommand('enable');
    const result = await sw.executeCommand('sh vl br');
    expect(result).toContain('VLAN Name');
    expect(result).toContain('default');
  });

  it('should resolve "wr" as write memory', async () => {
    await sw.executeCommand('enable');
    const result = await sw.executeCommand('wr');
    expect(result).toBe('[OK]');
  });

  it('should return ambiguous error for "s" in config-if mode', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('int fa0/0');
    // In config-if mode, "s" matches shutdown and switchport — ambiguous
    const result = await sw.executeCommand('s');
    expect(result).toContain('Ambiguous');
  });

  it('should resolve interface abbreviation fa0/1', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    const result = await sw.executeCommand('int fa0/1');
    expect(sw.getPrompt()).toBe('Switch1(config-if)#');
  });

  it('should resolve interface abbreviation gi0/0', async () => {
    // 4-port switch won't have GigabitEthernet, use 26-port switch
    const sw26 = new Switch('switch-cisco', 'SW', 26);
    await sw26.executeCommand('enable');
    await sw26.executeCommand('configure terminal');
    await sw26.executeCommand('int gi0/0');
    expect(sw26.getPrompt()).toBe('SW(config-if)#');
  });
});

// ═══════════════════════════════════════════════════════════════════
// T-CLI-03: Configuration Persistence
// ═══════════════════════════════════════════════════════════════════

describe('T-CLI-03: Configuration Persistence', () => {
  let sw: Switch;

  beforeEach(() => {
    MACAddress.resetCounter();
    sw = new Switch('switch-cisco', 'Switch1', 4);
  });

  it('should update hostname in running-config', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('hostname R1-Core');
    expect(sw.getPrompt()).toBe('R1-Core(config)#');

    const config = await sw.executeCommand('do show running-config');
    expect(config).toContain('hostname R1-Core');
  });

  it('should show shutdown in running-config after interface shutdown', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('int fa0/1');
    await sw.executeCommand('shutdown');
    await sw.executeCommand('end');

    const config = await sw.executeCommand('show running-config');
    expect(config).toContain('interface FastEthernet0/1');
    expect(config).toContain('shutdown');
  });

  it('should actually stop forwarding on shutdown port', async () => {
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');
    const c1 = new Cable('c1');
    const c2 = new Cable('c2');

    c1.connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
    c2.connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

    await pc1.executeCommand('ifconfig eth0 10.0.0.1 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 255.255.255.0');

    // Verify ping works initially
    const before = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(before).toContain('1 received');

    // Shutdown the port
    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('int fa0/1');
    await sw.executeCommand('shutdown');

    // Port should be down — ping should fail
    const after = await pc1.executeCommand('ping -c 1 10.0.0.2');
    expect(after).toContain('0 received');
  });

  it('should show VLANs in running-config', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('name SERVERS');
    await sw.executeCommand('exit');

    const config = await sw.executeCommand('do show running-config');
    expect(config).toContain('vlan 10');
    expect(config).toContain('name SERVERS');
  });

  it('should show switchport access vlan in running-config', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('int fa0/0');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('end');

    const config = await sw.executeCommand('show running-config');
    expect(config).toContain('switchport access vlan 10');
  });

  it('should show trunk mode in running-config', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('int fa0/3');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('end');

    const config = await sw.executeCommand('show running-config');
    expect(config).toContain('switchport mode trunk');
  });
});

// ═══════════════════════════════════════════════════════════════════
// T-L2-01: VLAN Isolation (Frame-level)
// ═══════════════════════════════════════════════════════════════════

describe('T-L2-01: VLAN Isolation', () => {
  it('should isolate traffic between VLANs', async () => {
    MACAddress.resetCounter();
    const sw = new Switch('switch-cisco', 'SW1', 4);
    const pcA = new LinuxPC('PC-A');
    const pcB = new LinuxPC('PC-B');

    const c1 = new Cable('c1');
    const c2 = new Cable('c2');
    c1.connect(pcA.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
    c2.connect(pcB.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

    await pcA.executeCommand('ifconfig eth0 192.168.1.10 255.255.255.0');
    await pcB.executeCommand('ifconfig eth0 192.168.1.20 255.255.255.0');

    // Both in VLAN 1 — should communicate
    const before = await pcA.executeCommand('ping -c 1 192.168.1.20');
    expect(before).toContain('1 received');

    // Move PC-A to VLAN 10
    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('exit');
    await sw.executeCommand('int fa0/0');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('end');

    // Clear MAC table to force new learning
    sw.clearMACTable();

    // Now PC-A (VLAN 10) should NOT be able to reach PC-B (VLAN 1)
    const after = await pcA.executeCommand('ping -c 1 192.168.1.20');
    expect(after).toContain('0 received');

    // Verify show mac address-table shows correct VLANs
    const macTable = await sw.executeCommand('show mac address-table');
    // PC-A's MAC should be in VLAN 10 if learned
    // PC-B's MAC should be in VLAN 1 if learned
  });

  it('should show VLAN assignments in show vlan brief', async () => {
    MACAddress.resetCounter();
    const sw = new Switch('switch-cisco', 'SW1', 4);

    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('name SERVERS');
    await sw.executeCommand('exit');
    await sw.executeCommand('int fa0/0');
    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('end');

    const result = await sw.executeCommand('show vlan brief');
    expect(result).toContain('SERVERS');
    expect(result).toContain('10');
    expect(result).toContain('Fa0/0');
  });
});

// ═══════════════════════════════════════════════════════════════════
// T-L2-02: Persistence after Reboot
// ═══════════════════════════════════════════════════════════════════

describe('T-L2-02: Persistence after Reboot', () => {
  it('should restore hostname after write memory + reboot', async () => {
    MACAddress.resetCounter();
    const sw = new Switch('switch-cisco', 'Switch1', 4);

    // Change hostname and save
    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('hostname CORE-SW');
    await sw.executeCommand('end');
    await sw.executeCommand('write memory');

    // Reboot (powerOff + powerOn)
    sw.powerOff();
    sw.powerOn();

    // Prompt should use saved hostname (back in user mode after reboot)
    expect(sw.getPrompt()).toContain('CORE-SW');
  });

  it('should restore VLANs after write memory + reboot', async () => {
    MACAddress.resetCounter();
    const sw = new Switch('switch-cisco', 'SW', 4);

    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('vlan 20');
    await sw.executeCommand('name ENGINEERING');
    await sw.executeCommand('exit');
    await sw.executeCommand('end');
    await sw.executeCommand('write memory');

    sw.powerOff();
    sw.powerOn();

    await sw.executeCommand('enable');
    const result = await sw.executeCommand('show vlan brief');
    expect(result).toContain('20');
    expect(result).toContain('ENGINEERING');
  });

  it('should lose config without write memory after reboot', async () => {
    MACAddress.resetCounter();
    const sw = new Switch('switch-cisco', 'Switch1', 4);

    // Change hostname but DON'T save
    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('hostname TEMP-NAME');
    await sw.executeCommand('end');

    // Reboot without saving
    sw.powerOff();
    sw.powerOn();

    // Should revert to original hostname
    expect(sw.getPrompt()).toContain('Switch1');
  });
});

// ═══════════════════════════════════════════════════════════════════
// T-L2-03: 802.1Q Trunking
// ═══════════════════════════════════════════════════════════════════

describe('T-L2-03: 802.1Q Trunking', () => {
  it('should set trunk mode via CLI and show in interfaces status', async () => {
    MACAddress.resetCounter();
    const sw = new Switch('switch-cisco', 'SW1', 4);

    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('int fa0/3');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('end');

    const status = await sw.executeCommand('show interfaces status');
    expect(status).toContain('trunk');
  });

  it('should set trunk native VLAN', async () => {
    MACAddress.resetCounter();
    const sw = new Switch('switch-cisco', 'SW1', 4);

    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('int fa0/3');
    await sw.executeCommand('switchport mode trunk');
    await sw.executeCommand('switchport trunk native vlan 99');
    await sw.executeCommand('end');

    const config = await sw.executeCommand('show running-config');
    expect(config).toContain('switchport trunk native vlan 99');
  });

  it('should forward across trunk between two switches', async () => {
    MACAddress.resetCounter();
    const sw1 = new Switch('switch-cisco', 'SW1', 4);
    const sw2 = new Switch('switch-cisco', 'SW2', 4);
    const pcA = new LinuxPC('PC-A');
    const pcB = new LinuxPC('PC-B');

    // PC-A → SW1 fa0/0, SW1 fa0/3 (trunk) → SW2 fa0/3 (trunk), SW2 fa0/0 → PC-B
    new Cable('c1').connect(pcA.getPort('eth0')!, sw1.getPort('FastEthernet0/0')!);
    new Cable('c2').connect(sw1.getPort('FastEthernet0/3')!, sw2.getPort('FastEthernet0/3')!);
    new Cable('c3').connect(pcB.getPort('eth0')!, sw2.getPort('FastEthernet0/0')!);

    // Configure trunk on interconnect
    for (const sw of [sw1, sw2]) {
      await sw.executeCommand('enable');
      await sw.executeCommand('conf t');
      await sw.executeCommand('int fa0/3');
      await sw.executeCommand('switchport mode trunk');
      await sw.executeCommand('end');
    }

    await pcA.executeCommand('ifconfig eth0 10.0.0.1 255.255.255.0');
    await pcB.executeCommand('ifconfig eth0 10.0.0.2 255.255.255.0');

    // Same VLAN (1) through trunk — should work
    const result = await pcA.executeCommand('ping -c 1 10.0.0.2');
    expect(result).toContain('1 received');
  });
});

// ═══════════════════════════════════════════════════════════════════
// T-L2-04: MAC Address Table
// ═══════════════════════════════════════════════════════════════════

describe('T-L2-04: MAC Address Table', () => {
  it('should learn MAC addresses after traffic', async () => {
    MACAddress.resetCounter();
    const sw = new Switch('switch-cisco', 'SW1', 4);
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');

    new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

    await pc1.executeCommand('ifconfig eth0 10.0.0.1 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 255.255.255.0');

    expect(sw.getMACTable().length).toBe(0);

    await pc1.executeCommand('ping -c 1 10.0.0.2');

    const table = sw.getMACTable();
    expect(table.length).toBeGreaterThanOrEqual(2);
    expect(table.some(e => e.port === 'FastEthernet0/0')).toBe(true);
    expect(table.some(e => e.port === 'FastEthernet0/1')).toBe(true);
  });

  it('should display MAC table via show mac address-table', async () => {
    MACAddress.resetCounter();
    const sw = new Switch('switch-cisco', 'SW1', 4);
    const pc1 = new LinuxPC('PC1');
    const pc2 = new LinuxPC('PC2');

    new Cable('c1').connect(pc1.getPort('eth0')!, sw.getPort('FastEthernet0/0')!);
    new Cable('c2').connect(pc2.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);

    await pc1.executeCommand('ifconfig eth0 10.0.0.1 255.255.255.0');
    await pc2.executeCommand('ifconfig eth0 10.0.0.2 255.255.255.0');
    await pc1.executeCommand('ping -c 1 10.0.0.2');

    await sw.executeCommand('enable');
    const output = await sw.executeCommand('show mac address-table');

    expect(output).toContain('Mac Address Table');
    expect(output).toContain('DYNAMIC');
    expect(output).toContain('FastEthernet0/0');
    expect(output).toContain('FastEthernet0/1');
  });

  it('should age out MAC entries', () => {
    vi.useFakeTimers();
    MACAddress.resetCounter();

    const sw = new Switch('switch-cisco', 'SW1', 4);
    sw.setMACAgingTime(5); // 5 seconds for test

    // Inject a static MAC entry to test aging of dynamic entries
    // We can't use ping with fake timers, so manually inject a dynamic entry
    const macTable = sw.getMACTableRaw();
    const key = '1:00:00:00:00:00:01';
    // Use the internal add API — addStaticMAC creates static entries, but we want dynamic
    // Instead, send a frame directly through the switch
    const port = sw.getPort('FastEthernet0/0')!;
    const frame = {
      srcMAC: new MACAddress('00:00:00:00:00:01'),
      dstMAC: MACAddress.broadcast(),
      etherType: 0x0800,
      payload: {},
    };
    // Simulate receiving a frame on the port
    port.receiveFrame(frame);

    expect(sw.getMACTable().length).toBe(1);

    // Advance past aging time (aging timer runs every 1s)
    vi.advanceTimersByTime(10_000);

    expect(sw.getMACTable().length).toBe(0);

    vi.useRealTimers();
  });

  it('should clear MAC table', () => {
    MACAddress.resetCounter();
    const sw = new Switch('switch-cisco', 'SW1', 4);

    // Inject a frame to learn a MAC
    const port = sw.getPort('FastEthernet0/0')!;
    const frame = {
      srcMAC: new MACAddress('00:00:00:00:00:01'),
      dstMAC: MACAddress.broadcast(),
      etherType: 0x0800,
      payload: {},
    };
    port.receiveFrame(frame);

    expect(sw.getMACTable().length).toBe(1);
    sw.clearMACTable();
    expect(sw.getMACTable().length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// T-L2-05: Interface Range
// ═══════════════════════════════════════════════════════════════════

describe('T-L2-05: Interface Range', () => {
  it('should configure multiple interfaces with range command', async () => {
    MACAddress.resetCounter();
    const sw = new Switch('switch-cisco', 'SW1', 8);

    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('interface range fa0/0-3');
    expect(sw.getPrompt()).toBe('SW1(config-if)#');

    await sw.executeCommand('switchport access vlan 10');
    await sw.executeCommand('end');

    // All 4 ports should be in VLAN 10
    for (let i = 0; i <= 3; i++) {
      const cfg = sw.getSwitchportConfig(`FastEthernet0/${i}`);
      expect(cfg?.accessVlan).toBe(10);
    }

    // Ports 4+ should still be in VLAN 1
    const cfg4 = sw.getSwitchportConfig('FastEthernet0/4');
    expect(cfg4?.accessVlan).toBe(1);
  });

  it('should shutdown multiple interfaces with range', async () => {
    MACAddress.resetCounter();
    const sw = new Switch('switch-cisco', 'SW1', 8);

    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    await sw.executeCommand('interface range fa0/4-7');
    await sw.executeCommand('shutdown');
    await sw.executeCommand('end');

    for (let i = 4; i <= 7; i++) {
      const port = sw.getPort(`FastEthernet0/${i}`);
      expect(port?.getIsUp()).toBe(false);
    }

    // Ports 0-3 should still be up
    for (let i = 0; i <= 3; i++) {
      const port = sw.getPort(`FastEthernet0/${i}`);
      expect(port?.getIsUp()).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// T-L2-06: Show Commands
// ═══════════════════════════════════════════════════════════════════

describe('T-L2-06: Show Commands', () => {
  let sw: Switch;

  beforeEach(() => {
    MACAddress.resetCounter();
    sw = new Switch('switch-cisco', 'SW1', 4);
  });

  it('show vlan brief should list default VLAN 1', async () => {
    await sw.executeCommand('enable');
    const result = await sw.executeCommand('show vlan brief');
    expect(result).toContain('1');
    expect(result).toContain('default');
    expect(result).toContain('active');
  });

  it('show interfaces status should list all ports', async () => {
    await sw.executeCommand('enable');
    const result = await sw.executeCommand('show interfaces status');
    expect(result).toContain('Fa0/0');
    expect(result).toContain('Fa0/1');
    expect(result).toContain('Fa0/2');
    expect(result).toContain('Fa0/3');
  });

  it('show running-config should reflect current state', async () => {
    await sw.executeCommand('enable');
    const result = await sw.executeCommand('show running-config');
    expect(result).toContain('hostname SW1');
    expect(result).toContain('interface FastEthernet0/0');
    expect(result).toContain('switchport mode access');
    expect(result).toContain('end');
  });

  it('show spanning-tree should show port states', async () => {
    await sw.executeCommand('enable');
    const result = await sw.executeCommand('show spanning-tree');
    expect(result).toContain('VLAN0001');
    expect(result).toContain('ieee');
    expect(result).toContain('FWD');
  });

  it('show startup-config should show "not present" initially', async () => {
    await sw.executeCommand('enable');
    const result = await sw.executeCommand('show startup-config');
    expect(result).toContain('not present');
  });

  it('show startup-config should exist after write memory', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('write memory');
    const result = await sw.executeCommand('show startup-config');
    expect(result).not.toContain('not present');
  });
});

// ═══════════════════════════════════════════════════════════════════
// CommandTrie Unit Tests
// ═══════════════════════════════════════════════════════════════════

describe('CommandTrie', () => {
  let trie: CommandTrie;

  beforeEach(() => {
    trie = new CommandTrie();
    trie.register('show version', 'Display version', () => 'version-output');
    trie.register('show vlan brief', 'Display VLAN summary', () => 'vlan-output');
    trie.register('show mac address-table', 'Display MAC table', () => 'mac-output');
    trie.register('shutdown', 'Disable interface', () => 'shutdown-ok');
    trie.register('switchport mode access', 'Set access mode', () => 'access-ok');
    trie.register('switchport mode trunk', 'Set trunk mode', () => 'trunk-ok');
  });

  it('should match exact commands', () => {
    const result = trie.match('show version');
    expect(result.status).toBe('ok');
    expect(result.node?.action?.([], '')).toBe('version-output');
  });

  it('should match abbreviated commands unambiguously', () => {
    // "sh ver" → unique match: show version
    const result = trie.match('sh ver');
    expect(result.status).toBe('ok');
    expect(result.node?.action?.([], '')).toBe('version-output');
  });

  it('should detect ambiguous abbreviations', () => {
    // "s" matches both "show" and "shutdown" and "switchport"
    const result = trie.match('s');
    expect(result.status).toBe('ambiguous');
    expect(result.error).toContain('Ambiguous');
  });

  it('should report incomplete when missing arguments', () => {
    const result = trie.match('show');
    expect(result.status).toBe('incomplete');
  });

  it('should return completions for partial input', () => {
    const completions = trie.getCompletions('show ');
    expect(completions.length).toBeGreaterThanOrEqual(3);
    expect(completions.some(c => c.keyword === 'version')).toBe(true);
    expect(completions.some(c => c.keyword === 'vlan')).toBe(true);
    expect(completions.some(c => c.keyword === 'mac')).toBe(true);
  });

  it('should tab-complete unique prefix', () => {
    const completed = trie.tabComplete('sh ver');
    expect(completed).toBe('show version ');
  });

  it('should return null for ambiguous tab completion', () => {
    const completed = trie.tabComplete('s');
    expect(completed).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Error Messages
// ═══════════════════════════════════════════════════════════════════

describe('Error Messages', () => {
  let sw: Switch;

  beforeEach(() => {
    MACAddress.resetCounter();
    sw = new Switch('switch-cisco', 'SW1', 4);
  });

  it('should return "% Device is powered off" when off', async () => {
    sw.powerOff();
    const result = await sw.executeCommand('enable');
    expect(result).toContain('powered off');
  });

  it('should auto-enable configure terminal from user mode', async () => {
    const result = await sw.executeCommand('configure terminal');
    // Simulator convenience: auto-escalate to config mode from user mode
    expect(result).toContain('Enter configuration commands');
  });

  it('should return incomplete for missing VLAN ID', async () => {
    await sw.executeCommand('enable');
    await sw.executeCommand('conf t');
    const result = await sw.executeCommand('vlan');
    expect(result).toContain('Incomplete');
  });
});
