/**
 * Vendor comment lines are silent no-ops — config paste must work.
 *
 * Real gear: Cisco IOS treats lines beginning with `!` as comments in
 * EVERY mode (config files are full of them); Huawei VRP does the same
 * with `#` (its config separator). The simulator used to reject both
 * with "% Invalid input", which broke pasting any real-world config.
 *
 * The fix lives in the device shells, so the UI terminal, vty and SSH
 * paths all benefit.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('Cisco `!` comment lines are silent in every mode', () => {
  it('router: exec, privileged, config and interface modes', async () => {
    const r = new CiscoRouter('R1');
    expect(await r.executeCommand('! user exec comment')).toBe('');
    await r.executeCommand('enable');
    expect(await r.executeCommand('!')).toBe('');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('! building configuration')).toBe('');
    await r.executeCommand('interface GigabitEthernet0/0');
    expect(await r.executeCommand('!')).toBe('');
  });

  it('switch: config mode', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 24, 0, 0);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    expect(await sw.executeCommand('! vlan section')).toBe('');
  });

  it('a pasted IOS config fragment with comment separators applies cleanly', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    for (const line of [
      '!',
      '! Interface facing the LAN',
      '!',
      'hostname PASTED',
      '!',
    ]) {
      const out = await r.executeCommand(line);
      expect(out, `line "${line}" must not error`).not.toContain('% Invalid');
    }
    await r.executeCommand('end');
    expect(await r.executeCommand('show running-config')).toContain('hostname PASTED');
  });

  it('`#` stays invalid on Cisco (real IOS rejects it)', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('# not an IOS comment')).toContain('% Invalid');
  });
});

describe('Huawei `#` comment lines are silent in every view', () => {
  it('router: user view, system view and interface view', async () => {
    const h = new HuaweiRouter('H1');
    expect(await h.executeCommand('# vrp comment')).toBe('');
    await h.executeCommand('system-view');
    expect(await h.executeCommand('#')).toBe('');
    await h.executeCommand('interface GigabitEthernet0/0/0');
    expect(await h.executeCommand('# interface section')).toBe('');
  });

  it('switch: system view', async () => {
    const sw = new HuaweiSwitch('switch-huawei', 'HSW1', 24, 0, 0);
    await sw.executeCommand('system-view');
    expect(await sw.executeCommand('#')).toBe('');
  });

  it('a pasted VRP config fragment with # separators applies cleanly', async () => {
    const h = new HuaweiRouter('H1');
    await h.executeCommand('system-view');
    for (const line of ['#', 'sysname VRP-PASTED', '#']) {
      const out = await h.executeCommand(line);
      expect(out, `line "${line}" must not error`).not.toContain('Error');
    }
    await h.executeCommand('quit');
    expect(await h.executeCommand('display current-configuration')).toContain('VRP-PASTED');
  });
});
