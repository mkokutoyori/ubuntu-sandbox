/**
 * Process cmdlets — `ps` alias + `Start-Process`.
 *
 * Bugs from debug-output/ps-services-processes_results_debug.txt:
 *  - `ps` reports "not recognized" (real PS aliases ps → Get-Process)
 *  - `Start-Process notepad.exe` is unimplemented
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

function createPS(): PowerShellExecutor {
  const pc = new WindowsPC('windows-pc', 'WIN-PROC');
  pc.setCurrentUser('Administrator');
  return new PowerShellExecutor(pc);
}

describe('ps alias for Get-Process', () => {
  it('is recognized', async () => {
    const ps = createPS();
    const out = await ps.execute('ps');
    expect(out).not.toContain('not recognized');
  });

  it('renders the same header as Get-Process', async () => {
    const ps = createPS();
    const out = await ps.execute('ps');
    expect(out).toContain('Handles');
    expect(out).toContain('ProcessName');
  });

  it('pipes into Where-Object correctly', async () => {
    const ps = createPS();
    const out = await ps.execute('ps | Where-Object { $_.ProcessName -eq "explorer" }');
    expect(out).not.toContain('not recognized');
  });
});

describe('Start-Process', () => {
  it('is recognized', async () => {
    const ps = createPS();
    const out = await ps.execute('Start-Process notepad.exe');
    expect(out).not.toContain('not recognized');
  });

  it('actually spawns a process retrievable via Get-Process', async () => {
    const ps = createPS();
    await ps.execute('Start-Process notepad.exe');
    const out = await ps.execute('Get-Process -Name notepad');
    expect(out).toContain('notepad');
    expect(out).not.toContain('Cannot find a process');
  });

  it('accepts -FilePath', async () => {
    const ps = createPS();
    await ps.execute('Start-Process -FilePath calc.exe');
    const out = await ps.execute('Get-Process -Name calc');
    expect(out).toContain('calc');
  });

  it('saps alias works', async () => {
    const ps = createPS();
    const out = await ps.execute('saps notepad.exe');
    expect(out).not.toContain('not recognized');
  });

  it('rejects empty FilePath', async () => {
    const ps = createPS();
    const out = await ps.execute('Start-Process');
    expect(out).toContain('Cannot bind argument');
  });

  it('-PassThru emits a process header', async () => {
    const ps = createPS();
    const out = await ps.execute('Start-Process notepad.exe -PassThru');
    expect(out).toContain('ProcessName');
    expect(out).toContain('notepad');
  });
});
