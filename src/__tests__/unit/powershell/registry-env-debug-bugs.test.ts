/**
 * Regression tests for bugs captured in
 * `debug-output/ps-registry-env_results_debug.txt`.
 *
 * Bug A — Remove-ItemProperty does not strip surrounding quotes from
 *         the `-Name` argument, so `-Name "Enabled"` ends up looking up
 *         the literal property `"Enabled"` (with the quotes) and emits
 *         `Property '"Enabled"' does not exist`.
 *
 * Bug B — Remove-Item Env:VAR fails with "Cannot find path
 *         'Env:VAR' because it does not exist" even when the variable
 *         was just set with Set-Item Env:VAR.
 *
 * Bug C — Remove-ItemProperty is case-sensitive on `-Path` / `-Name`
 *         where Set-ItemProperty is not (asymmetric API).
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
  const pc = new WindowsPC('windows-pc', 'WIN-DBG-REG');
  pc.setCurrentUser('Administrator');
  return new PowerShellExecutor(pc);
}

describe('Remove-ItemProperty — debug regressions', () => {
  it('strips surrounding double quotes from -Name', async () => {
    const ps = createPS();
    await ps.execute('New-Item -Path HKCU:\\Software\\Probe -Force');
    await ps.execute('Set-ItemProperty -Path HKCU:\\Software\\Probe -Name "Enabled" -Value 1 -Type DWord');
    const out = await ps.execute('Remove-ItemProperty -Path HKCU:\\Software\\Probe -Name "Enabled"');
    expect(out).not.toContain('does not exist');
    const after = await ps.execute('Get-ItemProperty -Path HKCU:\\Software\\Probe');
    expect(after).not.toContain('Enabled');
  });

  it('strips surrounding single quotes from -Name', async () => {
    const ps = createPS();
    await ps.execute('New-Item -Path HKCU:\\Software\\Probe -Force');
    await ps.execute("Set-ItemProperty -Path HKCU:\\Software\\Probe -Name 'Tag' -Value 'beta'");
    const out = await ps.execute("Remove-ItemProperty -Path HKCU:\\Software\\Probe -Name 'Tag'");
    expect(out).not.toContain('does not exist');
  });

  it('accepts lowercase -path / -name flags (case-insensitive)', async () => {
    const ps = createPS();
    await ps.execute('New-Item -Path HKCU:\\Software\\Probe -Force');
    await ps.execute('Set-ItemProperty -Path HKCU:\\Software\\Probe -Name Lower -Value 1 -Type DWord');
    const out = await ps.execute('Remove-ItemProperty -path HKCU:\\Software\\Probe -name Lower');
    expect(out).not.toContain('does not exist');
  });
});

describe('Remove-Item Env: — debug regression', () => {
  it('removes a session-scope environment variable previously set with Set-Item', async () => {
    const ps = createPS();
    await ps.execute('Set-Item -Path Env:DBG_LBL -Value "first"');
    const before = await ps.execute('$env:DBG_LBL');
    expect(before.trim()).toBe('first');
    const remOut = await ps.execute('Remove-Item Env:DBG_LBL');
    expect(remOut).not.toContain('Cannot find path');
    const after = await ps.execute('$env:DBG_LBL');
    expect(after.trim()).toBe('');
  });

  it('Remove-Item Env:VAR is idempotent on missing variables', async () => {
    const ps = createPS();
    const out = await ps.execute('Remove-Item Env:GHOST -ErrorAction SilentlyContinue');
    // Either silent success or a benign message — but never crash.
    expect(out === null || typeof out === 'string').toBe(true);
  });
});
