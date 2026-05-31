import { describe, it, expect, beforeEach } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

let ps: PSInterpreter;
beforeEach(() => { ps = new PSInterpreter(); });
function run(code: string): string {
  const r = ps.execute(code);
  return typeof r === 'string' ? r : (r?.output ?? '');
}

describe('N. Add-Member', () => {
  it('N1 adds a NoteProperty to a PSCustomObject', () => {
    const out = run(`
$o = [PSCustomObject]@{ Name='Alice' }
$o | Add-Member -MemberType NoteProperty -Name Age -Value 30
"$($o.Name)/$($o.Age)"
`);
    expect(out.trim()).toBe('Alice/30');
  });
  it('N2 -PassThru returns the augmented object', () => {
    const out = run(`
$o = [PSCustomObject]@{ K='v' } | Add-Member -NotePropertyName Extra -NotePropertyValue 42 -PassThru
$o.Extra
`);
    expect(out.trim()).toBe('42');
  });
  it('N3 adds a ScriptMethod', () => {
    const out = run(`
$o = [PSCustomObject]@{ Base=10 }
$o | Add-Member -MemberType ScriptMethod -Name Double -Value { $this.Base * 2 }
$o.Double()
`);
    expect(out.trim()).toBe('20');
  });
  it('N4 -NotePropertyMembers adds many at once', () => {
    const out = run(`
$o = [PSCustomObject]@{}
$o | Add-Member -NotePropertyMembers @{ A=1; B='two'; C=$true }
"$($o.A)|$($o.B)|$($o.C)"
`);
    expect(out.trim()).toBe('1|two|True');
  });
});

describe('O. Simplified Where/ForEach syntax', () => {
  it('O1 Where-Object Property -eq Value (no scriptblock)', () => {
    const out = run(`
@(
  [PSCustomObject]@{ Role='admin'; Name='a' },
  [PSCustomObject]@{ Role='user';  Name='b' },
  [PSCustomObject]@{ Role='admin'; Name='c' }
) | Where-Object Role -eq 'admin' | ForEach-Object { $_.Name } | Sort-Object
`);
    expect(out.trim()).toMatch(/a/);
    expect(out.trim()).toMatch(/c/);
    expect(out.trim()).not.toMatch(/^b$/m);
  });
  it('O2 Where-Object Property -like with wildcard', () => {
    const out = run(`
@('apple','avocado','banana') | Where-Object { $_ -like 'a*' } | Sort-Object
`);
    expect(out).toMatch(/apple/);
    expect(out).toMatch(/avocado/);
    expect(out).not.toMatch(/banana/);
  });
  it('O3 ForEach-Object PropertyName extracts that property', () => {
    const out = run(`
$users = @(
  [PSCustomObject]@{ Name='alice' },
  [PSCustomObject]@{ Name='bob' }
)
($users | ForEach-Object Name) -join ','
`);
    expect(out.trim()).toBe('alice,bob');
  });
  it('O4 ForEach-Object MethodName invokes the method', () => {
    const out = run(`
($('foo','bar') | ForEach-Object ToUpper) -join ','
`);
    expect(out.trim()).toBe('FOO,BAR');
  });
});

describe('P. Switch advanced flags', () => {
  it('P1 -Regex matches with capture groups in $matches', () => {
    const out = run(`
$result = switch -Regex ("hello world") {
  '(\\w+) (\\w+)' { "$($matches[1])+$($matches[2])" }
}
$result
`);
    expect(out.trim()).toBe('hello+world');
  });
  it('P2 -Wildcard uses glob patterns', () => {
    const out = run(`
@('test.txt','data.log','readme') | ForEach-Object {
  switch -Wildcard ($_) {
    '*.txt' { "T:$_"; break }
    '*.log' { "L:$_"; break }
    default { "D:$_" }
  }
}
`);
    expect(out).toMatch(/T:test\.txt/);
    expect(out).toMatch(/L:data\.log/);
    expect(out).toMatch(/D:readme/);
  });
  it('P3 -CaseSensitive distinguishes Foo from foo', () => {
    const out = run(`
switch -CaseSensitive ('foo') {
  'Foo' { 'upper' }
  'foo' { 'lower' }
}
`);
    expect(out.trim()).toBe('lower');
  });
});

describe('Q. $PSDefaultParameterValues', () => {
  it('Q1 default value is applied when the caller omits the parameter', () => {
    const out = run(`
function Show {
  param([string]$Greeting, [string]$Name)
  "$Greeting $Name"
}
$PSDefaultParameterValues = @{ 'Show:Greeting' = 'Hi' }
Show -Name 'Ada'
`);
    expect(out.trim()).toBe('Hi Ada');
  });
  it('Q2 caller-supplied value wins over the default', () => {
    const out = run(`
function Show {
  param([string]$Greeting='?', [string]$Name)
  "$Greeting $Name"
}
$PSDefaultParameterValues = @{ 'Show:Greeting' = 'Hi' }
Show -Greeting 'Yo' -Name 'Ada'
`);
    expect(out.trim()).toBe('Yo Ada');
  });
  it('Q3 wildcard cmdlet name applies the default to every match', () => {
    const out = run(`
function GetA { param([int]$N=0) "A=$N" }
function GetB { param([int]$N=0) "B=$N" }
$PSDefaultParameterValues = @{ 'Get*:N' = 5 }
GetA; GetB
`);
    expect(out).toMatch(/A=5/);
    expect(out).toMatch(/B=5/);
  });
});

