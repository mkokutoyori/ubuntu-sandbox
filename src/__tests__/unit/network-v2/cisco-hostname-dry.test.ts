import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

describe('Cisco hostname — single shared handler (router and switch consistent)', () => {
  it('router hostname updates hostname, name and prompt', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('hostname Edge1')).toBe('');
    expect(r.getHostname()).toBe('Edge1');
    expect(r.name).toBe('Edge1');
    expect(r.getPrompt()).toBe('Edge1(config)#');
  });

  it('switch hostname behaves identically (same base handler)', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SW1', 4);
    await s.executeCommand('enable');
    await s.executeCommand('configure terminal');
    expect(await s.executeCommand('hostname Access1')).toBe('');
    expect(s.getHostname()).toBe('Access1');
    expect(s.name).toBe('Access1');
  });

  it('hostname with no argument is incomplete', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    await r.executeCommand('configure terminal');
    expect(await r.executeCommand('hostname')).toBe('% Incomplete command.');
  });
});
