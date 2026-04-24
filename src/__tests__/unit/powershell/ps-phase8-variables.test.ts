/**
 * ps-phase8-variables.test.ts — TDD tests for Phase 8 missing features.
 *
 * Covers:
 *   - Missing env vars: APPDATA, LOCALAPPDATA, ProgramFiles, ProgramData,
 *     PATHEXT, NUMBER_OF_PROCESSORS
 *   - Missing auto vars: $HOME, $PSHOME, $PROFILE, $ErrorActionPreference,
 *     $VerbosePreference, $DebugPreference, $WarningPreference, $PSScriptRoot,
 *     $PSCommandPath, $LASTEXITCODE, $?
 *   - Write-Error, Write-Warning, Write-Verbose, Write-Debug
 *   - Invoke-Expression (iex)
 *   - Rename-LocalUser, Rename-LocalGroup
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

function createShell(asAdmin = false): PowerShellSubShell {
  const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
  pc.powerOn();
  if (asAdmin) pc.setCurrentUser('Administrator');
  const { subShell } = PowerShellSubShell.create(pc);
  return subShell;
}

async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

// ─── Missing $env: variables ──────────────────────────────────────────────────

describe('Phase 8 — Missing $env: variables', () => {
  it('$env:APPDATA returns AppData\\Roaming path', async () => {
    const sh = createShell();
    const out = await run(sh, '$env:APPDATA');
    expect(out).toContain('AppData');
    expect(out).toContain('Roaming');
  });

  it('$env:LOCALAPPDATA returns AppData\\Local path', async () => {
    const sh = createShell();
    const out = await run(sh, '$env:LOCALAPPDATA');
    expect(out).toContain('AppData');
    expect(out).toContain('Local');
  });

  it('$env:ProgramFiles returns Program Files path', async () => {
    const sh = createShell();
    const out = await run(sh, '$env:ProgramFiles');
    expect(out).toContain('Program Files');
  });

  it('$env:ProgramData returns C:\\ProgramData', async () => {
    const sh = createShell();
    const out = await run(sh, '$env:ProgramData');
    expect(out.toLowerCase()).toContain('programdata');
  });

  it('$env:NUMBER_OF_PROCESSORS returns a positive number string', async () => {
    const sh = createShell();
    const out = await run(sh, '$env:NUMBER_OF_PROCESSORS');
    expect(parseInt(out.trim())).toBeGreaterThan(0);
  });

  it('$env:PATHEXT contains .EXE and .BAT', async () => {
    const sh = createShell();
    const out = await run(sh, '$env:PATHEXT');
    expect(out.toUpperCase()).toContain('.EXE');
    expect(out.toUpperCase()).toContain('.BAT');
  });
});

// ─── Missing automatic variables ─────────────────────────────────────────────

describe('Phase 8 — Missing automatic variables', () => {
  it('$HOME returns user home directory', async () => {
    const sh = createShell();
    const out = await run(sh, '$HOME');
    expect(out.toLowerCase()).toContain('users');
  });

  it('$PSHOME returns PowerShell installation directory', async () => {
    const sh = createShell();
    const out = await run(sh, '$PSHOME');
    expect(out.toLowerCase()).toContain('powershell');
  });

  it('$PROFILE returns user profile .ps1 path', async () => {
    const sh = createShell();
    const out = await run(sh, '$PROFILE');
    expect(out.toLowerCase()).toContain('.ps1');
  });

  it('$ErrorActionPreference defaults to Continue', async () => {
    const sh = createShell();
    const out = await run(sh, '$ErrorActionPreference');
    expect(out.trim()).toBe('Continue');
  });

  it('$VerbosePreference defaults to SilentlyContinue', async () => {
    const sh = createShell();
    const out = await run(sh, '$VerbosePreference');
    expect(out.trim()).toBe('SilentlyContinue');
  });

  it('$DebugPreference defaults to SilentlyContinue', async () => {
    const sh = createShell();
    const out = await run(sh, '$DebugPreference');
    expect(out.trim()).toBe('SilentlyContinue');
  });

  it('$WarningPreference defaults to Continue', async () => {
    const sh = createShell();
    const out = await run(sh, '$WarningPreference');
    expect(out.trim()).toBe('Continue');
  });

  it('$PSScriptRoot is empty when not in a script', async () => {
    const sh = createShell();
    const out = await run(sh, '$PSScriptRoot');
    expect(out.trim()).toBe('');
  });

  it('$PSCommandPath is empty when not in a script', async () => {
    const sh = createShell();
    const out = await run(sh, '$PSCommandPath');
    expect(out.trim()).toBe('');
  });

  it('$LASTEXITCODE is 0 initially', async () => {
    const sh = createShell();
    const out = await run(sh, '$LASTEXITCODE');
    expect(out.trim()).toBe('0');
  });
});

// ─── Write-Error / Write-Warning / Write-Verbose / Write-Debug ───────────────

describe('Phase 8 — Write-Error / Write-Warning / Write-Verbose / Write-Debug', () => {
  it('Write-Error outputs an error message', async () => {
    const sh = createShell();
    const out = await run(sh, 'Write-Error "Something went wrong"');
    expect(out.toLowerCase()).toContain('something went wrong');
  });

  it('Write-Warning outputs WARNING: prefix', async () => {
    const sh = createShell();
    const out = await run(sh, 'Write-Warning "Disk almost full"');
    expect(out.toUpperCase()).toContain('WARNING');
    expect(out).toContain('Disk almost full');
  });

  it('Write-Verbose is silent by default', async () => {
    const sh = createShell();
    const out = await run(sh, 'Write-Verbose "Debug info"');
    expect(out.trim()).toBe('');
  });

  it('Write-Debug is silent by default', async () => {
    const sh = createShell();
    const out = await run(sh, 'Write-Debug "Low level info"');
    expect(out.trim()).toBe('');
  });
});

// ─── Invoke-Expression ────────────────────────────────────────────────────────

describe('Phase 8 — Invoke-Expression', () => {
  it('Invoke-Expression evaluates a string command', async () => {
    const sh = createShell();
    const out = await run(sh, "Invoke-Expression 'Get-Date'");
    expect(out.length).toBeGreaterThan(0);
  });

  it('iex alias works', async () => {
    const sh = createShell();
    const out = await run(sh, "iex 'hostname'");
    expect(out.length).toBeGreaterThan(0);
  });

  it('iex evaluates arithmetic expression string', async () => {
    const sh = createShell();
    const out = await run(sh, "iex '2 + 2'");
    expect(out.trim()).toBe('4');
  });
});

// ─── Rename-LocalUser / Rename-LocalGroup ────────────────────────────────────

describe('Phase 8 — Rename-LocalUser / Rename-LocalGroup', () => {
  it('Rename-LocalUser renames an existing user', async () => {
    const sh = createShell(true); // as Administrator
    await run(sh, 'New-LocalUser -Name OldUser -Password pass');
    await run(sh, 'Rename-LocalUser -Name OldUser -NewName NewUser');
    const out = await run(sh, 'Get-LocalUser');
    expect(out).toContain('NewUser');
    expect(out).not.toContain('OldUser');
  });

  it('Rename-LocalGroup renames an existing group', async () => {
    const sh = createShell(true); // as Administrator
    await run(sh, 'New-LocalGroup -Name OldGroup');
    await run(sh, 'Rename-LocalGroup -Name OldGroup -NewName NewGroup');
    const out = await run(sh, 'Get-LocalGroup');
    expect(out).toContain('NewGroup');
    expect(out).not.toContain('OldGroup');
  });

  it('Rename-LocalUser returns error for non-existent user', async () => {
    const sh = createShell(true); // as Administrator
    const out = await run(sh, 'Rename-LocalUser -Name Ghost -NewName Spectre');
    expect(out.toLowerCase()).toMatch(/not found|no.*user|cannot find|does not exist/);
  });

  it('Rename-LocalGroup returns error for non-existent group', async () => {
    const sh = createShell(true); // as Administrator
    const out = await run(sh, 'Rename-LocalGroup -Name Ghost -NewName Spectre');
    expect(out.toLowerCase()).toMatch(/not found|no.*group|cannot find|does not exist/);
  });
});
