/**
 * TDD — Lot C: logging as config-driven real state (LoggingConfig)
 * + show tech-support as real aggregation. No silent no-ops, no
 * fabricated output.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LoggingConfig } from '@/network/devices/inspection/config/LoggingConfig';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('LoggingConfig (unit)', () => {
  it('records buffered/trap/hosts and renders them', () => {
    const l = new LoggingConfig();
    l.apply(['buffered', '64000', 'informational'], false);
    l.apply(['host', '10.0.0.5'], false);
    l.apply(['trap', 'warnings'], false);
    const out = l.render();
    expect(out).toMatch(/Buffer logging: level informational, 64000 bytes/);
    expect(out).toContain('Logging to 10.0.0.5');
    expect(out).toMatch(/Trap logging: level warnings/);
    l.apply(['host', '10.0.0.5'], true);
    expect(l.render()).not.toContain('Logging to 10.0.0.5');
  });
});

describe('Cisco router logging / tech-support — real state', () => {
  it('logging config is recognised and projected by show logging', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    for (const c of [
      'logging buffered 64000 informational',
      'logging console warnings',
      'logging trap notifications',
      'logging host 10.0.0.5',
      'logging host 10.0.0.6',
      'logging facility local6',
    ]) {
      expect(await r.executeCommand(c), c).not.toMatch(/Invalid input|Incomplete/);
    }
    await r.executeCommand('end');

    const out = await r.executeCommand('show logging');
    expect(out).not.toMatch(/Invalid input/);
    expect(out).toContain('Logging to 10.0.0.5');
    expect(out).toContain('Logging to 10.0.0.6');
    expect(out).toMatch(/Buffer logging: level informational/);
    expect(out).toMatch(/Trap logging: level notifications/);
    expect(out).toMatch(/Facility: local6/);

    await r.executeCommand('configure terminal');
    await r.executeCommand('no logging host 10.0.0.5');
    await r.executeCommand('end');
    expect(await r.executeCommand('show logging')).not.toContain('Logging to 10.0.0.5');
  });

  it('show tech-support aggregates real show outputs', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    await r.executeCommand('interface GigabitEthernet0/0');
    await r.executeCommand('ip address 192.168.7.1 255.255.255.0');
    await r.executeCommand('no shutdown');
    await r.executeCommand('end');
    const ts = await r.executeCommand('show tech-support');
    expect(ts).not.toMatch(/Invalid input/);
    expect(ts).toContain('show version');
    expect(ts).toContain('show running-config');
    expect(ts).toContain('192.168.7.1');          // real config present
    expect(ts).toContain('show ip route');
  });
});
