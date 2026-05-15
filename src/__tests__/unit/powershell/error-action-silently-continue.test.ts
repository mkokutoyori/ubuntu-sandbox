/**
 * Regression test: -ErrorAction SilentlyContinue / Ignore now suppresses
 * non-terminating errors that cmdlets emit via ctx.emitError() — not just
 * thrown errors.
 *
 * Captured from debug-output/ps-services-processes-*_results_debug.txt:
 *
 *     PS> Get-Process -Name notepad -ErrorAction SilentlyContinue
 *       ERROR: Cannot find a process with the name "notepad".   ← shouldn't show
 *
 * The interpreter only checked -ErrorAction when a cmdlet THREW; cmdlets
 * that emitted errors via emitError() wrote "ERROR: ..." to stdout
 * regardless. buildCmdletContext now wraps emitError so emitted lines
 * are suppressed under -EA SilentlyContinue / Ignore. The error object
 * is still recorded (so $Error / -ErrorVariable see it).
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
});

async function exec(line: string): Promise<string> {
  const pc = new WindowsPC('windows-pc', 'WIN');
  pc.setCurrentUser('Administrator');
  const { subShell } = PowerShellSubShell.create(pc);
  const r = await subShell.processLine(line);
  return r.output.join('\n');
}

describe('-ErrorAction SilentlyContinue / Ignore', () => {
  it('Get-Process -Name <missing> -EA SilentlyContinue → no ERROR line', async () => {
    const out = await exec('Get-Process -Name notepad -ErrorAction SilentlyContinue');
    expect(out).not.toMatch(/^ERROR:/m);
    expect(out).not.toMatch(/Cannot find a process/i);
  });

  it('Get-Process -Name <missing> -EA Ignore → no ERROR line', async () => {
    const out = await exec('Get-Process -Name notepad -ErrorAction Ignore');
    expect(out).not.toMatch(/^ERROR:/m);
  });

  it('Get-Process -Name <missing> (no -EA) → ERROR line visible (default Continue)', async () => {
    const out = await exec('Get-Process -Name notepad');
    expect(out).toMatch(/Cannot find a process/i);
  });

  it('-ErrorVariable still captures the suppressed error', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const { subShell } = PowerShellSubShell.create(pc);
    const r1 = await subShell.processLine(
      'Get-Process -Name notepad -ErrorAction SilentlyContinue -ErrorVariable ev'
    );
    // Stream silent
    expect(r1.output.join('\n')).not.toMatch(/Cannot find a process/i);
    // But $ev contains the error message
    const r2 = await subShell.processLine('$ev.Exception.Message');
    expect(r2.output.join('\n')).toMatch(/Cannot find a process/i);
  });
});
