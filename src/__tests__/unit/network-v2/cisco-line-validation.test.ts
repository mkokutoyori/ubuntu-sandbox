import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });
const INVALID = "% Invalid input detected at '^' marker.";

async function vty(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('line vty 0 4');
  return r;
}

describe('Cisco config-line — argument validation', () => {
  it('password / exec-timeout / transport / access-class reject incomplete or bad input', async () => {
    const r = await vty();
    expect(await r.executeCommand('password')).toBe('% Incomplete command.');
    expect(await r.executeCommand('exec-timeout')).toBe('% Incomplete command.');
    expect(await r.executeCommand('exec-timeout abc')).toBe(INVALID);
    expect(await r.executeCommand('transport input')).toBe('% Incomplete command.');
    expect(await r.executeCommand('transport input foo')).toBe(INVALID);
    expect(await r.executeCommand('access-class')).toBe('% Incomplete command.');
    expect(await r.executeCommand('access-class 10')).toBe('% Incomplete command.');
    expect(await r.executeCommand('access-class 10 sideways')).toBe(INVALID);
  });

  it('valid line commands apply and persist in running-config', async () => {
    const r = await vty();
    expect(await r.executeCommand('password cisco')).toBe('');
    expect(await r.executeCommand('exec-timeout 5 30')).toBe('');
    expect(await r.executeCommand('transport input ssh')).toBe('');
    expect(await r.executeCommand('access-class 10 in')).toBe('');
    const rc = await r.executeCommand('do show running-config');
    expect(rc).toContain('transport input ssh');
    expect(rc).toMatch(/exec-timeout 5 30/);
  });

  it('the same validation applies on a switch (shared handler)', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await s.executeCommand('enable');
    await s.executeCommand('configure terminal');
    await s.executeCommand('line vty 0 4');
    expect(await s.executeCommand('transport input foo')).toBe(INVALID);
    expect(await s.executeCommand('exec-timeout')).toBe('% Incomplete command.');
  });
});
