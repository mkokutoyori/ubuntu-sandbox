import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
});

const INVALID = "% Invalid input detected at '^' marker.";
const INCOMPLETE = '% Incomplete command.';

async function sw(): Promise<CiscoSwitch> {
  const s = new CiscoSwitch('Switch1');
  await s.executeCommand('enable');
  return s;
}

function isOn(s: CiscoSwitch): boolean {
  return (s as unknown as { isPoweredOn: boolean }).isPoweredOn;
}

describe('Cisco switch reload — scheduling does not power off immediately', () => {
  it('reload in <minutes> schedules and keeps the switch powered on', async () => {
    const s = await sw();
    expect(await s.executeCommand('reload in 5')).toContain('Reload scheduled in 5 minutes');
    expect(isOn(s)).toBe(true);
    expect(await s.executeCommand('show reload')).toMatch(/Reload scheduled in [45] minutes/);
  });

  it('reload cancel clears the pending reload', async () => {
    const s = await sw();
    await s.executeCommand('reload in 5');
    expect(await s.executeCommand('reload cancel')).toContain('Reload cancelled');
    expect(await s.executeCommand('show reload')).toBe('No reload is scheduled.');
    expect(isOn(s)).toBe(true);
  });

  it('reload in with a bad or missing argument never triggers an accidental reload', async () => {
    const s = await sw();
    expect(await s.executeCommand('reload in abc')).toBe(INVALID);
    expect(await s.executeCommand('reload in')).toBe(INCOMPLETE);
    expect(await s.executeCommand('reload at')).toBe(INCOMPLETE);
    expect(isOn(s)).toBe(true);
  });

  it('bare reload restarts the switch', async () => {
    const s = await sw();
    expect(await s.executeCommand('reload')).toContain('System restarting');
    expect(isOn(s)).toBe(true);
  });
});
