/**
 * Unit tests for cmdlets / cmd builtins added after the debug-output sweep:
 *
 *  - Get-Alias       → was 'not recognized'; now enumerates the registry's
 *                      aliases (with -Name wildcard support).
 *  - Get-PSProvider  → was 'not recognized'; now returns the standard six
 *                      built-in providers.
 *  - vol, chcp       → were 'not recognized' on cmd; now produce
 *                      cmd-style output via WindowsPC.executeCmdCommand
 *                      AND surface as PS native shims so typing `vol` /
 *                      `chcp` works on the PS prompt too.
 *  - date /t, time /t → cmd-only built-ins; produce en-US strings.
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

describe('Get-Alias', () => {
  it('returns a table of registered aliases', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await execPS(pc, 'Get-Alias');
    expect(out).toContain('Name');
    expect(out).toContain('Definition');
    expect(out).toContain('CommandType');
    expect(out).toMatch(/\bls\b/);
    expect(out).toMatch(/\bdir\b/);
    expect(out).toMatch(/\bgcm\b/);
    expect(out).toMatch(/\bgsv\b/);
  });

  it('Get-Alias -Name <name> returns just the matching alias', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await execPS(pc, 'Get-Alias -Name "ls"');
    expect(out).toContain('ls');
    expect(out).toMatch(/get-childitem/i);
  });

  it('Get-Alias supports wildcards (quoted)', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await execPS(pc, 'Get-Alias -Name "gc*"');
    expect(out).toMatch(/\bgcm\b/);
  });

  it('emits an error for an unknown alias', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await execPS(pc, 'Get-Alias zzzz');
    expect(out).toMatch(/Cannot find alias/i);
  });
});

describe('Get-PSProvider', () => {
  it('returns the six built-in providers', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await execPS(pc, 'Get-PSProvider');
    expect(out).toContain('FileSystem');
    expect(out).toContain('Registry');
    expect(out).toContain('Environment');
    expect(out).toContain('Variable');
    expect(out).toContain('Alias');
    expect(out).toContain('Function');
  });

  it('filters by name with wildcards', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await execPS(pc, 'Get-PSProvider FileSystem');
    expect(out).toContain('FileSystem');
    expect(out).not.toContain('Registry');
  });
});

describe('vol — cmd builtin + PS shim', () => {
  it('cmd: vol prints "Volume in drive C ..."', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await pc.executeCmdCommand('vol C:');
    expect(out).toContain('Volume in drive C has no label.');
    expect(out).toMatch(/Volume Serial Number is [0-9A-F]{4}-[0-9A-F]{4}/);
  });

  it('ps: vol surfaces the same output', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await execPS(pc, 'vol');
    expect(out).toContain('Volume in drive C has no label.');
    expect(out).toMatch(/Volume Serial Number is [0-9A-F]{4}-[0-9A-F]{4}/);
  });

  it('the serial is deterministic for a given hostname', async () => {
    const a = new WindowsPC('windows-pc', 'STABLE');
    const b = new WindowsPC('windows-pc', 'STABLE');
    expect(await a.executeCmdCommand('vol')).toBe(await b.executeCmdCommand('vol'));
  });
});

describe('chcp — cmd builtin + PS shim', () => {
  it('cmd: chcp defaults to 65001', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    expect(await pc.executeCmdCommand('chcp')).toBe('Active code page: 65001');
  });

  it('cmd: chcp 1252 reports the requested page', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    expect(await pc.executeCmdCommand('chcp 1252')).toBe('Active code page: 1252');
  });

  it('ps: chcp surfaces the same output', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    expect(await execPS(pc, 'chcp')).toBe('Active code page: 65001');
  });
});

describe('date /t and time /t — cmd builtins', () => {
  it('date /t prints "Dow MM/DD/YYYY"', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await pc.executeCmdCommand('date /t');
    expect(out).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}\/\d{2}\/\d{4}$/);
  });

  it('time /t prints "h:mm AM/PM" (en-US)', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN');
    pc.setCurrentUser('Administrator');
    const out = await pc.executeCmdCommand('time /t');
    expect(out).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });
});
