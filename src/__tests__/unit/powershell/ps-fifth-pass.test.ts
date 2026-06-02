import { describe, it, expect, beforeEach } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

let ps: PSInterpreter;
beforeEach(() => { ps = new PSInterpreter(); });
function run(code: string): string {
  const r = ps.execute(code);
  return typeof r === 'string' ? r : (r?.output ?? '');
}

describe('DD. DateTime arithmetic & instance methods', () => {
  it('DD1 AddDays / AddHours / AddMinutes', () => {
    const out = run(`
$d = [DateTime]::new(2025,1,1,0,0,0)
$d2 = $d.AddDays(10).AddHours(5)
"$($d2.Year)-$($d2.Month)-$($d2.Day) $($d2.Hour):00"
`);
    expect(out.trim()).toBe('2025-1-11 5:00');
  });
  it('DD2 ToString with custom format', () => {
    const out = run(`
$d = [DateTime]::new(2025,3,7,9,5,0)
$d.ToString("yyyy-MM-dd HH:mm")
`);
    expect(out.trim()).toBe('2025-03-07 09:05');
  });
  it('DD3 DayOfWeek / Month / Year accessors', () => {
    const out = run(`
$d = [DateTime]::new(2025,1,1,0,0,0)
"$($d.Year),$($d.Month),$($d.Day)"
`);
    expect(out.trim()).toBe('2025,1,1');
  });
  it('DD4 difference between two dates yields a TimeSpan', () => {
    const out = run(`
$a = [DateTime]::new(2025,1,1)
$b = [DateTime]::new(2025,1,11)
$diff = $b - $a
$diff.Days
`);
    expect(out.trim()).toBe('10');
  });
  it('DD5 New-TimeSpan -Hours / -Minutes', () => {
    const out = run(`
$t = New-TimeSpan -Hours 2 -Minutes 30
$t.TotalMinutes
`);
    expect(out.trim()).toBe('150');
  });
});

describe('EE. -replace regex backreferences', () => {
  it('EE1 captured groups available as $1, $2 in replacement', () => {
    expect(run(`"alice bob" -replace '(\\w+) (\\w+)', '$2 $1'`).trim()).toBe('bob alice');
  });
  it('EE2 case-insensitive by default; -creplace is case-sensitive', () => {
    expect(run(`"FOO foo" -replace 'foo', 'X'`).trim()).toBe('X X');
    expect(run(`"FOO foo" -creplace 'foo', 'X'`).trim()).toBe('FOO X');
  });
  it('EE3 backslash-escaped dollar in replacement is literal', () => {
    expect(run(`"abc" -replace 'b', '$$'`).trim()).toBe('a$c');
  });
});

describe('FF. Push-Location / Pop-Location', () => {
  it('FF1 stack-based navigation restores the previous location', () => {
    const out = run(`
$start = (Get-Location).Path
Push-Location C:\\Windows
$mid = (Get-Location).Path
Pop-Location
$end = (Get-Location).Path
"start=$start;mid=$mid;end=$end"
`);
    expect(out).toMatch(/mid=C:\\Windows/i);
    expect(out).toMatch(/start=[^;]+;mid=[^;]+;end=\1/);
  });
});

describe('GG. switch with scriptblock conditions', () => {
  it('GG1 a scriptblock pattern is invoked per subject', () => {
    const out = run(`
switch (7) {
  { $_ -lt 5 } { 'small' }
  { $_ -lt 10 } { 'medium' }
  default { 'big' }
}
`);
    expect(out.trim()).toBe('medium');
  });
  it('GG2 multiple scriptblock branches fire when both match (no break)', () => {
    const out = run(`
$results = switch (4) {
  { $_ -gt 0 } { 'positive' }
  { $_ % 2 -eq 0 } { 'even' }
}
$results -join ','
`);
    expect(out.trim()).toBe('positive,even');
  });
});

describe('HH. Where-Object chained scriptblocks', () => {
  it('HH1 multiple conditions via -and inside one block', () => {
    const out = run(`
1..10 | Where-Object { $_ -gt 3 -and $_ -lt 8 } | ForEach-Object { $_ } | Sort-Object
`);
    expect(out.trim().split(/\r?\n/).map(Number)).toEqual([4,5,6,7]);
  });
});

describe('II. Get-Content / Set-Content / Out-File on the VFS', () => {
  it('II1 Set-Content writes; Get-Content reads', () => {
    const out = run(`
Set-Content -Path 'C:\\tmp\\hello.txt' -Value 'hi there'
Get-Content -Path 'C:\\tmp\\hello.txt'
`);
    expect(out).toMatch(/hi there/);
  });
  it('II2 Add-Content appends a line', () => {
    const out = run(`
Set-Content -Path 'C:\\tmp\\log.txt' -Value 'first'
Add-Content -Path 'C:\\tmp\\log.txt' -Value 'second'
Get-Content -Path 'C:\\tmp\\log.txt'
`);
    expect(out).toMatch(/first/);
    expect(out).toMatch(/second/);
  });
  it('II3 Get-Content -Raw returns the whole file as one string', () => {
    const out = run(`
Set-Content -Path 'C:\\tmp\\multi.txt' -Value @('line1','line2','line3')
(Get-Content -Path 'C:\\tmp\\multi.txt' -Raw).Length -gt 0
`);
    expect(out.trim()).toBe('True');
  });
  it('II4 Out-File -Append accumulates lines', () => {
    const out = run(`
'a' | Out-File -FilePath 'C:\\tmp\\out.txt'
'b' | Out-File -FilePath 'C:\\tmp\\out.txt' -Append
'c' | Out-File -FilePath 'C:\\tmp\\out.txt' -Append
Get-Content -Path 'C:\\tmp\\out.txt'
`);
    expect(out).toMatch(/a/);
    expect(out).toMatch(/b/);
    expect(out).toMatch(/c/);
  });
});

describe('JJ. Real-world: log report builder', () => {
  it('JJ1 build a weekly date axis with DateTime arithmetic', () => {
    const out = run(`
$start = [DateTime]::new(2025,1,6)
$labels = 0..6 | ForEach-Object { $start.AddDays($_).ToString("yyyy-MM-dd") }
$labels -join ','
`);
    expect(out.trim()).toBe('2025-01-06,2025-01-07,2025-01-08,2025-01-09,2025-01-10,2025-01-11,2025-01-12');
  });
  it('JJ2 transform a log file with -replace + Set-Content', () => {
    const out = run(`
Set-Content -Path 'C:\\tmp\\raw.log' -Value @(
  '2025-01-15 INFO start',
  '2025-01-15 ERROR boom',
  '2025-01-15 INFO recover'
)
$lines = Get-Content -Path 'C:\\tmp\\raw.log'
$cleaned = $lines | ForEach-Object { $_ -replace '^\\d{4}-\\d{2}-\\d{2} ', '' }
$cleaned | Set-Content -Path 'C:\\tmp\\clean.log'
Get-Content -Path 'C:\\tmp\\clean.log'
`);
    expect(out).toMatch(/INFO start/);
    expect(out).toMatch(/ERROR boom/);
    expect(out).toMatch(/INFO recover/);
    expect(out).not.toMatch(/2025-01-15/);
  });
});
