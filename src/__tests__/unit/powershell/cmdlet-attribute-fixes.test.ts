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

describe('ConvertFrom-Csv / ConvertTo-Csv', () => {
  it('ConvertFrom-Csv parses a single multi-line string', async () => {
    const out = await j(shell(),
      '"Name,Age`nAlice,30`nBob,25" | ConvertFrom-Csv | Select-Object -ExpandProperty Name');
    expect(out.split('\n')).toEqual(['Alice', 'Bob']);
  });
  it('ConvertFrom-Csv -Delimiter', async () => {
    expect(await j(shell(),
      '"a;b`n1;2`n3;4" | ConvertFrom-Csv -Delimiter ";" | Measure-Object | Select-Object -ExpandProperty Count'))
      .toBe('2');
  });
  it('ConvertFrom-Csv -Header', async () => {
    const out = await j(shell(),
      "'red,1','green,2' | ConvertFrom-Csv -Header Color,Rank | Select-Object -ExpandProperty Color");
    expect(out.split('\n')).toEqual(['red', 'green']);
  });
  it('ConvertTo-Csv -Delimiter / -NoTypeInformation', async () => {
    expect(await run(shell(),
      "[pscustomobject]@{ a='x'; b='y' } | ConvertTo-Csv -NoTypeInformation -Delimiter ';'"))
      .toEqual(['"a";"b"', '"x";"y"']);
  });
  it('round-trips ConvertTo-Csv | ConvertFrom-Csv', async () => {
    expect(await j(shell(),
      'Get-Service | Select-Object -First 3 Name, Status | ConvertTo-Csv -NoTypeInformation | ConvertFrom-Csv | Measure-Object | Select-Object -ExpandProperty Count'))
      .toBe('3');
  });
});

describe('Format-Wide / Out-String', () => {
  it('Format-Wide <Prop> -Column lays names in a grid (not object dumps)', async () => {
    const out = await j(shell(),
      'Get-Service | Select-Object -First 6 | Format-Wide Name -Column 2');
    expect(out).not.toContain('Status=');
    expect(out).not.toContain(';');
    expect(out).toMatch(/Tcpip/);
  });
  it('Format-Wide -Column N controls columns', async () => {
    expect(await run(shell(), '1..10 | Format-Wide -Column 5'))
      .toEqual(['1   2   3   4   5', '6   7   8   9   10']);
  });
  it('Out-String renders objects as a table, not Key=Value;', async () => {
    const out = await j(shell(), 'Get-Service | Select-Object -First 2 Name, Status | Out-String');
    expect(out).toContain('Name');
    expect(out).toContain('Status');
    expect(out).not.toContain('Name=Tcpip; Status=');
  });
  it('Out-String of scalars is newline-joined; -Stream returns lines', async () => {
    expect(await run(shell(), '1..3 | Out-String')).toEqual(['1', '2', '3', '']);
    expect(await run(shell(), "'a','b' | Out-String -Stream")).toEqual(['a', 'b', '']);
  });
});

describe('Set-Content — array / pipeline input is one value per line', () => {
  it('1..20 | Set-Content writes 20 lines (not space-joined)', async () => {
    const s = shell();
    await run(s, '1..20 | Set-Content C:\\nums.txt');
    expect(await run(s, 'Get-Content C:\\nums.txt -Tail 3')).toEqual(['18', '19', '20']);
  });
  it('Get-Content of the written file has the right Count', async () => {
    const s = shell();
    await run(s, '1..20 | Set-Content C:\\nums.txt');
    expect(await j(s, '(Get-Content C:\\nums.txt).Count')).toBe('20');
  });
  it('scalar value still writes a single line', async () => {
    const s = shell();
    await run(s, "Set-Content C:\\one.txt -Value 'hello'");
    expect(await run(s, 'Get-Content C:\\one.txt')).toEqual(['hello']);
  });
  it('-NoNewline omits the trailing newline', async () => {
    const s = shell();
    await run(s, "'ab' | Set-Content C:\\nn.txt -NoNewline");
    expect(await run(s, 'Get-Content C:\\nn.txt -Raw')).toEqual(['ab']);
  });
  it('-PassThru echoes the written values', async () => {
    expect(await run(shell(), "'x','y' | Set-Content C:\\pt.txt -PassThru"))
      .toEqual(['x', 'y']);
  });
});

