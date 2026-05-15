/**
 * Regression test: -not and -bnot at the start of a statement parse as
 * unary expressions, not as parameters to a non-existent `not` cmdlet.
 *
 * Bug captured from debug-output/ps-scripts-*_results_debug.txt:
 *
 *     Where-Object { -not $_.PSIsContainer }
 *
 * Inside the scriptblock body, `-not` was lexed as a PARAMETER token and
 * the parser turned it into a Command head named "not". The runtime then
 * tried to dispatch a "not" cmdlet and threw "not recognized".
 *
 * parseCommandName now treats PARAMETER tokens whose name is `not` or
 * `bnot` at command-head position as unary expressions, matching the
 * existing handling deeper in parseUnaryExpression().
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

describe('Parser — unary operators at statement start', () => {
  it('-not $true → False', async () => {
    const out = await exec('-not $true');
    expect(out.trim()).toBe('False');
  });

  it('-not $false → True', async () => {
    const out = await exec('-not $false');
    expect(out.trim()).toBe('True');
  });

  it('Where-Object { -not $_.PSIsContainer } filters out directories', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const { subShell } = PowerShellSubShell.create(pc);
    await subShell.processLine('New-Item -Path C:\\T -ItemType Directory -Force | Out-Null');
    await subShell.processLine('Set-Content -Path C:\\T\\a.txt -Value 1');
    await subShell.processLine('Set-Content -Path C:\\T\\b.txt -Value 22');
    await subShell.processLine('New-Item -Path C:\\T\\sub -ItemType Directory -Force | Out-Null');
    const r = await subShell.processLine(
      'Get-ChildItem C:\\T | Where-Object { -not $_.PSIsContainer } | Select-Object -Property Name'
    );
    const out = r.output.join('\n');
    expect(out).toContain('a.txt');
    expect(out).toContain('b.txt');
    expect(out).not.toContain('sub');
    expect(out).not.toMatch(/not recognized/i);
  });
});
