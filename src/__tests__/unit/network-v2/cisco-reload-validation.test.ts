import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

describe('Cisco reload — argument validation (no accidental immediate reload)', () => {
  it('reload in <non-numeric> is rejected, not an immediate reload', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(await r.executeCommand('reload in abc')).toBe("% Invalid input detected at '^' marker.");
    expect(await r.executeCommand('reload in')).toBe('% Incomplete command.');
    expect(await r.executeCommand('reload at')).toBe('% Incomplete command.');
  });

  it('valid reload forms are accepted', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    expect(await r.executeCommand('reload in 5')).toContain('Reload scheduled in 5 minutes');
    expect(await r.executeCommand('reload cancel')).toContain('Reload cancelled');
    expect(await r.executeCommand('reload')).toContain('Reload requested');
  });
});