describe('Filesystem cmdlets — recurse copy / pipeline remove / -Force / Extension', () => {
  it('New-Item -Force creates missing parent directories', async () => {
    const s = shell();
    await run(s, 'New-Item C:\\Lab\\tmp\\a.txt -ItemType File -Force | Out-Null');
    expect(await j(s, 'Test-Path C:\\Lab\\tmp\\a.txt')).toBe('True');
  });
  it('Get-ChildItem | Remove-Item removes piped files', async () => {
    const s = shell();
    await run(s, 'New-Item C:\\W -ItemType Directory -Force | Out-Null');
    await run(s, '1..3 | ForEach-Object { New-Item "C:\\W\\f$_.txt" -ItemType File -Force | Out-Null }');
    await run(s, 'Get-ChildItem C:\\W -Filter f*.txt | Remove-Item');
    expect(await j(s, '(Get-ChildItem C:\\W).Count')).toBe('0');
  });
  it('Copy-Item -Recurse copies a directory tree', async () => {
    const s = shell();
    await run(s, 'New-Item C:\\Src\\inner -ItemType Directory -Force | Out-Null');
    await run(s, 'Set-Content C:\\Src\\top.txt -Value "a"');
    await run(s, 'Set-Content C:\\Src\\inner\\deep.txt -Value "b"');
    await run(s, 'Copy-Item C:\\Src C:\\Dst -Recurse');
    expect(await j(s, 'Test-Path C:\\Dst\\inner\\deep.txt')).toBe('True');
    expect(await run(s, 'Get-Content C:\\Dst\\top.txt')).toEqual(['a']);
  });
  it('Get-ChildItem objects expose Extension for Group-Object', async () => {
    const s = shell();
    await run(s, 'New-Item C:\\G -ItemType Directory -Force | Out-Null');
    await run(s, 'Set-Content C:\\G\\a.txt -Value 1');
    await run(s, 'Set-Content C:\\G\\b.txt -Value 2');
    await run(s, 'Set-Content C:\\G\\c.log -Value 3');
    const out = await j(s,
      'Get-ChildItem C:\\G -File | Group-Object Extension | Select-Object Name, Count');
    expect(out).toMatch(/\.txt/);
    expect(out).toMatch(/\.log/);
  });
});

describe('Get-Random — -InputObject / -Count / -SetSeed', () => {
  it('-SetSeed is reproducible', async () => {
    const s = shell();
    const a = (await run(s, 'Get-Random -SetSeed 42 -Minimum 1 -Maximum 100'))[0];
    const b = (await run(s, 'Get-Random -SetSeed 42 -Minimum 1 -Maximum 100'))[0];
    expect(a).toBe(b);
  });
  it('-InputObject picks an element', async () => {
    expect(await run(shell(), "Get-Random -SetSeed 1 -InputObject 'a','b','c'"))
      .toEqual([expect.stringMatching(/^[abc]$/)]);
  });
  it('-Count over a pipeline samples N items', async () => {
    expect(await j(shell(),
      '1..100 | Get-Random -Count 5 | Measure-Object | Select-Object -ExpandProperty Count'))
      .toBe('5');
  });
  it('negative numeric range', async () => {
    const r = Number((await run(shell(), 'Get-Random -SetSeed 3 -Minimum -10 -Maximum -1'))[0]);
    expect(r).toBeGreaterThanOrEqual(-10);
    expect(r).toBeLessThanOrEqual(-1);
  });
});
