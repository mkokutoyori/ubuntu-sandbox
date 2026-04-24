/**
 * ps-phase9-registry.test.ts — TDD tests for Phase 9: Windows Registry provider.
 *
 * Covers:
 *   - Get-Item on HKLM:\ and HKCU:\ paths
 *   - Get-ChildItem on registry keys
 *   - New-Item to create a registry key
 *   - Remove-Item to delete a registry key
 *   - Get-ItemProperty to read registry values
 *   - Set-ItemProperty to write registry values
 *   - Remove-ItemProperty to delete registry values
 *   - Test-Path on registry paths
 *   - Get-PSDrive to list available drives including HKLM: and HKCU:
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

function createShell(): PowerShellSubShell {
  const pc = new WindowsPC('windows-pc', 'PC1', 100, 100);
  pc.powerOn();
  const { subShell } = PowerShellSubShell.create(pc);
  return subShell;
}

async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

// ─── Test-Path on registry paths ─────────────────────────────────────────────

describe('Phase 9 — Registry Test-Path', () => {
  it('Test-Path HKLM:\\ returns True', async () => {
    const sh = createShell();
    const out = await run(sh, 'Test-Path HKLM:\\');
    expect(out.trim()).toBe('True');
  });

  it('Test-Path HKCU:\\ returns True', async () => {
    const sh = createShell();
    const out = await run(sh, 'Test-Path HKCU:\\');
    expect(out.trim()).toBe('True');
  });

  it('Test-Path HKLM:\\SOFTWARE returns True', async () => {
    const sh = createShell();
    const out = await run(sh, 'Test-Path HKLM:\\SOFTWARE');
    expect(out.trim()).toBe('True');
  });

  it('Test-Path HKLM:\\NOSUCHKEY returns False', async () => {
    const sh = createShell();
    const out = await run(sh, 'Test-Path HKLM:\\NOSUCHKEY');
    expect(out.trim()).toBe('False');
  });
});

// ─── Get-Item on registry ────────────────────────────────────────────────────

describe('Phase 9 — Get-Item on registry', () => {
  it('Get-Item HKLM:\\ shows the root key', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Item HKLM:\\');
    expect(out.toLowerCase()).toContain('hklm');
  });

  it('Get-Item HKLM:\\SOFTWARE\\Microsoft shows key info', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Item HKLM:\\SOFTWARE\\Microsoft');
    expect(out.toLowerCase()).toMatch(/microsoft|software/);
  });

  it('Get-Item on non-existent key returns error', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Item HKLM:\\NOSUCHKEY');
    expect(out.toLowerCase()).toMatch(/cannot find|not exist|error/);
  });
});

// ─── Get-ChildItem on registry ───────────────────────────────────────────────

describe('Phase 9 — Get-ChildItem on registry', () => {
  it('Get-ChildItem HKLM:\\ lists top-level keys', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-ChildItem HKLM:\\');
    expect(out).toContain('SOFTWARE');
    expect(out).toContain('SYSTEM');
  });

  it('Get-ChildItem HKLM:\\SOFTWARE lists subkeys', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-ChildItem HKLM:\\SOFTWARE');
    expect(out).toContain('Microsoft');
  });

  it('gci alias works on registry path', async () => {
    const sh = createShell();
    const out = await run(sh, 'gci HKLM:\\SOFTWARE');
    expect(out).toContain('Microsoft');
  });

  it('ls alias works on registry path', async () => {
    const sh = createShell();
    const out = await run(sh, 'ls HKCU:\\Software');
    expect(out.toLowerCase()).toMatch(/microsoft|name|key|hkcu/);
  });
});

// ─── New-Item (create registry key) ─────────────────────────────────────────

describe('Phase 9 — New-Item on registry', () => {
  it('New-Item creates a new registry key', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path HKCU:\\Software\\MyApp');
    const out = await run(sh, 'Test-Path HKCU:\\Software\\MyApp');
    expect(out.trim()).toBe('True');
  });

  it('New-Item -Force creates nested keys', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path HKCU:\\Software\\MyApp\\Settings -Force');
    const out = await run(sh, 'Test-Path HKCU:\\Software\\MyApp\\Settings');
    expect(out.trim()).toBe('True');
  });
});

// ─── Remove-Item (delete registry key) ──────────────────────────────────────

describe('Phase 9 — Remove-Item on registry', () => {
  it('Remove-Item deletes a registry key', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path HKCU:\\Software\\TempKey');
    await run(sh, 'Remove-Item -Path HKCU:\\Software\\TempKey');
    const out = await run(sh, 'Test-Path HKCU:\\Software\\TempKey');
    expect(out.trim()).toBe('False');
  });
});

// ─── Get-ItemProperty / Set-ItemProperty ────────────────────────────────────

describe('Phase 9 — Get-ItemProperty & Set-ItemProperty', () => {
  it('Set-ItemProperty writes a string value', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path HKCU:\\Software\\MyApp -Force');
    await run(sh, "Set-ItemProperty -Path HKCU:\\Software\\MyApp -Name Version -Value '1.0'");
    const out = await run(sh, 'Get-ItemProperty -Path HKCU:\\Software\\MyApp -Name Version');
    expect(out).toContain('1.0');
  });

  it('Set-ItemProperty writes a numeric value', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path HKCU:\\Software\\MyApp -Force');
    await run(sh, 'Set-ItemProperty -Path HKCU:\\Software\\MyApp -Name Count -Value 42');
    const out = await run(sh, 'Get-ItemProperty -Path HKCU:\\Software\\MyApp -Name Count');
    expect(out).toContain('42');
  });

  it('Get-ItemProperty lists all values on a key', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-ItemProperty HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion');
    expect(out.toLowerCase()).toMatch(/windows|current|version/i);
  });

  it('Get-ItemProperty with -Name reads specific value', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-ItemProperty HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion -Name ProductName');
    expect(out).toContain('Windows');
  });
});

// ─── Remove-ItemProperty ─────────────────────────────────────────────────────

describe('Phase 9 — Remove-ItemProperty', () => {
  it('Remove-ItemProperty deletes a registry value', async () => {
    const sh = createShell();
    await run(sh, 'New-Item -Path HKCU:\\Software\\MyApp -Force');
    await run(sh, "Set-ItemProperty -Path HKCU:\\Software\\MyApp -Name ToDelete -Value 'yes'");
    await run(sh, 'Remove-ItemProperty -Path HKCU:\\Software\\MyApp -Name ToDelete');
    const out = await run(sh, 'Get-ItemProperty -Path HKCU:\\Software\\MyApp -Name ToDelete');
    expect(out.toLowerCase()).toMatch(/not found|does not exist|error|property.*todelete/i);
  });
});

// ─── Get-PSDrive ─────────────────────────────────────────────────────────────

describe('Phase 9 — Get-PSDrive', () => {
  it('Get-PSDrive lists HKLM and HKCU drives', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-PSDrive');
    expect(out).toContain('HKLM');
    expect(out).toContain('HKCU');
    expect(out).toContain('C');
  });
});
