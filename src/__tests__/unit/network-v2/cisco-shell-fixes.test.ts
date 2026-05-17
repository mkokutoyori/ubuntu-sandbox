/**
 * TDD — anomalies from debug-output/cisco/*. These IOS commands are
 * common to the Cisco switch AND router (both extend CiscoShellBase),
 * so the fix lives in the shared base (DRY).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

describe('Cisco IOS — common show/util commands (switch & router, DRY)', () => {
  it('switch: show clock/users/inventory/processes/memory recognized', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 26);
    for (const c of ['show clock', 'show users', 'show inventory',
      'show processes cpu', 'show memory statistics']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Invalid input|Unrecognized/);
    }
    await sw.executeCommand('enable');
    expect(await sw.executeCommand('show privilege')).not.toMatch(/Invalid input/);
    expect(await sw.executeCommand('show flash')).not.toMatch(/Invalid input/);
    const clk = await sw.executeCommand('show clock');
    expect(clk).toMatch(/\d{2}:\d{2}:\d{2}|\d{4}/);
  });

  it('router: the same shared commands work (DRY)', async () => {
    const r = new CiscoRouter('R1');
    for (const c of ['show clock', 'show users', 'show processes cpu']) {
      expect(await r.executeCommand(c)).not.toMatch(/Invalid input|Unrecognized/);
    }
    await r.executeCommand('enable');
    expect(await r.executeCommand('show flash')).not.toMatch(/Invalid input/);
  });

  it('switch: terminal length / config no-ops recognized', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 26);
    await sw.executeCommand('enable');
    expect(await sw.executeCommand('terminal length 0')).not.toMatch(/Invalid input/);
    await sw.executeCommand('configure terminal');
    for (const c of ['no hostname', 'ip domain-lookup', 'no ip domain-lookup',
      'ip domain-name lab.local', 'banner motd # hello #']) {
      expect(await sw.executeCommand(c)).not.toMatch(/Invalid input|Unrecognized/);
    }
  });

  it('router: terminal length / banner shared too', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(await r.executeCommand('terminal length 0')).not.toMatch(/Invalid input/);
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('banner motd # hi #')).not.toMatch(/Invalid input/);
  });
});
