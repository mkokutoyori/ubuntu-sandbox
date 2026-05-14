/**
 * .ps1 script invocation via `&` (call operator) and `.` (dot-source).
 *
 * Bugs captured in debug-output/ps-scripts_results_debug.txt where
 *   & C:\\Scripts\\hello.ps1
 *   . C:\\Scripts\\hello.ps1
 * both fail with "term '&' / '.' is not recognized".
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
  const pc = new WindowsPC('windows-pc', 'WIN-SCR');
  pc.setCurrentUser('Administrator');
  return new PowerShellExecutor(pc);
}

describe('& <script.ps1> — call operator', () => {
  it('runs a single-statement script with no params', async () => {
    const ps = createPS();
    await ps.execute('New-Item -Path C:\\Sc -ItemType Directory -Force');
    await ps.execute('Set-Content -Path C:\\Sc\\hi.ps1 -Value \'"hello from script"\'');
    const out = await ps.execute('& C:\\Sc\\hi.ps1');
    expect(out).toContain('hello from script');
    expect(out).not.toContain('not recognized');
  });

  it('passes -Name value to a param() block', async () => {
    const ps = createPS();
    await ps.execute('New-Item -Path C:\\Sc -ItemType Directory -Force');
    const script = 'param([string]$Name = "world")\n"Hello, $Name!"';
    await ps.execute(
      `Set-Content -Path C:\\Sc\\greet.ps1 -Value '${script.replace(/'/g, "''")}'`,
    );
    const out = await ps.execute('& C:\\Sc\\greet.ps1 -Name Alice');
    expect(out).toContain('Hello, Alice');
  });

  it('reports a useful error for a non-existent script', async () => {
    const ps = createPS();
    const out = await ps.execute('& C:\\NoSuchDir\\absent.ps1');
    expect(out).toContain('not recognized');
  });
});

describe('. <script.ps1> — dot-source', () => {
  it('runs the script body', async () => {
    const ps = createPS();
    await ps.execute('New-Item -Path C:\\Sc -ItemType Directory -Force');
    await ps.execute('Set-Content -Path C:\\Sc\\say.ps1 -Value \'"dot-sourced"\'');
    const out = await ps.execute('. C:\\Sc\\say.ps1');
    expect(out).toContain('dot-sourced');
    expect(out).not.toContain('not recognized');
  });
});

describe('script param binding', () => {
  it('declared params are visible inside the script body', async () => {
    const ps = createPS();
    await ps.execute('New-Item -Path C:\\Sc -ItemType Directory -Force');
    const script = 'param([string]$Prefix = "auto")\n"prefix=$Prefix"';
    await ps.execute(
      `Set-Content -Path C:\\Sc\\p.ps1 -Value '${script.replace(/'/g, "''")}'`,
    );
    const out1 = await ps.execute('& C:\\Sc\\p.ps1');
    expect(out1).toContain('prefix=auto');
    const out2 = await ps.execute('& C:\\Sc\\p.ps1 -Prefix dbg');
    expect(out2).toContain('prefix=dbg');
  });
});
