import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

function createPS(pc: WindowsPC): { execute: (l: string) => Promise<string> } {
  const sh = PowerShellSubShell.create(pc).subShell;
  return { execute: async (l: string) => (await sh.processLine(l)).output.join('\n') };
}

describe('PowerShell background jobs over the simulated clock', () => {
  let pc: WindowsPC;
  let ps: { execute: (l: string) => Promise<string> };
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    pc = new WindowsPC('windows-pc', 'WIN-JOB');
    ps = createPS(pc);
  });

  it('a job with Start-Sleep stays Running until the clock passes it', async () => {
    await ps.execute('$j = Start-Job -ScriptBlock { Start-Sleep -Seconds 5; "done" }');
    expect(await ps.execute('(Get-Job -Id 1).State')).toContain('Running');
    pc.advanceTime(4000);
    expect(await ps.execute('(Get-Job -Id 1).State')).toContain('Running');
    pc.advanceTime(2000);
    expect(await ps.execute('(Get-Job -Id 1).State')).toContain('Completed');
  });

  it('Receive-Job returns the job output', async () => {
    await ps.execute('$j = Start-Job -ScriptBlock { Start-Sleep -Seconds 2; "hello-job" }');
    pc.advanceTime(2000);
    expect(await ps.execute('Receive-Job -Id 1')).toContain('hello-job');
  });

  it('Wait-Job advances the clock to completion and reports Completed', async () => {
    await ps.execute('$j = Start-Job -ScriptBlock { Start-Sleep -Seconds 30; "later" }');
    const before = pc.simulatedNow();
    await ps.execute('Wait-Job -Id 1');
    expect(pc.simulatedNow()).toBeGreaterThanOrEqual(before + 30_000);
    expect(await ps.execute('(Get-Job -Id 1).State')).toContain('Completed');
  });

  it('a job with no sleep completes immediately', async () => {
    await ps.execute('$j = Start-Job -ScriptBlock { "instant" }');
    expect(await ps.execute('(Get-Job -Id 1).State')).toContain('Completed');
  });
});
