/**
 * Regression tests for the command-argument bareword fix.
 *
 * Bug captured from debug-output/ps-users-groups-*_results_debug.txt:
 *
 *     PS> Get-Alias ls
 *     Cannot find alias because alias with name 'Name=...; FullName=...;
 *     Length=; Mode=d-----; ...
 *
 * Root cause: in command-argument position, a bare WORD token was being
 * parsed as a `CommandExpression` and dispatched as a nested cmdlet call.
 * For `Get-Alias ls`, the inner `ls` (alias of Get-ChildItem) would be
 * executed and the first directory entry's stringified properties were
 * fed back into Get-Alias as the alias name.
 *
 * Real PowerShell treats bare words in command-argument position as
 * string literals. The fix in PSParser.parseCommandArgumentAtom() now
 * mirrors that behavior — WORD tokens become string literals unless
 * they're followed by a postfix operator (., [, (, ++, --).
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

async function execPS(pc: WindowsPC, line: string): Promise<string> {
  const { subShell } = PowerShellSubShell.create(pc);
  const r = await subShell.processLine(line);
  return r.output.join('\n');
}

describe('Parser — barewords in command-argument position', () => {
  it('Get-Alias ls — unquoted positional matches the alias (not the cmdlet behind it)', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await execPS(pc, 'Get-Alias ls');
    // Should look up the alias "ls", not execute Get-ChildItem
    expect(out).toContain('ls');
    expect(out).toMatch(/get-childitem/i);
    expect(out).not.toMatch(/Cannot find alias/i);
  });

  it('Get-Alias dir — same path for another well-known alias', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await execPS(pc, 'Get-Alias dir');
    expect(out).toContain('dir');
    expect(out).toMatch(/get-childitem/i);
  });

  it('Get-Alias unknownalias — emits an alias-not-found error, no crash', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await execPS(pc, 'Get-Alias zzzznotreal');
    expect(out).toMatch(/Cannot find alias/i);
  });

  it('Format-Table Name, Status — positional comma-list builds a property array', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await execPS(pc,
      'Get-Service | Select-Object -First 2 | Format-Table Name, Status'
    );
    expect(out).toContain('Name');
    expect(out).toContain('Status');
    // Original Get-Service columns shouldn't leak in when we filtered to two
    expect(out).not.toContain('DisplayName');
  });

  it('Format-List Name, Id, CPU — positional list for Format-List too', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await execPS(pc,
      'Get-Process | Select-Object -First 1 | Format-List Name, Id, CPU'
    );
    expect(out).toMatch(/Name\s*:/);
    expect(out).toMatch(/Id\s*:/);
    expect(out).toMatch(/CPU\s*:/);
  });

  it('Variables still parse as expressions (not strings) in arg position', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const { subShell } = PowerShellSubShell.create(pc);
    await subShell.processLine('$svc = "Spooler"');
    const r = await subShell.processLine('Get-Service $svc');
    const out = r.output.join('\n');
    expect(out).toContain('Spooler');
  });

  it('Member-access expressions still parse correctly in arg position', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const { subShell } = PowerShellSubShell.create(pc);
    await subShell.processLine('$h = @{ k = "Spooler" }');
    const r = await subShell.processLine('Get-Service $h.k');
    const out = r.output.join('\n');
    expect(out).toContain('Spooler');
  });
});
