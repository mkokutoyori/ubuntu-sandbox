/**
 * Regression — bugs surfaced by the per-cmdlet attribute debug suites
 * (debug-output/cmdlets/*). Each was producing wrong output before the
 * fix; this locks in the corrected behaviour.
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

function shell() {
  const pc = new WindowsPC('windows-pc', 'WIN');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}
const run = async (s: ReturnType<typeof shell>, l: string) =>
  (await s.processLine(l)).output;
const j = async (s: ReturnType<typeof shell>, l: string) =>
  (await s.processLine(l)).output.join('\n');

describe('Select-Object — -SkipLast / -Index / column order', () => {
  it('-SkipLast drops the last N', async () => {
    expect(await run(shell(), '1..20 | Select-Object -SkipLast 17')).toEqual(['1', '2', '3']);
  });
  it('-Index selects only the given positions, in order', async () => {
    expect(await run(shell(), '1..20 | Select-Object -Index 0,4,9,19'))
      .toEqual(['1', '5', '10', '20']);
  });
  it('-Index ignores out-of-range', async () => {
    expect(await run(shell(), '1..20 | Select-Object -Index 100')).toEqual([]);
  });
  it('calculated + string props keep the requested column order', async () => {
    const out = await j(shell(),
      'Get-Service | Select-Object -First 1 @{N="Svc";E={$_.Name}}, Status');
    const header = out.split('\n').find(l => l.includes('Svc'))!;
    expect(header.indexOf('Svc')).toBeLessThan(header.indexOf('Status'));
  });
});

describe('Get-Process — WS / PM / NPM aliases', () => {
  it('WS is a populated numeric column', async () => {
    const out = await j(shell(), 'Get-Process | Select-Object -First 3 Name, WS');
    expect(out).toMatch(/WS/);
    expect(out).toMatch(/\d{3,}/); // real byte numbers, not blank
  });
  it('Sort-Object WS -Descending orders by working set', async () => {
    const top = await run(shell(),
      'Get-Process | Sort-Object WS -Descending | Select-Object -First 1 -ExpandProperty Name');
    expect(top.length).toBe(1);
  });
});

describe('(pipeline) -join / -split bind correctly', () => {
  it('(1,2,3,4) -join "," → one joined string', async () => {
    expect(await run(shell(), '(1,2,3,4) -join ","')).toEqual(['1,2,3,4']);
  });
  it('(1..20 | Select-Object -Last 4) -join "," ', async () => {
    expect(await run(shell(), '(1..20 | Select-Object -Last 4) -join ","'))
      .toEqual(['17,18,19,20']);
  });
  it('(pipeline) -replace works', async () => {
    expect(await run(shell(), '("a-b-c") -replace "-","_"')).toEqual(['a_b_c']);
  });
});

describe('Where-Object — comparison-parameter form', () => {
  it('Where-Object Status -EQ Running filters services', async () => {
    expect((await j(shell(),
      '(Get-Service | Where-Object Status -EQ Running | Measure-Object).Count'))).toBe('20');
  });
  it('Where-Object Id -GE 1000 (numeric)', async () => {
    const ids = await run(shell(),
      'Get-Process | Where-Object Id -GE 1000 | Select-Object -First 3 -ExpandProperty Id');
    expect(ids.every(x => Number(x) >= 1000)).toBe(true);
  });
  it('Where-Object Name -Like "*o*"', async () => {
    const names = await run(shell(),
      'Get-Service | Where-Object Name -Like "*o*" | Select-Object -First 5 -ExpandProperty Name');
    expect(names.every(n => /o/i.test(n))).toBe(true);
  });
  it('string .Length works in the comparison form', async () => {
    expect(await run(shell(), "@('aa','bbb','c') | Where-Object Length -GE 2"))
      .toEqual(['aa', 'bbb']);
  });
  it('scriptblock form still works', async () => {
    expect(await run(shell(), '1..10 | Where-Object { $_ -gt 7 }'))
      .toEqual(['8', '9', '10']);
  });
});

describe('Sort-Object — -Top / -Bottom / multi-property / scriptblock', () => {
  it('-Top N returns first N after sort', async () => {
    expect((await run(shell(),
      'Get-Process | Sort-Object WS -Top 3 | Measure-Object')).join('')).toContain('Count');
    const n = await run(shell(),
      'Get-Process | Sort-Object WS -Descending -Top 3 | Select-Object -ExpandProperty Name');
    expect(n.length).toBe(3);
  });
  it('-Bottom N returns last N after sort', async () => {
    const n = await run(shell(),
      'Get-Process | Sort-Object WS -Bottom 2 | Select-Object -ExpandProperty Name');
    expect(n.length).toBe(2);
  });
  it('scriptblock key `{ -$_ }` sorts descending', async () => {
    expect(await run(shell(), '1..20 | Sort-Object { -$_ } | Select-Object -First 3'))
      .toEqual(['20', '19', '18']);
  });
  it('multi-property sort', async () => {
    const out = await j(shell(),
      'Get-Service | Sort-Object Status, Name | Select-Object -First 1 Name, Status');
    expect(out).toMatch(/Running|Stopped/);
  });
});

describe('Unary minus / negative parameter values', () => {
  it('-$x at statement start negates', async () => {
    const s = shell();
    await run(s, '$x = 7');
    expect(await run(s, '-$x')).toEqual(['-7']);
  });
  it('negative parameter value binds (Get-Random -Minimum -10 -Maximum -1)', async () => {
    const r = Number((await run(shell(), 'Get-Random -Minimum -10 -Maximum -1'))[0]);
    expect(r).toBeGreaterThanOrEqual(-10);
    expect(r).toBeLessThanOrEqual(-1);
  });
  it('subtraction is NOT broken', async () => {
    expect(await run(shell(), '5 - 3')).toEqual(['2']);
    expect(await run(shell(), '10 - 4 - 1')).toEqual(['5']);
  });
});
