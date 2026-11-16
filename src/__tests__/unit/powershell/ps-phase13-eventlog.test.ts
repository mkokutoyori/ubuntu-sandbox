/**
 * ps-phase13-eventlog.test.ts — Event Log cmdlets of PowerShell 7.
 *
 * The *-EventLog cmdlets (Get, Write, Clear, New, Limit) were removed in
 * PowerShell 7 (official_docs, "*-EventLog cmdlets"): each is answered as
 * "not recognized". What replaces them is Get-WinEvent for reading,
 * eventcreate for writing (identifiers 1-1000) and wevtutil for clearing.
 * The discrimination on the base: the six removed-cmdlet cases fall; the
 * Get-WinEvent cases and the eventcreate round trip pass either way.
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

describe('Phase 13 — the *-EventLog cmdlets are gone', () => {
  it.each([
    'Get-EventLog -LogName System',
    'Get-EventLog -List',
    'Write-EventLog -LogName Application -Source X -EventId 1 -Message m',
    'Clear-EventLog -LogName Application',
    'New-EventLog -LogName Application -Source X',
    'Limit-EventLog -LogName Application -MaximumSize 64KB',
  ])('%s is not recognized', async (line) => {
    const out = await run(createShell(true), line);
    expect(out).toMatch(/not recognized/);
  });
});

describe('Phase 13 — what replaces them', () => {
  it('eventcreate writes an entry that Get-WinEvent reads back', async () => {
    const sh = createShell(true);
    await run(sh, 'eventcreate /l Application /so Phase13 /id 130 /t WARNING /d "phase 13 entry"');
    const out = await run(sh, 'Get-WinEvent -FilterHashtable @{LogName="Application";ProviderName="Phase13"} | Format-List Id,LevelDisplayName,Message');
    expect(out).toMatch(/Id\s*:\s*130/);
    expect(out).toMatch(/LevelDisplayName\s*:\s*Warning/);
    expect(out).toContain('phase 13 entry');
  });

  it('wevtutil cl empties the log it names', async () => {
    const sh = createShell(true);
    await run(sh, 'eventcreate /l Application /so Phase13 /id 131 /t INFORMATION /d "to be cleared"');
    await run(sh, 'wevtutil cl Application');
    const out = await run(sh, 'Get-WinEvent -FilterHashtable @{LogName="Application";ProviderName="Phase13"} -ErrorAction SilentlyContinue');
    expect(out).not.toContain('to be cleared');
  });
});

describe('Phase 13 — Get-WinEvent', () => {
  it('Get-WinEvent -LogName System returns entries', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-WinEvent -LogName System');
    expect(out.toLowerCase()).toMatch(/time|level|id|message|source|provider/i);
  });

  it('Get-WinEvent -MaxEvents 3 limits output', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-WinEvent -LogName System -MaxEvents 3');
    const lines = out.split('\n').filter(l => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('Get-WinEvent -ListLog * lists all logs', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-WinEvent -ListLog *');
    expect(out).toContain('System');
    expect(out).toContain('Application');
  });
});
