/**
 * TDD — Lot C: config-driven global feature flags
 * (docs/DESIGN-DEVICE-STATE-INSPECTION.md).
 *
 * `cdp run` / `no cdp run` (and friends) must mutate REAL device state
 * (CiscoConfigState Repository), not be swallowed as silent no-ops:
 * `show cdp` must reflect the actual enable flag. Shared switch+router.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { CiscoConfigState } from '@/network/devices/inspection/config/CiscoConfigState';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('CiscoConfigState Repository (unit)', () => {
  it('honours IOS defaults and records real overrides', () => {
    const s = new CiscoConfigState();
    expect(s.isEnabled('cdp')).toBe(true);     // CDP on by default
    expect(s.isEnabled('lldp')).toBe(false);   // LLDP off by default
    expect(s.set('cdp', false)).toBe(true);
    expect(s.isEnabled('cdp')).toBe(false);
    expect(s.set('not-a-feature', true)).toBe(false);
    expect(s.runningConfigLines()).toContain('no cdp run');
  });
});

describe('Cisco feature toggles mutate real state (router & switch)', () => {
  it('router: no cdp run is reflected by show cdp (not a no-op)', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    new Cable('w').connect(
      r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    await r1.executeCommand('enable');

    // Default: CDP on → real neighbour visible.
    expect(await r1.executeCommand('show cdp neighbors')).toContain('R2');

    await r1.executeCommand('configure terminal');
    expect(await r1.executeCommand('no cdp run')).not.toMatch(/Invalid input/);
    await r1.executeCommand('end');

    const off = await r1.executeCommand('show cdp neighbors');
    expect(off).not.toContain('R2');
    expect(off).toMatch(/Total cdp entries displayed : 0/);
    expect(await r1.executeCommand('show cdp')).toMatch(/not enabled/i);

    await r1.executeCommand('configure terminal');
    await r1.executeCommand('cdp run');
    await r1.executeCommand('end');
    expect(await r1.executeCommand('show cdp neighbors')).toContain('R2');
  });

  it('router: lldp is off by default and enabling it is real', async () => {
    const r1 = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'L1', 0, 0);
    new Cable('w').connect(
      r1.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await r1.executeCommand('enable');

    expect(await r1.executeCommand('show lldp')).toMatch(/not enabled/i);
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('lldp run');
    await r1.executeCommand('end');
    const on = await r1.executeCommand('show lldp neighbors');
    expect(on).toContain('L1');
  });

  it('switch: the same toggles are recognised and real (DRY)', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 26);
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');
    for (const c of ['ip cef', 'no ip cef', 'ip http server',
      'no ip http server', 'ip source-route', 'no ip source-route',
      'cdp run', 'no cdp run', 'lldp run', 'no lldp run',
      'no ip routing', 'ip domain-lookup', 'no ip domain-lookup']) {
      expect(await sw.executeCommand(c), c).not.toMatch(/Invalid input|Unrecognized/);
    }
    await sw.executeCommand('end');
    expect(await sw.executeCommand('show cdp')).toMatch(/not enabled/i);
  });
});
