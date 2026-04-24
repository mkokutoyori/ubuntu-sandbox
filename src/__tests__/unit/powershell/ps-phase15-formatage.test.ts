/**
 * ps-phase15-formatage.test.ts — TDD tests for Phase 15 missing features.
 *
 * Covers:
 *   - ForEach-Object (%) in the PowerShellExecutor pipeline
 *   - Group-Object (group)
 *   - Tee-Object (tee) with -Variable
 *   - ConvertTo-Json
 *   - ConvertFrom-Json
 *   - Out-Null (suppress output)
 *   - Out-String
 *   - Get-NetRoute, Get-NetTCPConnection, Get-NetFirewallRule (Phase 6 gaps)
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

// ─── ForEach-Object ────────────────────────────────────────────────────────────

describe('Phase 15 — ForEach-Object in pipeline', () => {
  it('% runs a script block for each piped object', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Service | ForEach-Object { $_.Name }');
    expect(out).toContain('Dhcp');
    expect(out).toContain('Dnscache');
  });

  it('% alias works', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Service | % { $_.Status }');
    expect(out).toContain('Running');
  });

  it('foreach alias works', async () => {
    const sh = createShell();
    const out = await run(sh, "Get-Service | foreach { $_.Name } | Select-String 'Dhcp'");
    expect(out).toContain('Dhcp');
  });

  it('ForEach-Object on process list returns names', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Process | ForEach-Object { $_.ProcessName }');
    expect(out).toContain('svchost');
  });
});

// ─── Group-Object ──────────────────────────────────────────────────────────────

describe('Phase 15 — Group-Object', () => {
  it('groups services by Status', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Service | Group-Object Status');
    expect(out).toContain('Count');
    expect(out).toContain('Name');
    expect(out).toContain('Running');
  });

  it('groups processes by session id column', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Process | Group-Object SI');
    expect(out).toContain('Count');
  });

  it('group alias works', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Service | group Status');
    expect(out).toContain('Count');
    expect(out).toContain('Name');
  });
});

// ─── Tee-Object ────────────────────────────────────────────────────────────────

describe('Phase 15 — Tee-Object', () => {
  it('Tee-Object -Variable stores and passes through', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Service | Tee-Object -Variable svcList | Select-Object -First 1');
    // The pipeline output should contain the first service
    expect(out.length).toBeGreaterThan(0);
  });

  it('tee alias works', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Service | tee -Variable myVar | Measure-Object');
    expect(out).toContain('Count');
  });
});

// ─── ConvertTo-Json / ConvertFrom-Json ────────────────────────────────────────

describe('Phase 15 — ConvertTo-Json', () => {
  it('converts a simple string to JSON', async () => {
    const sh = createShell();
    const out = await run(sh, "ConvertTo-Json 'hello'");
    expect(out.trim()).toBe('"hello"');
  });

  it('converts a number to JSON', async () => {
    const sh = createShell();
    const out = await run(sh, 'ConvertTo-Json 42');
    expect(out.trim()).toBe('42');
  });

  it('converts a hashtable to JSON object', async () => {
    const sh = createShell();
    const out = await run(sh, "ConvertTo-Json @{Name='Alice'; Age=30}");
    expect(out).toContain('"Name"');
    expect(out).toContain('"Alice"');
    expect(out).toContain('"Age"');
    expect(out).toContain('30');
  });

  it('converts an array to JSON array', async () => {
    const sh = createShell();
    const out = await run(sh, "ConvertTo-Json @(1,2,3)");
    expect(out.trim()).toContain('[');
    expect(out.trim()).toContain('1');
    expect(out.trim()).toContain('3');
  });
});

describe('Phase 15 — ConvertFrom-Json', () => {
  it('parses a JSON string into an object', async () => {
    const sh = createShell();
    await run(sh, '$obj = ConvertFrom-Json \'{"Name":"Bob","Age":25}\'');
    const name = await run(sh, '$obj.Name');
    expect(name.trim()).toBe('Bob');
  });

  it('parses a JSON array', async () => {
    const sh = createShell();
    await run(sh, '$arr = ConvertFrom-Json \'[1,2,3]\'');
    const len = await run(sh, '$arr.Length');
    expect(len.trim()).toBe('3');
  });

  it('round-trips through ConvertTo-Json and ConvertFrom-Json', async () => {
    const sh = createShell();
    await run(sh, "$obj = [PSCustomObject]@{X=10; Y=20}");
    await run(sh, '$json = ConvertTo-Json $obj');
    await run(sh, '$back = ConvertFrom-Json $json');
    const x = await run(sh, '$back.X');
    expect(x.trim()).toBe('10');
  });
});

// ─── Out-Null ─────────────────────────────────────────────────────────────────

describe('Phase 15 — Out-Null', () => {
  it('Out-Null suppresses pipeline output', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Service | Out-Null');
    expect(out.trim()).toBe('');
  });

  it('Out-Null with a value returns nothing', async () => {
    const sh = createShell();
    const out = await run(sh, "'hello' | Out-Null");
    expect(out.trim()).toBe('');
  });
});

// ─── Out-String ───────────────────────────────────────────────────────────────

describe('Phase 15 — Out-String', () => {
  it('Out-String converts pipeline to a single string', async () => {
    const sh = createShell();
    const out = await run(sh, "Get-Service | Select-Object -First 2 | Out-String");
    expect(out.length).toBeGreaterThan(0);
  });
});

// ─── Get-NetRoute / Get-NetTCPConnection / Get-NetFirewallRule ───────────────

describe('Phase 15 — Network cmdlets (Phase 6 gaps)', () => {
  it('Get-NetRoute returns routing table', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-NetRoute');
    expect(out.toLowerCase()).toMatch(/destination|nexthop|route/i);
  });

  it('Get-NetTCPConnection returns TCP connections', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-NetTCPConnection');
    expect(out.toLowerCase()).toMatch(/state|listen|established|local/i);
  });

  it('Get-NetFirewallRule returns firewall rules', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-NetFirewallRule');
    expect(out.toLowerCase()).toMatch(/allow|block|firewall|rule/i);
  });
});
