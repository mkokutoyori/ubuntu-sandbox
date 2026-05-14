/**
 * Tests for the `getmac` Windows builtin (regression captured in
 * debug-output/ps-network-server_results_debug.txt where
 * `getmac` reported `not recognized`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createPS(type: 'windows-pc' | 'windows-server' = 'windows-pc'): PowerShellExecutor {
  const pc = new WindowsPC(type, 'WIN-MAC');
  pc.setCurrentUser('Administrator');
  return new PowerShellExecutor(pc);
}

describe('getmac — Windows builtin', () => {
  it('is recognized (no "not recognized" error)', async () => {
    const ps = createPS();
    const out = await ps.execute('getmac');
    expect(out).not.toContain('not recognized');
  });

  it('renders a header with "Physical Address" and "Transport Name"', async () => {
    const ps = createPS();
    const out = await ps.execute('getmac');
    expect(out).toContain('Physical Address');
    expect(out).toContain('Transport Name');
  });

  it('shows MAC addresses for each adapter (XX-XX-... form)', async () => {
    const ps = createPS();
    const out = await ps.execute('getmac');
    expect(out).toMatch(/[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}/);
  });

  it('/V adds the Connection Name column', async () => {
    const ps = createPS();
    const out = await ps.execute('getmac /v');
    expect(out).toContain('Connection Name');
    expect(out).toContain('Network Adapter');
  });

  it('/FO csv emits comma-separated header', async () => {
    const ps = createPS();
    const out = await ps.execute('getmac /fo csv');
    expect(out.split('\n')[0]).toContain(',');
    expect(out).toContain('"Physical Address"');
  });

  it('/NH suppresses the header line', async () => {
    const ps = createPS();
    const out = await ps.execute('getmac /nh');
    expect(out).not.toContain('Physical Address');
    expect(out).toMatch(/[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}/);
  });

  it('/? prints help', async () => {
    const ps = createPS();
    const out = await ps.execute('getmac /?');
    expect(out).toContain('GETMAC');
    expect(out).toContain('/FO');
  });

  it('works on windows-server type too', async () => {
    const ps = createPS('windows-server');
    const out = await ps.execute('getmac');
    expect(out).toContain('Physical Address');
  });
});
