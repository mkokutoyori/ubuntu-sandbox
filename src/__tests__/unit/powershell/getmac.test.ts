/**
 * Tests for the `getmac` Windows builtin (regression captured in
 * debug-output/ps-network-server_results_debug.txt where
 * `getmac` reported `not recognized`). Migrated to use the
 * interpreter via PowerShellSubShell.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createShell(type: 'windows-pc' | 'windows-server' = 'windows-pc'): PowerShellSubShell {
  const pc = new WindowsPC(type, 'WIN-MAC');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}

async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

describe('getmac — Windows builtin', () => {
  it('is recognized (no "not recognized" error)', async () => {
    const out = await run(createShell(), 'getmac');
    expect(out).not.toContain('not recognized');
  });

  it('renders a header with "Physical Address" and "Transport Name"', async () => {
    const out = await run(createShell(), 'getmac');
    expect(out).toContain('Physical Address');
    expect(out).toContain('Transport Name');
  });

  it('shows MAC addresses for each adapter (XX-XX-... form)', async () => {
    const out = await run(createShell(), 'getmac');
    expect(out).toMatch(/[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}/);
  });

  it('/V adds the Connection Name column', async () => {
    const out = await run(createShell(), 'getmac /v');
    expect(out).toContain('Connection Name');
    expect(out).toContain('Network Adapter');
  });

  it('/FO csv emits comma-separated header', async () => {
    const out = await run(createShell(), 'getmac /fo csv');
    expect(out.split('\n')[0]).toContain(',');
    expect(out).toContain('"Physical Address"');
  });

  it('/NH suppresses the header line', async () => {
    const out = await run(createShell(), 'getmac /nh');
    expect(out).not.toContain('Physical Address');
    expect(out).toMatch(/[0-9A-F]{2}-[0-9A-F]{2}-[0-9A-F]{2}/);
  });

  it('/? prints help', async () => {
    const out = await run(createShell(), 'getmac /?');
    expect(out).toContain('GETMAC');
    expect(out).toContain('/FO');
  });

  it('works on windows-server type too', async () => {
    const out = await run(createShell('windows-server'), 'getmac');
    expect(out).toContain('Physical Address');
  });
});
