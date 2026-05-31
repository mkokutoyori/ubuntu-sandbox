import { describe, it, expect, beforeEach } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

let ps: PSInterpreter;
beforeEach(() => { ps = new PSInterpreter(); });
function run(code: string): string {
  const r = ps.execute(code);
  return typeof r === 'string' ? r : (r?.output ?? '');
}

describe('G. PSCustomObject', () => {
  it('G1 [PSCustomObject]@{} literal exposes typed members', () => {
    const out = run(`
$o = [PSCustomObject]@{ Name='Alice'; Age=30 }
"$($o.Name) is $($o.Age)"
`);
    expect(out.trim()).toBe('Alice is 30');
  });
  it('G2 New-Object PSObject -Property builds an equivalent object', () => {
    const out = run(`
$o = New-Object PSObject -Property @{ Host='srv1'; Port=8080 }
"$($o.Host):$($o.Port)"
`);
    expect(out.trim()).toBe('srv1:8080');
  });
  it('G3 array of PSCustomObjects supports pipeline selection', () => {
    const out = run(`
$users = @(
  [PSCustomObject]@{ Name='alice'; Active=$true },
  [PSCustomObject]@{ Name='bob';   Active=$false },
  [PSCustomObject]@{ Name='carol'; Active=$true }
)
($users | Where-Object { $_.Active } | ForEach-Object { $_.Name }) -join ','
`);
    expect(out.trim()).toBe('alice,carol');
  });
});

describe('H. ConvertTo-Json / ConvertFrom-Json', () => {
  it('H1 hashtable round-trips via JSON', () => {
    const out = run(`
$h = @{ a=1; b='two'; c=$true }
$j = $h | ConvertTo-Json -Compress
$back = $j | ConvertFrom-Json
"$($back.a)|$($back.b)|$($back.c)"
`);
    expect(out.trim()).toBe('1|two|True');
  });
  it('H2 nested object serialization', () => {
    const out = run(`
$o = [PSCustomObject]@{ Name='Ada'; Tags=@('admin','vip') }
$j = $o | ConvertTo-Json -Compress
$j
`);
    expect(out).toMatch(/"Name":"Ada"/);
    expect(out).toMatch(/"Tags":\["admin","vip"\]/);
  });
  it('H3 ConvertFrom-Json on array of objects', () => {
    const out = run(`
$json = '[{"id":1,"label":"a"},{"id":2,"label":"b"}]'
$arr = $json | ConvertFrom-Json
"$($arr[0].label)+$($arr[1].label)"
`);
    expect(out.trim()).toBe('a+b');
  });
});

describe('I. .NET static methods', () => {
  it('I1 [Math]::Pow works', () => {
    expect(run('[Math]::Pow(2, 8)').trim()).toBe('256');
  });
  it('I2 [Math]::Sqrt', () => {
    expect(run('[Math]::Sqrt(144)').trim()).toBe('12');
  });
  it('I3 [Math]::Max / Min', () => {
    expect(run('[Math]::Max(3, 7)').trim()).toBe('7');
    expect(run('[Math]::Min(3, 7)').trim()).toBe('3');
  });
  it('I4 [String]::Format with positional args', () => {
    expect(run('[String]::Format("{0} {1}", "hello", "world")').trim()).toBe('hello world');
  });
  it('I5 [String]::IsNullOrEmpty', () => {
    expect(run('[String]::IsNullOrEmpty("")').trim()).toBe('True');
    expect(run('[String]::IsNullOrEmpty("x")').trim()).toBe('False');
  });
  it('I6 [int]::Parse / [int]::TryParse-like', () => {
    expect(run('[int]::Parse("42")').trim()).toBe('42');
  });
  it('I7 [DateTime]::Now returns a date', () => {
    expect(run('[DateTime]::Now -is [DateTime]').trim()).toBe('True');
  });
});

