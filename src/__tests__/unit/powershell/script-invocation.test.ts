/**
 * Invoke a script with `& script.ps1` / `. script.ps1`.
 *
 * Bug from debug-output/ps-scripts_results_debug.txt:
 *     PS> & C:\Scripts\hello.ps1 PowerShell
 *       & : The term 'C:\Scripts\hello.ps1' is not recognized ...
 * Migrated to use PowerShellSubShell.
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
  const pc = new WindowsPC('windows-pc', 'WIN-SCR');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}
async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

describe('& <script.ps1> — call operator', () => {
  it('runs a single-statement script with no params', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path C:\\Sc -ItemType Directory -Force');
    await run(sh, 'Set-Content -Path C:\\Sc\\hi.ps1 -Value \'"hello from script"\'');
    const out = await run(sh, '& C:\\Sc\\hi.ps1');
    expect(out).toContain('hello from script');
    expect(out).not.toContain('not recognized');
  });

  it('passes -Name value to a param() block', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path C:\\Sc -ItemType Directory -Force');
    const script = 'param([string]$Name = "world")\n"Hello, $Name!"';
    await run(sh,
      `Set-Content -Path C:\\Sc\\greet.ps1 -Value '${script.replace(/'/g, "''")}'`,
    );
    const out = await run(sh, '& C:\\Sc\\greet.ps1 -Name Alice');
    expect(out).toContain('Hello, Alice');
  });

  it('reports a useful error for a non-existent script', async () => {
    const out = await run(createShell(), '& C:\\NoSuchDir\\absent.ps1');
    expect(out).toContain('not recognized');
  });
});

describe('. <script.ps1> — dot-source', () => {
  it('runs the script body', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path C:\\Sc -ItemType Directory -Force');
    await run(sh, 'Set-Content -Path C:\\Sc\\say.ps1 -Value \'"dot-sourced"\'');
    const out = await run(sh, '. C:\\Sc\\say.ps1');
    expect(out).toContain('dot-sourced');
    expect(out).not.toContain('not recognized');
  });

  it('registers a function declared in the script into the caller scope', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path C:\\Sc -ItemType Directory -Force');
    const body = 'function Get-Greeting { param([string]$Who = "world") "Hello, $Who!" }';
    await run(sh,
      `Set-Content -Path C:\\Sc\\fn.ps1 -Value '${body.replace(/'/g, "''")}'`,
    );
    await run(sh, '. C:\\Sc\\fn.ps1');
    const out = await run(sh, 'Get-Greeting -Who Alice');
    expect(out).toContain('Hello, Alice!');
  });
});

describe('script param binding', () => {
  it('declared params are visible inside the script body', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path C:\\Sc -ItemType Directory -Force');
    const script = 'param([string]$Prefix = "auto")\n"prefix=$Prefix"';
    await run(sh,
      `Set-Content -Path C:\\Sc\\p.ps1 -Value '${script.replace(/'/g, "''")}'`,
    );
    const out1 = await run(sh, '& C:\\Sc\\p.ps1');
    expect(out1).toContain('prefix=auto');
    const out2 = await run(sh, '& C:\\Sc\\p.ps1 -Prefix dbg');
    expect(out2).toContain('prefix=dbg');
  });
});
