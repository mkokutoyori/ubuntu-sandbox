import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const INVALID = "% Invalid input detected at '^' marker.";
const INCOMPLETE = '% Incomplete command.';

describe('Cisco logging host — shared validation (router + switch)', () => {
  it('router and switch reject incomplete and invalid logging hosts identically', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('SW1');
    new Cable('lan').connect(
      r.getPort('GigabitEthernet0/0')!, sw.getPort('GigabitEthernet0/1')!);

    for (const d of [r, sw]) {
      await d.executeCommand('enable');
      await d.executeCommand('configure terminal');
      expect(await d.executeCommand('logging host')).toBe(INCOMPLETE);
      expect(await d.executeCommand('logging host 999.1.1.1')).toBe(INVALID);
      expect(await d.executeCommand('logging host 10.0.0.99')).toBe('');
      await d.executeCommand('end');
    }
  });

  it('the applied host is reflected in show logging and running-config on both', async () => {
    const r = new CiscoRouter('R1');
    const sw = new CiscoSwitch('SW1');
    new Cable('lan').connect(
      r.getPort('GigabitEthernet0/0')!, sw.getPort('GigabitEthernet0/1')!);

    for (const d of [r, sw]) {
      await d.executeCommand('enable');
      await d.executeCommand('configure terminal');
      await d.executeCommand('logging host 10.0.0.99');
      await d.executeCommand('end');
      expect(await d.executeCommand('show logging')).toContain('Logging to 10.0.0.99');
      expect(await d.executeCommand('show running-config')).toContain('logging host 10.0.0.99');
    }
  });
});

describe('Cisco ntp server — argument validation', () => {
  it('rejects a bare ntp server with no target', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('ntp server')).toBe(INCOMPLETE);
  });
});

describe('Cisco ip name-server / ip domain-name — argument validation', () => {
  it('rejects incomplete and invalid name-server addresses', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('ip name-server')).toBe(INCOMPLETE);
    expect(await r.executeCommand('ip name-server 999.1.1.1')).toBe(INVALID);
    expect(await r.executeCommand('ip name-server 8.8.8.8')).toBe('');
    expect(await r.executeCommand('ip domain-name')).toBe(INCOMPLETE);
    expect(await r.executeCommand('ip domain-name example.com')).toBe('');
  });

  it('a configured domain name is consistent in running-config and show hosts', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('ip domain-name example.com');
    await r.executeCommand('end');
    const rc = (await r.executeCommand('show running-config'))
      .split('\n').filter(l => l.includes('ip domain-name example.com'));
    expect(rc).toHaveLength(1);
    expect(await r.executeCommand('show hosts')).toContain('Default domain is example.com');
  });
});