describe('J. Automatic variables', () => {
  it('J1 $? reflects last-statement success', () => {
    const out = run(`
Get-Date | Out-Null
$?
`);
    expect(out.trim()).toBe('True');
  });
  it('J2 $PSVersionTable.PSVersion is non-null', () => {
    const out = run('$PSVersionTable.PSVersion.Major');
    expect(out.trim()).toMatch(/^\d+$/);
  });
  it('J3 $LASTEXITCODE is pre-initialised and writable', () => {
    expect(run('$LASTEXITCODE').trim()).toBe('0');
    expect(run('$LASTEXITCODE = 42; $LASTEXITCODE').trim()).toBe('42');
  });
});

describe('K. Stream redirection', () => {
  it('K1 2>&1 merges errors into output', () => {
    const out = run(`
function Bad { Write-Error "boom"; "after" }
$x = Bad 2>&1
$x | ForEach-Object { "$_" } | Sort-Object
`);
    expect(out).toMatch(/after/);
    expect(out).toMatch(/boom/);
  });
  it('K2 *> redirects all streams to one place', () => {
    const out = run(`
function Mix {
  Write-Output "out"
  Write-Warning "warn"
  Write-Error "err"
}
$captured = Mix *>&1
($captured | Measure-Object).Count -ge 1
`);
    expect(out.trim()).toBe('True');
  });
});

describe('L. Array & pipeline cmdlets', () => {
  it('L1 Sort-Object -Property descending', () => {
    const out = run(`
$names = @(
  [PSCustomObject]@{ Name='a'; N=3 },
  [PSCustomObject]@{ Name='b'; N=1 },
  [PSCustomObject]@{ Name='c'; N=2 }
) | Sort-Object -Property N -Descending | ForEach-Object { $_.Name }
$names -join ','
`);
    expect(out.trim()).toBe('a,c,b');
  });
  it('L2 Group-Object on a key', () => {
    const out = run(`
@('apple','avocado','banana','blueberry','cherry') |
  Group-Object -Property { $_.Substring(0,1) } |
  ForEach-Object { "$($_.Name)=$($_.Count)" } |
  Sort-Object
`);
    expect(out).toMatch(/a=2/);
    expect(out).toMatch(/b=2/);
    expect(out).toMatch(/c=1/);
  });
  it('L3 array filter via comparison operator returns matching elements', () => {
    const out = run('(1..10 | Where-Object { $_ -gt 7 }) -join ","');
    expect(out.trim()).toBe('8,9,10');
  });
  it('L4 -in operator filters', () => {
    const out = run(`
$allowed = @('a','c','e')
$matched = @('a','b','c','d','e') | Where-Object { $_ -in $allowed }
($matched -join '')
`);
    expect(out.trim()).toBe('ace');
  });
});

describe('M. Real-world stateful scripts', () => {
  it('M1 build a config-tracking PSCustomObject and export JSON', () => {
    const out = run(`
$services = @(
  [PSCustomObject]@{ Name='nginx'; Port=80;  Active=$true },
  [PSCustomObject]@{ Name='sshd';  Port=22;  Active=$true },
  [PSCustomObject]@{ Name='mysql'; Port=3306; Active=$false }
)
$active = $services | Where-Object { $_.Active } | Select-Object Name, Port
$json = $active | ConvertTo-Json -Compress
$json
`);
    expect(out).toMatch(/"Name":"nginx"/);
    expect(out).toMatch(/"Port":80/);
    expect(out).toMatch(/"Name":"sshd"/);
    expect(out).not.toMatch(/mysql/);
  });
  it('M2 aggregate counters from a list using a hashtable', () => {
    const out = run(`
$events = @('login','logout','login','login','error','login','logout')
$counts = @{}
foreach ($e in $events) {
  if (-not $counts.ContainsKey($e)) { $counts[$e] = 0 }
  $counts[$e]++
}
"login=$($counts['login']);logout=$($counts['logout']);error=$($counts['error'])"
`);
    expect(out.trim()).toBe('login=4;logout=2;error=1');
  });
  it('M3 splat hashtable into a function call', () => {
    const out = run(`
function Deploy {
  param([string]$Host, [int]$Port, [string]$Env)
  "deploy $Host:$Port [$Env]"
}
$opts = @{ Host='10.0.0.5'; Port=443; Env='prod' }
Deploy @opts
`);
    expect(out.trim()).toBe('deploy 10.0.0.5:443 [prod]');
  });
});