describe('R. Get-Member', () => {
  it('R1 returns the property list of a PSCustomObject', () => {
    const out = run(`
$o = [PSCustomObject]@{ Name='x'; Age=20 }
$o | Get-Member -MemberType NoteProperty | ForEach-Object { $_.Name } | Sort-Object
`);
    expect(out).toMatch(/Age/);
    expect(out).toMatch(/Name/);
  });
  it('R2 returns methods on a string', () => {
    const out = run(`
"hello" | Get-Member -MemberType Method | ForEach-Object { $_.Name } | Sort-Object | Select-Object -First 5
`);
    expect(out).toMatch(/(Substring|ToUpper|ToLower|Split|Trim|Replace|IndexOf|StartsWith|EndsWith)/);
  });
});

describe('S. String instance methods', () => {
  it('S1 PadLeft / PadRight', () => {
    expect(run('"x".PadLeft(5)').replace(/\s+$/, '')).toBe('    x');
    expect(run('"x".PadRight(5, "-")').replace(/\s+$/, '')).toBe('x----');
  });
  it('S2 IndexOf / LastIndexOf', () => {
    expect(run('"abcabc".IndexOf("b")').trim()).toBe('1');
    expect(run('"abcabc".LastIndexOf("b")').trim()).toBe('4');
  });
  it('S3 StartsWith / EndsWith', () => {
    expect(run('"hello.txt".StartsWith("hello")').trim()).toBe('True');
    expect(run('"hello.txt".EndsWith(".txt")').trim()).toBe('True');
  });
  it('S4 Replace works with substring & regex', () => {
    expect(run('"foo-bar-baz".Replace("-","_")').trim()).toBe('foo_bar_baz');
  });
  it('S5 Split returns an array', () => {
    expect(run('("a,b,c".Split(",")) -join "|"').trim()).toBe('a|b|c');
  });
  it('S6 Trim variants', () => {
    expect(run('"   hi   ".Trim()').trim()).toBe('hi');
    expect(run('"xxhixx".TrimStart("x")').trim()).toBe('hixx');
    expect(run('"xxhixx".TrimEnd("x")').trim()).toBe('xxhi');
  });
  it('S7 Substring(start, length)', () => {
    expect(run('"hello world".Substring(6, 5)').trim()).toBe('world');
  });
  it('S8 Contains', () => {
    expect(run('"foobar".Contains("oba")').trim()).toBe('True');
  });
});

describe('T. Comment-based help', () => {
  it('T1 Get-Help returns the .SYNOPSIS of a function', () => {
    const out = run(`
function MyTool {
  <#
    .SYNOPSIS
    Does the thing.
    .DESCRIPTION
    The thing it does is great.
  #>
  param([string]$X)
  $X
}
Get-Help MyTool
`);
    expect(out).toMatch(/Does the thing/);
  });
});

describe('U. Real-world: configuration script', () => {
  it('U1 process a hashtable of service definitions with Add-Member + Where-Object', () => {
    const out = run(`
$services = @(
  [PSCustomObject]@{ Name='nginx'; Port=80;  Tier='web' },
  [PSCustomObject]@{ Name='psql';  Port=5432; Tier='db' },
  [PSCustomObject]@{ Name='redis'; Port=6379; Tier='cache' }
)
foreach ($s in $services) {
  $s | Add-Member -NotePropertyName Url -NotePropertyValue "tcp://$($s.Name):$($s.Port)"
}
($services | Where-Object Tier -eq 'web' | ForEach-Object Url) -join ','
`);
    expect(out.trim()).toBe('tcp://nginx:80');
  });
  it('U2 build a report by grouping and projecting', () => {
    const out = run(`
$logs = @(
  [PSCustomObject]@{ Level='INFO';  Source='auth' },
  [PSCustomObject]@{ Level='WARN';  Source='auth' },
  [PSCustomObject]@{ Level='INFO';  Source='db' },
  [PSCustomObject]@{ Level='ERROR'; Source='auth' },
  [PSCustomObject]@{ Level='INFO';  Source='db' }
)
$report = $logs | Group-Object -Property Level | ForEach-Object {
  [PSCustomObject]@{ Level=$_.Name; Count=$_.Count }
} | Sort-Object -Property Level
($report | ForEach-Object { "$($_.Level)=$($_.Count)" }) -join ','
`);
    expect(out.trim()).toBe('ERROR=1,INFO=3,WARN=1');
  });
});
