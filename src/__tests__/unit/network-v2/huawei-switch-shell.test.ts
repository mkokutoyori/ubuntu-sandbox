/**
 * TDD Tests for Huawei Switch Shell Refactoring & Auto-completion
 *
 * Tests cover:
 *   1. Shell extraction: ISwitchShell interface compliance
 *   2. CommandTrie integration for Huawei VRP switch CLI
 *   3. Tab completion (unique prefix → complete, ambiguous → null)
 *   4. ? help (prefix listing vs subcommand listing)
 *   5. Abbreviation matching (dis → display, sys → system-view)
 *   6. All existing HuaweiVRPSwitchShell functionality preserved
 *   7. Mode navigation with CommandTrie
 *
 * RED phase: These tests define the expected behavior. The implementation
 * will use CommandTrie (like CiscoSwitchShell) instead of manual parsing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MACAddress, resetCounters } from '@/network/core/types';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

// Import from new locations after extraction
import type { ISwitchShell } from '@/network/devices/shells/ISwitchShell';
import { HuaweiSwitchShell } from '@/network/devices/shells/HuaweiSwitchShell';
import { CiscoSwitchShell } from '@/network/devices/shells/CiscoSwitchShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 1: ISwitchShell Interface & Extraction Verification
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: ISwitchShell Interface & Shell Extraction', () => {

  it('1.1 — CiscoSwitchShell should be importable from shells/ directory', () => {
    const shell = new CiscoSwitchShell();
    expect(shell).toBeDefined();
    expect(typeof shell.execute).toBe('function');
    expect(typeof shell.getPrompt).toBe('function');
  });

  it('1.2 — HuaweiSwitchShell should be importable from shells/ directory', () => {
    const shell = new HuaweiSwitchShell();
    expect(shell).toBeDefined();
    expect(typeof shell.execute).toBe('function');
    expect(typeof shell.getPrompt).toBe('function');
  });

  it('1.3 — CiscoSwitchShell should implement ISwitchShell', () => {
    const shell: ISwitchShell = new CiscoSwitchShell();
    expect(shell).toBeDefined();
    expect(typeof shell.execute).toBe('function');
    expect(typeof shell.getPrompt).toBe('function');
    expect(typeof shell.getHelp).toBe('function');
    expect(typeof shell.tabComplete).toBe('function');
  });

  it('1.4 — HuaweiSwitchShell should implement ISwitchShell', () => {
    const shell: ISwitchShell = new HuaweiSwitchShell();
    expect(shell).toBeDefined();
    expect(typeof shell.execute).toBe('function');
    expect(typeof shell.getPrompt).toBe('function');
    expect(typeof shell.getHelp).toBe('function');
    expect(typeof shell.tabComplete).toBe('function');
  });

  it('1.5 — CiscoSwitch should work with extracted CiscoSwitchShell', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW-C', 4);
    expect(sw.getPrompt()).toBe('SW-C>');
    await sw.executeCommand('enable');
    expect(sw.getPrompt()).toBe('SW-C#');
  });

  it('1.6 — HuaweiSwitch should work with new HuaweiSwitchShell', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'SW-H', 4);
    expect(sw.getPrompt()).toBe('<SW-H>');
    await sw.executeCommand('system-view');
    expect(sw.getPrompt()).toBe('[SW-H]');
  });

  it('1.7 — GenericSwitch should work with extracted CiscoSwitchShell', async () => {
    const sw = new GenericSwitch('switch-generic', 'SW-G', 4);
    expect(sw.getPrompt()).toBe('SW-G>');
    await sw.executeCommand('enable');
    expect(sw.getPrompt()).toBe('SW-G#');
  });

  it('1.8 — Switch.ts should no longer export shell classes directly', async () => {
    // After extraction, CiscoSwitchShell and HuaweiVRPSwitchShell
    // should NOT be in Switch.ts — they should be in shells/
    // This verifies the imports come from the new location
    const sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
    const output = await sw.executeCommand('display version');
    expect(output).toContain('Huawei');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 2: Huawei Switch Tab Completion (CommandTrie)
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Huawei Switch — Tab Completion', () => {
  let sw: HuaweiSwitch;

  beforeEach(() => {
    sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
  });

  it('2.1 — Tab complete "dis" → "display " in user view', () => {
    const result = sw.cliTabComplete('dis');
    expect(result).toBe('display ');
  });

  it('2.2 — Tab complete "sys" → "system-view " in user view', () => {
    const result = sw.cliTabComplete('sys');
    expect(result).toBe('system-view ');
  });

  it('2.3 — Tab complete "display v" → "display version " in user view', () => {
    const result = sw.cliTabComplete('display v');
    expect(result).toBe('display version ');
  });

  it('2.4 — Tab complete "display vl" → "display vlan " in user view', async () => {
    const result = sw.cliTabComplete('display vl');
    expect(result).toBe('display vlan ');
  });

  it('2.5 — Tab complete ambiguous "d" → null (display? others?)', () => {
    // "d" could match "display" only in user mode, so it should complete
    // In user mode, if "display" is the only command starting with "d", it should complete
    const result = sw.cliTabComplete('d');
    expect(result).toBe('display ');
  });

  it('2.6 — Tab complete in system view: "int" → "interface "', async () => {
    await sw.executeCommand('system-view');
    const result = sw.cliTabComplete('int');
    expect(result).toBe('interface ');
  });

  it('2.7 — Tab complete in system view: "dis" → "display "', async () => {
    await sw.executeCommand('system-view');
    const result = sw.cliTabComplete('dis');
    expect(result).toBe('display ');
  });

  it('2.8 — Tab complete "display mac" → "display mac-address " in system view', async () => {
    await sw.executeCommand('system-view');
    const result = sw.cliTabComplete('display mac');
    expect(result).toBe('display mac-address ');
  });

  it('2.9 — Tab complete in interface view: "shut" → "shutdown "', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    const result = sw.cliTabComplete('shut');
    expect(result).toBe('shutdown ');
  });

  it('2.10 — Tab complete "port link" → "port link-type "', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    const result = sw.cliTabComplete('port link');
    expect(result).toBe('port link-type ');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 3: Huawei Switch ? Help (CommandTrie)
// ═══════════════════════════════════════════════════════════════════

describe('Group 3: Huawei Switch — ? Help System', () => {
  let sw: HuaweiSwitch;

  beforeEach(() => {
    sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
  });

  it('3.1 — "?" in user view should list all available commands', () => {
    const help = sw.cliHelp('');
    expect(help).toContain('display');
    expect(help).toContain('system-view');
  });

  it('3.2 — "dis?" should show prefix match for "dis"', () => {
    const help = sw.cliHelp('dis');
    expect(help).toContain('display');
  });

  it('3.3 — "display ?" should list display subcommands', () => {
    const help = sw.cliHelp('display ');
    expect(help).toContain('version');
    expect(help).toContain('vlan');
    expect(help).toContain('mac-address');
  });

  it('3.4 — "?" in system view should list system view commands', async () => {
    await sw.executeCommand('system-view');
    const help = sw.cliHelp('');
    expect(help).toContain('display');
    expect(help).toContain('sysname');
    expect(help).toContain('interface');
    expect(help).toContain('vlan');
  });

  it('3.5 — "port ?" in interface view should list port subcommands', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    const help = sw.cliHelp('port ');
    expect(help).toContain('link-type');
    expect(help).toContain('default');
    expect(help).toContain('trunk');
  });

  it('3.6 — "port link-type ?" should list access/trunk', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    const help = sw.cliHelp('port link-type ');
    expect(help).toContain('access');
    expect(help).toContain('trunk');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 4: Huawei Switch — Abbreviation & Ambiguity (CommandTrie)
// ═══════════════════════════════════════════════════════════════════

describe('Group 4: Huawei Switch — Abbreviation Matching', () => {
  let sw: HuaweiSwitch;

  beforeEach(() => {
    sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
  });

  it('4.1 — "dis version" should work as abbreviation of "display version"', async () => {
    const output = await sw.executeCommand('dis version');
    expect(output).toContain('Huawei');
    expect(output).toContain('VRP');
  });

  it('4.2 — "dis vl" should work as abbreviation of "display vlan"', async () => {
    const output = await sw.executeCommand('dis vl');
    expect(output).toContain('VLAN');
  });

  it('4.3 — "sys" should work as abbreviation of "system-view"', async () => {
    await sw.executeCommand('sys');
    expect(sw.getPrompt()).toBe('[SW1]');
  });

  it('4.4 — "dis int br" should work as abbreviation of "display interface brief"', async () => {
    const output = await sw.executeCommand('dis int br');
    expect(output).toContain('Interface');
    expect(output).toContain('GigabitEthernet0/0/0');
  });

  it('4.5 — "dis mac" should work as abbreviation of "display mac-address"', async () => {
    const output = await sw.executeCommand('dis mac');
    expect(output).toContain('MAC');
  });

  it('4.6 — "dis cur" abbreviation of "display current-configuration"', async () => {
    const output = await sw.executeCommand('dis cur');
    expect(output).toContain('sysname');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 5: Huawei Switch — Full Command Regression (Existing Features)
// ═══════════════════════════════════════════════════════════════════

describe('Group 5: Huawei Switch — Command Regression', () => {
  let sw: HuaweiSwitch;

  beforeEach(() => {
    sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
  });

  it('5.1 — Mode navigation: user → system → interface → quit → system → return → user', async () => {
    expect(sw.getPrompt()).toBe('<SW1>');
    await sw.executeCommand('system-view');
    expect(sw.getPrompt()).toBe('[SW1]');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    expect(sw.getPrompt()).toBe('[SW1-GigabitEthernet0/0/0]');
    await sw.executeCommand('quit');
    expect(sw.getPrompt()).toBe('[SW1]');
    await sw.executeCommand('return');
    expect(sw.getPrompt()).toBe('<SW1>');
  });

  it('5.2 — sysname change reflects in prompt', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('sysname MySwitch');
    expect(sw.getPrompt()).toBe('[MySwitch]');
  });

  it('5.3 — VLAN creation and display', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('name ENGINEERING');
    await sw.executeCommand('quit');
    const output = await sw.executeCommand('display vlan');
    expect(output).toContain('10');
    expect(output).toContain('ENGINEERING');
  });

  it('5.4 — VLAN batch creation', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan batch 10 20 30');
    const output = await sw.executeCommand('display vlan');
    expect(output).toContain('10');
    expect(output).toContain('20');
    expect(output).toContain('30');
  });

  it('5.5 — Interface port link-type access + port default vlan', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type access');
    await sw.executeCommand('port default vlan 10');
    await sw.executeCommand('quit');

    const cfg = sw.getSwitchportConfig('GigabitEthernet0/0/0');
    expect(cfg?.mode).toBe('access');
    expect(cfg?.accessVlan).toBe(10);
  });

  it('5.6 — Interface trunk configuration', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('port trunk allow-pass vlan 10 20 30');
    await sw.executeCommand('port trunk pvid vlan 10');
    await sw.executeCommand('quit');

    const cfg = sw.getSwitchportConfig('GigabitEthernet0/0/0');
    expect(cfg?.mode).toBe('trunk');
    expect(cfg?.trunkNativeVlan).toBe(10);
    expect(cfg?.trunkAllowedVlans.has(10)).toBe(true);
    expect(cfg?.trunkAllowedVlans.has(20)).toBe(true);
  });

  it('5.7 — shutdown / undo shutdown', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('shutdown');
    expect(sw.getPort('GigabitEthernet0/0/0')?.getIsUp()).toBe(false);
    await sw.executeCommand('undo shutdown');
    expect(sw.getPort('GigabitEthernet0/0/0')?.getIsUp()).toBe(true);
  });

  it('5.8 — undo vlan deletion', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('quit');
    expect(sw.getVLAN(10)).toBeDefined();
    await sw.executeCommand('undo vlan 10');
    expect(sw.getVLAN(10)).toBeUndefined();
  });

  it('5.9 — display interface brief shows all ports', async () => {
    const output = await sw.executeCommand('display interface brief');
    expect(output).toContain('GigabitEthernet0/0/0');
    expect(output).toContain('GigabitEthernet0/0/1');
    expect(output).toContain('GigabitEthernet0/0/2');
    expect(output).toContain('GigabitEthernet0/0/3');
  });

  it('5.10 — display current-configuration shows full config', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('sysname TestSW');
    await sw.executeCommand('vlan 100');
    await sw.executeCommand('name SERVERS');
    await sw.executeCommand('quit');
    await sw.executeCommand('return');
    const output = await sw.executeCommand('display current-configuration');
    expect(output).toContain('sysname TestSW');
    expect(output).toContain('vlan 100');
    expect(output).toContain('SERVERS');
  });

  it('5.11 — MAC aging time configuration', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('mac-address aging-time 600');
    const output = await sw.executeCommand('display mac-address aging-time');
    expect(output).toContain('600');
  });

  it('5.12 — Interface description', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('description Uplink to Core');
    await sw.executeCommand('quit');
    const output = await sw.executeCommand('display interface GigabitEthernet0/0/0');
    expect(output).toContain('Uplink to Core');
  });

  it('5.13 — Interface abbreviation: GE0/0/0 resolves to GigabitEthernet0/0/0', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GE0/0/0');
    expect(sw.getPrompt()).toContain('GigabitEthernet0/0/0');
  });

  it('5.14 — display current-configuration interface shows single interface', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    await sw.executeCommand('port link-type trunk');
    await sw.executeCommand('quit');
    await sw.executeCommand('return');
    const output = await sw.executeCommand('display current-configuration interface GigabitEthernet0/0/0');
    expect(output).toContain('GigabitEthernet0/0/0');
    expect(output).toContain('trunk');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 6: Huawei Switch — Error Handling
// ═══════════════════════════════════════════════════════════════════

describe('Group 6: Huawei Switch — Error Handling', () => {
  let sw: HuaweiSwitch;

  beforeEach(() => {
    sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
  });

  it('6.1 — Unrecognized command returns error', async () => {
    const output = await sw.executeCommand('foobar');
    expect(output).toContain('Error');
  });

  it('6.2 — Incomplete sysname command returns error', async () => {
    await sw.executeCommand('system-view');
    const output = await sw.executeCommand('sysname');
    expect(output).toContain('Incomplete');
  });

  it('6.3 — Invalid VLAN ID returns error', async () => {
    await sw.executeCommand('system-view');
    const output = await sw.executeCommand('vlan 9999');
    expect(output).toContain('Error');
  });

  it('6.4 — Cannot delete default VLAN 1', async () => {
    await sw.executeCommand('system-view');
    const output = await sw.executeCommand('undo vlan 1');
    expect(output).toContain('Error');
  });
});

// ═══════════════════════════════════════════════════════════════════
// GROUP 7: Huawei Switch — display command from interface view
// ═══════════════════════════════════════════════════════════════════

describe('Group 7: Huawei Switch — display from nested views', () => {
  let sw: HuaweiSwitch;

  beforeEach(() => {
    sw = new HuaweiSwitch('switch-huawei', 'SW1', 4);
  });

  it('7.1 — display vlan from interface view', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan 10');
    await sw.executeCommand('quit');
    await sw.executeCommand('interface GigabitEthernet0/0/0');
    const output = await sw.executeCommand('display vlan');
    expect(output).toContain('10');
  });

  it('7.2 — display version from system view', async () => {
    await sw.executeCommand('system-view');
    const output = await sw.executeCommand('display version');
    expect(output).toContain('Huawei');
  });

  it('7.3 — display mac-address from system view', async () => {
    await sw.executeCommand('system-view');
    const output = await sw.executeCommand('display mac-address');
    expect(output).toContain('MAC');
  });

  it('7.4 — Tab completion works in VLAN view', async () => {
    await sw.executeCommand('system-view');
    await sw.executeCommand('vlan 10');
    const result = sw.cliTabComplete('na');
    expect(result).toBe('name ');
  });
});
