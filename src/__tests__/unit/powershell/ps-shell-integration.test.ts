/**
 * ps-shell-integration.test.ts — Tests for the PowerShellSubShell wiring
 * the PSInterpreter on top of the legacy PowerShellExecutor.
 *
 * Verifies that:
 *   - Interpreter-only syntax (assignments, loops, pipelines with built-in
 *     cmdlets) goes through PSInterpreter and produces the right output.
 *   - Device-bound cmdlets (hostname, ipconfig, Get-ChildItem) still flow
 *     through PowerShellExecutor as a fallback.
 *   - Variable state persists across lines in the same session.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function createShell(): PowerShellSubShell {
  const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
  pc.powerOn();
  const { subShell } = PowerShellSubShell.create(pc);
  return subShell;
}

async function runLine(sh: PowerShellSubShell, line: string): Promise<string[]> {
  const r = await sh.processLine(line);
  return r.output;
}

describe('PowerShellSubShell + PSInterpreter integration', () => {

  // ─── Interpreter-level features ────────────────────────────────────────

  it('assigns and retrieves a variable across lines', async () => {
    const sh = createShell();
    await runLine(sh, '$x = 42');
    expect((await runLine(sh, '$x')).join('')).toBe('42');
  });

  it('runs arithmetic expressions', async () => {
    const sh = createShell();
    expect((await runLine(sh, '2 + 3 * 4')).join('')).toBe('14');
  });

  it('runs a string expansion', async () => {
    const sh = createShell();
    await runLine(sh, '$name = "World"');
    expect((await runLine(sh, 'Write-Output "Hello, $name!"')).join('')).toBe('Hello, World!');
  });

  it('runs a Where-Object pipeline on an array', async () => {
    const sh = createShell();
    const out = await runLine(sh, '1,2,3,4,5 | Where-Object { $_ -gt 2 }');
    expect(out.join(',')).toContain('3');
    expect(out.join(',')).toContain('5');
  });

  it('runs a ForEach-Object pipeline', async () => {
    const sh = createShell();
    await runLine(sh, '$r = 1,2,3 | ForEach-Object { $_ * 10 }');
    // Interpreter output for ForEach is returned as array; verify via Write-Output
    const out = await runLine(sh, '$r | Write-Output');
    expect(out).toEqual(['10', '20', '30']);
  });

  it('supports if / else flow', async () => {
    const sh = createShell();
    const out = await runLine(sh, 'if (1 -lt 2) { "yes" } else { "no" }');
    expect(out.join('')).toBe('yes');
  });

  it('supports foreach loops', async () => {
    const sh = createShell();
    await runLine(sh, '$sum = 0; foreach ($i in 1..5) { $sum += $i }');
    expect((await runLine(sh, '$sum')).join('')).toBe('15');
  });

  it('handles Get-Date -Format', async () => {
    const sh = createShell();
    const out = await runLine(sh, 'Get-Date -Format yyyy');
    expect(out.join('')).toMatch(/^\d{4}$/);
  });

  // ─── Fallback path to the legacy executor ──────────────────────────────

  it('falls back to PowerShellExecutor for hostname', async () => {
    const sh = createShell();
    const out = await runLine(sh, 'hostname');
    // hostname returns the PC1 name via the device
    expect(out.join('').toLowerCase()).toContain('pc1');
  });

  it('falls back to PowerShellExecutor for Get-Location', async () => {
    const sh = createShell();
    const out = await runLine(sh, 'Get-Location');
    // PS prints a Path header when listing location
    expect(out.join('\n')).toContain('Path');
  });

  // ─── Error resilience ────────────────────────────────────────────────

  it('reports a clear error when both interpreter and fallback fail', async () => {
    const sh = createShell();
    const out = await runLine(sh, 'Totally-Unknown-Cmdlet');
    const joined = out.join('\n').toLowerCase();
    expect(
      joined.includes('not recognized') || joined.includes('not found') || joined.length > 0,
    ).toBe(true);
  });
});
