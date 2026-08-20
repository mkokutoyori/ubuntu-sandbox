/**
 * Regression guard for PowerShellSubShell.fallbackHits (audit rapport 06,
 * constat MAJEUR — dette technique) : the counter measuring how much
 * traffic still falls through to the legacy PowerShellExecutor exists,
 * but nothing in CI ever reads it. A future change that silently breaks
 * some cmdlet in the new interpreter (throwing a "not recognized"-style
 * error) would recover invisibly via the legacy safety net — the
 * migration would look intact while real behavior quietly regressed.
 *
 * This test drives a broad, representative sample of ordinary cmdlets
 * (deliberately excluding ping/tracert, the one intentional, documented
 * bypass) and asserts none of them trip the fallback. If this test ever
 * fails, whatever command was added/changed just started silently
 * routing through legacy PowerShellExecutor instead of the interpreter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  PowerShellSubShell.fallbackHits = 0;
});

const REPRESENTATIVE_COMMANDS = [
  // Process / service cmdlets
  'Get-Process',
  'Get-Process -Name notepad',
  'Get-Service',
  'Get-Service -Name Spooler',
  // Filesystem cmdlets
  'Get-ChildItem C:\\',
  'Get-Item C:\\Windows',
  'Set-Location C:\\Windows',
  'Get-Location',
  'Set-Location C:\\',
  // Misc core cmdlets
  'Get-Alias',
  'Get-Alias -Name gci',
  'Get-Command Get-Process',
  'Write-Output hello',
  // Variables, expressions, pipelines
  '$x = 1; $x',
  '1..3 | ForEach-Object { $_ }',
  'Get-Process | Where-Object { $_.Id -gt 0 } | Select-Object -First 1',
  'Get-Service | Sort-Object Name | Select-Object -First 1',
  // Network cmdlets that are real ICmdlets post-migration (not ping/tracert)
  'ipconfig',
  'Get-NetAdapter',
];

describe('PowerShellSubShell.fallbackHits — migration regression guard', () => {
  it('a broad sweep of ordinary cmdlets never falls back to the legacy engine', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const { subShell } = PowerShellSubShell.create(pc);

    for (const cmd of REPRESENTATIVE_COMMANDS) {
      await subShell.processLine(cmd);
    }

    expect(PowerShellSubShell.fallbackHits).toBe(0);
  });

  it('sanity check: the intentionally-bypassed ping DOES increment the counter', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const { subShell } = PowerShellSubShell.create(pc);

    await subShell.processLine('ping 127.0.0.1');

    // Proves the counter itself is wired correctly — the sweep above
    // asserting 0 is meaningful, not a tautology from a broken counter.
    expect(PowerShellSubShell.fallbackHits).toBeGreaterThan(0);
  });
});
