/**
 * Cisco Interface Description — TDD Test Suite
 *
 * Tests cover:
 *   Group 1: Router interface descriptions (set, show, running-config)
 *   Group 2: Switch interface descriptions (set, show, running-config)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════
// Group 1: Router Interface Descriptions
// ═══════════════════════════════════════════════════════════════════

describe('Group 1: Router Interface Descriptions', () => {

  it('should set an interface description via CLI', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('description Uplink to Core Switch');

    expect(r.getInterfaceDescription('GigabitEthernet0/0')).toBe('Uplink to Core Switch');
  });

  it('should show description in running-config', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('description LAN segment A');
    await r.executeCommand('end');

    const runCfg = await r.executeCommand('show running-config');
    expect(runCfg).toContain('description LAN segment A');
  });

  it('should remove description with no description', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('description Old description');
    expect(r.getInterfaceDescription('GigabitEthernet0/0')).toBe('Old description');

    await r.executeCommand('no description');
    expect(r.getInterfaceDescription('GigabitEthernet0/0')).toBe('');
  });

  it('should not show removed description in running-config', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('description Temporary');
    await r.executeCommand('no description');
    await r.executeCommand('end');

    const runCfg = await r.executeCommand('show running-config');
    expect(runCfg).not.toContain('description Temporary');
  });

  it('should support multi-word descriptions', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/1');
    await r.executeCommand('description WAN link to ISP -- primary 100Mbps');

    expect(r.getInterfaceDescription('GigabitEthernet0/1')).toBe('WAN link to ISP -- primary 100Mbps');
  });

  it('should return error if no argument provided', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    const out = await r.executeCommand('description');
    expect(out).toContain('% Incomplete command');
  });

  it('should support different descriptions per interface', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');

    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('description LAN A');
    await r.executeCommand('exit');

    await r.executeCommand('interface GigabitEthernet0/1');
    await r.executeCommand('description WAN B');

    expect(r.getInterfaceDescription('GigabitEthernet0/0')).toBe('LAN A');
    expect(r.getInterfaceDescription('GigabitEthernet0/1')).toBe('WAN B');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Group 2: Switch Interface Descriptions
// ═══════════════════════════════════════════════════════════════════

describe('Group 2: Switch Interface Descriptions', () => {

  it('should set an interface description via CLI', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('description Server Room Port 1');

    expect(sw.getInterfaceDescription('FastEthernet0/0')).toBe('Server Room Port 1');
  });

  it('should show description in show interfaces status', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('description Trunk to R1');
    await sw.executeCommand('end');

    const output = await sw.executeCommand('show interfaces status');
    expect(output).toContain('Trunk to R1');
  });

  it('should show description in running-config', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('description Access Port Floor 2');
    await sw.executeCommand('end');

    const runCfg = await sw.executeCommand('show running-config');
    expect(runCfg).toContain('description Access Port Floor 2');
  });

  it('should remove description with no description', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('description To be removed');
    await sw.executeCommand('no description');

    const desc = sw.getInterfaceDescription('FastEthernet0/0');
    expect(!desc || desc === '').toBe(true);
  });

  it('should apply description to interface range', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface range FastEthernet0/0-1');
    await sw.executeCommand('description Workstations');

    expect(sw.getInterfaceDescription('FastEthernet0/0')).toBe('Workstations');
    expect(sw.getInterfaceDescription('FastEthernet0/1')).toBe('Workstations');
  });

  it('should truncate long descriptions in show interfaces status', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    await sw.executeCommand('interface FastEthernet0/0');
    await sw.executeCommand('description A very long description that exceeds seventeen characters');
    await sw.executeCommand('end');

    // Full description should be stored
    expect(sw.getInterfaceDescription('FastEthernet0/0')).toBe('A very long description that exceeds seventeen characters');

    // But show interfaces status should truncate it
    const output = await sw.executeCommand('show interfaces status');
    // The description column is truncated to 17 chars in the status display
    expect(output).toContain('A very long descr');
  });
});
