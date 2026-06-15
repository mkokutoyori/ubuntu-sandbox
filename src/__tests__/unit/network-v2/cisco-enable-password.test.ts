import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

async function cfg(d: CiscoRouter | CiscoSwitch) {
  await d.executeCommand('enable');
  await d.executeCommand('configure terminal');
  return d;
}

describe('Cisco enable secret/password — single shared handler, arg validation', () => {
  it('no argument is incomplete (router and switch)', async () => {
    const r = await cfg(new CiscoRouter('R1'));
    expect(await r.executeCommand('enable secret')).toBe('% Incomplete command.');
    expect(await r.executeCommand('enable password')).toBe('% Incomplete command.');
    expect(await r.executeCommand('enable secret 5')).toBe('% Incomplete command.');
    const s = await cfg(new CiscoSwitch('switch-cisco', 'SW1', 4));
    expect(await s.executeCommand('enable secret')).toBe('% Incomplete command.');
  });

  it('a valid secret is stored and rendered in running-config', async () => {
    const r = await cfg(new CiscoRouter('R1'));
    expect(await r.executeCommand('enable secret cisco123')).toBe('');
    const rc = await r.executeCommand('do show running-config');
    expect(rc).toMatch(/enable secret 5 \$1\$/);
  });

  it('an explicit plaintext (type 0) secret is accepted', async () => {
    const r = await cfg(new CiscoRouter('R1'));
    expect(await r.executeCommand('enable secret 0 plainpw')).toBe('');
    expect(await r.executeCommand('do show running-config')).toMatch(/enable secret/);
  });
});
