/**
 * TDD — anomalies from debug-output/router/cisco-*. A large family of
 * generic IOS "show" commands is missing on BOTH the Cisco router and
 * switch (they share CiscoShellBase), so the fix belongs in the shared
 * base / CiscoCommonShow (DRY) — never duplicated per device.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
});

const COMMON_SHOW = [
  'show cdp', 'show cdp neighbors', 'show cdp neighbors detail',
  'show cdp interface', 'show lldp', 'show lldp neighbors',
  'show lldp neighbors detail', 'show snmp', 'show ntp status',
  'show ntp associations', 'show controllers', 'show environment',
  'show line', 'show ssh', 'show ip ssh', 'show hosts', 'show vrf',
  'show ip vrf', 'show boot', 'show redundancy', 'show file systems',
  'show calendar', 'show terminal', 'show processes memory',
  'show buffers', 'show tcp brief', 'show sockets', 'show stacks',
  'show reload', 'show aaa sessions',
];

describe('Cisco common show family (router & switch, DRY)', () => {
  it('router: every generic show command is recognized (priv)', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    for (const c of COMMON_SHOW) {
      const out = await r.executeCommand(c);
      expect(out, `router: ${c}`).not.toMatch(/Invalid input|Unrecognized|Incomplete/);
    }
  });

  it('router: generic show commands also recognized in user mode', async () => {
    const r = new CiscoRouter('R1');
    for (const c of ['show cdp neighbors', 'show ntp status', 'show line',
      'show hosts', 'show terminal']) {
      const out = await r.executeCommand(c);
      expect(out, `router-user: ${c}`).not.toMatch(/Invalid input|Unrecognized|Incomplete/);
    }
  });

  it('switch: the same shared show commands work (DRY)', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 26);
    await sw.executeCommand('enable');
    for (const c of COMMON_SHOW) {
      const out = await sw.executeCommand(c);
      expect(out, `switch: ${c}`).not.toMatch(/Invalid input|Unrecognized|Incomplete/);
    }
  });

  it('content sanity: cdp/ntp/line produce plausible output', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(await r.executeCommand('show cdp')).toMatch(/CDP|Sending|enabled/i);
    expect(await r.executeCommand('show ntp status')).toMatch(/clock|stratum|synchroniz/i);
    expect(await r.executeCommand('show line')).toMatch(/Tty|Line|con|vty/i);
  });
});
