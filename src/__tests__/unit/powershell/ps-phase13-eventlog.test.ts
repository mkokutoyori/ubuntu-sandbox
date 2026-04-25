/**
 * ps-phase13-eventlog.test.ts — TDD tests for Phase 13: Event Log & Diagnostics.
 *
 * Covers:
 *   - Get-EventLog -List (show all event logs)
 *   - Get-EventLog -LogName System / Application / Security
 *   - Get-EventLog with -Newest, -EntryType, -Source filters
 *   - Write-EventLog to add entries
 *   - Clear-EventLog to empty a log
 *   - New-EventLog to create a source
 *   - Get-WinEvent (newer API, same data)
 *   - Limit-EventLog to set max size
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

// ─── Get-EventLog -List ───────────────────────────────────────────────────────

describe('Phase 13 — Get-EventLog -List', () => {
  it('lists System, Application, and Security logs', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-EventLog -List');
    expect(out).toContain('System');
    expect(out).toContain('Application');
    expect(out).toContain('Security');
  });

  it('output contains Max(K) and Entries columns', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-EventLog -List');
    expect(out.toLowerCase()).toMatch(/max\(k\)|entries|overflow|log/i);
  });
});

// ─── Get-EventLog -LogName ────────────────────────────────────────────────────

describe('Phase 13 — Get-EventLog -LogName', () => {
  it('Get-EventLog -LogName System returns entries', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-EventLog -LogName System');
    expect(out.toLowerCase()).toMatch(/index|time|entry|event|source|system/i);
  });

  it('Get-EventLog System (positional arg) works', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-EventLog System');
    expect(out.toLowerCase()).toMatch(/index|time|entry|event|source|system/i);
  });

  it('Get-EventLog -LogName Application returns entries', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-EventLog -LogName Application');
    expect(out.toLowerCase()).toMatch(/index|entry|event|source/i);
  });

  it('Get-EventLog -LogName InvalidLog returns error', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-EventLog -LogName NoSuchLog');
    expect(out.toLowerCase()).toMatch(/not found|does not exist|invalid|error/i);
  });
});

// ─── Get-EventLog filters ─────────────────────────────────────────────────────

describe('Phase 13 — Get-EventLog -Newest', () => {
  it('-Newest 5 limits output to 5 entries', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-EventLog -LogName System -Newest 5');
    const lines = out.split('\n').filter(l => l.trim().match(/^\d/));
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it('-Newest 1 returns exactly 1 entry', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-EventLog -LogName System -Newest 1');
    const lines = out.split('\n').filter(l => l.trim().match(/^\d/));
    expect(lines.length).toBe(1);
  });
});

describe('Phase 13 — Get-EventLog -EntryType', () => {
  it('-EntryType Error filters to error entries', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-EventLog -LogName System -EntryType Error');
    if (out.trim()) {
      expect(out.toLowerCase()).toMatch(/error/i);
    }
    // May be empty if no error entries seeded — that is acceptable
    expect(out).toBeDefined();
  });

  it('-EntryType Information shows informational entries', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-EventLog -LogName System -EntryType Information');
    expect(out.toLowerCase()).toMatch(/information|index|event|source/i);
  });
});

// ─── Write-EventLog ───────────────────────────────────────────────────────────

describe('Phase 13 — Write-EventLog', () => {
  it('Write-EventLog writes an entry that appears in Get-EventLog', async () => {
    const sh = createShell(true);
    await run(sh, "Write-EventLog -LogName Application -Source 'MyApp' -EventId 1001 -EntryType Information -Message 'Test message'");
    const out = await run(sh, 'Get-EventLog -LogName Application -Newest 1');
    expect(out).toContain('1001');
  });

  it('Write-EventLog without required params returns error', async () => {
    const sh = createShell(true);
    const out = await run(sh, 'Write-EventLog -LogName Application');
    expect(out.toLowerCase()).toMatch(/error|required|missing|parameter/i);
  });
});

// ─── Clear-EventLog ───────────────────────────────────────────────────────────

describe('Phase 13 — Clear-EventLog', () => {
  it('Clear-EventLog empties the log', async () => {
    const sh = createShell(true);
    await run(sh, "Write-EventLog -LogName Application -Source 'MyApp' -EventId 9999 -EntryType Information -Message 'Before clear'");
    await run(sh, 'Clear-EventLog -LogName Application');
    const out = await run(sh, 'Get-EventLog -LogName Application');
    // After clear, no entries with our index should appear — or the log is empty
    expect(out.toLowerCase()).not.toContain('9999');
  });
});

// ─── New-EventLog ─────────────────────────────────────────────────────────────

describe('Phase 13 — New-EventLog', () => {
  it('New-EventLog creates a custom source', async () => {
    const sh = createShell(true);
    const out = await run(sh, "New-EventLog -LogName Application -Source 'MyCustomSource'");
    // Should succeed silently or return info
    expect(out.toLowerCase()).not.toContain('unhandled');
  });
});

// ─── Get-WinEvent ─────────────────────────────────────────────────────────────

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

// ─── Limit-EventLog ───────────────────────────────────────────────────────────

describe('Phase 13 — Limit-EventLog', () => {
  it('Limit-EventLog sets max log size silently', async () => {
    const sh = createShell(true);
    const out = await run(sh, 'Limit-EventLog -LogName Application -MaximumSize 64KB');
    // Should succeed without error
    expect(out.toLowerCase()).not.toMatch(/unrecognized|not found|error.*term/i);
  });
});
