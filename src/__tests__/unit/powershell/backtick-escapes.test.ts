/**
 * Backtick (` ) escape sequences inside double-quoted strings.
 *
 * Bug from debug-output/ps-scripts_results_debug.txt:
 *
 *     PS> Set-Content -Path C:\Scripts\hello.ps1 -Value "`$name = ...`n..."
 *     PS> Get-Content C:\Scripts\hello.ps1
 *       `$name = ...
 *
 * The simulator stored the backtick sequences literally instead of
 * translating `` `n `` → newline, `` `$ `` → literal dollar (no
 * variable expansion), `` `" `` → literal quote, etc. Scripts written
 * via Set-Content ended up corrupted.
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
  return PowerShellSubShell.create(new WindowsPC('windows-pc', 'WIN-ESC')).subShell;
}
async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

describe('backtick escapes — Write-Output', () => {
  it('`n produces a newline', async () => {
    const out = await run(createShell(), 'Write-Output "line1`nline2"');
    expect(out).toContain('line1\nline2');
  });

  it('`t produces a tab', async () => {
    const out = await run(createShell(), 'Write-Output "a`tb"');
    expect(out).toContain('a\tb');
  });

  it('`$ keeps a literal dollar sign without expansion', async () => {
    const sh = createShell();
    await run(sh, '$x = 99');
    const out = await run(sh, 'Write-Output "literal `$x has value $x"');
    expect(out).toContain('literal $x has value 99');
  });

  it('`" produces a literal double quote', async () => {
    const out = await run(createShell(), 'Write-Output "say `"hi`""');
    expect(out).toContain('say "hi"');
  });

  it('`` is a literal backtick', async () => {
    const out = await run(createShell(), 'Write-Output "back``tick"');
    expect(out).toContain('back`tick');
  });
});

describe('backtick escapes — Set-Content round-trip', () => {
  it('Set-Content + Get-Content preserves a multi-line value', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path C:\\esc -ItemType Directory -Force');
    await run(sh, 'Set-Content -Path C:\\esc\\multi.txt -Value "alpha`nbeta`ngamma"');
    const out = await run(sh, 'Get-Content C:\\esc\\multi.txt');
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
    expect(out).toContain('gamma');
    expect(out).not.toContain('`n');
  });
});
