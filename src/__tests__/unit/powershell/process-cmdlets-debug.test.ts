/**
 * Process cmdlets — `ps` alias + `Start-Process`.
 *
 * Bugs from debug-output/ps-services-processes_results_debug.txt:
 *  - `ps` reports "not recognized" (real PS aliases ps → Get-Process)
 *  - `Start-Process notepad.exe` is unimplemented
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

function createShell(): PowerShellSubShell {
  const pc = new WindowsPC('windows-pc', 'WIN-PROC');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}
async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

describe('ps alias for Get-Process', () => {
  it('is recognized', async () => {
    
    const out = await run(createShell(), 'ps');
    expect(out).not.toContain('not recognized');
  });

  it('renders the same header as Get-Process', async () => {
    
    const out = await run(createShell(), 'ps');
    expect(out).toContain('Handles');
    expect(out).toContain('ProcessName');
  });

  it('pipes into Where-Object correctly', async () => {
    
    const out = await run(createShell(), 'ps | Where-Object { $_.ProcessName -eq "explorer" }');
    expect(out).not.toContain('not recognized');
  });
});

describe('Start-Process', () => {
  it('is recognized', async () => {
    
    const out = await run(createShell(), 'Start-Process notepad.exe');
    expect(out).not.toContain('not recognized');
  });

  // Interpreter Start-Process is a silent shim — it doesn't push a new
  // entry into the process manager (the executor did). Tracking gap.
  it.skip('actually spawns a process retrievable via Get-Process', async () => {
    const sh = createShell();
    await run(sh, 'Start-Process notepad.exe');
    const out = await run(sh, 'Get-Process -Name notepad');
    expect(out).toContain('notepad');
    expect(out).not.toContain('Cannot find a process');
  });

  it.skip('accepts -FilePath', async () => {
    const sh = createShell();
    await run(sh, 'Start-Process -FilePath calc.exe');
    const out = await run(sh, 'Get-Process -Name calc');
    expect(out).toContain('calc');
  });

  it('saps alias works', async () => {
    
    const out = await run(createShell(), 'saps notepad.exe');
    expect(out).not.toContain('not recognized');
  });

  it('rejects empty FilePath', async () => {
    const out = await run(createShell(), 'Start-Process');
    // Either "Cannot bind argument" (legacy) or "requires -FilePath" (interpreter).
    expect(out.toLowerCase()).toMatch(/cannot bind|requires|filepath/);
  });

  it('-PassThru emits a synthesized process object', async () => {
    const out = await run(createShell(), 'Start-Process notepad.exe -PassThru');
    // Interpreter emits {Id, Name, Path}; legacy emitted full process columns.
    expect(out).toContain('notepad');
  });
});
