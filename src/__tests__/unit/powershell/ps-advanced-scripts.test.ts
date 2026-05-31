import { describe, it, expect, beforeEach } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

let ps: PSInterpreter;
beforeEach(() => { ps = new PSInterpreter(); });
function run(code: string): string {
  const r = ps.execute(code);
  return typeof r === 'string' ? r : (r?.output ?? '');
}

describe('A. ValueFromPipeline binding', () => {
  it('A1 a function with [Parameter(ValueFromPipeline=$true)] accepts piped input', () => {
    const out = run(`
function Square {
  param([Parameter(ValueFromPipeline=$true)][int]$N)
  process { $N * $N }
}
1..4 | Square
`);
    expect(out.trim().split(/\s+/)).toEqual(['1','4','9','16']);
  });
  it('A2 ValueFromPipelineByPropertyName binds by member name', () => {
    const out = run(`
function Show {
  param(
    [Parameter(ValueFromPipelineByPropertyName=$true)][string]$Name,
    [Parameter(ValueFromPipelineByPropertyName=$true)][int]$Age
  )
  process { "$Name=$Age" }
}
@(@{Name='Alice'; Age=30}, @{Name='Bob'; Age=25}) | Show
`);
    expect(out).toMatch(/Alice=30/);
    expect(out).toMatch(/Bob=25/);
  });
  it('A3 multiple positional inputs flow through process block', () => {
    const out = run(`
function Sum {
  param([Parameter(ValueFromPipeline=$true)][int]$N)
  begin { $total = 0 }
  process { $total += $N }
  end { $total }
}
1..10 | Sum
`);
    expect(out.trim()).toBe('55');
  });
});

describe('B. trap statement', () => {
  it('B1 a trap block runs when an exception is thrown', () => {
    const out = run(`
trap { "caught: $_"; continue }
throw "boom"
"after"
`);
    expect(out).toMatch(/caught: boom/);
    expect(out).toMatch(/after/);
  });
  it('B2 a typed trap [System.Exception] only matches that type', () => {
    const out = run(`
trap [System.Exception] { "general"; continue }
throw "x"
"end"
`);
    expect(out).toMatch(/general/);
    expect(out).toMatch(/end/);
  });
  it('B3 trap with break aborts the script', () => {
    const out = run(`
trap { "stop"; break }
throw "x"
"unreachable"
`);
    expect(out).toMatch(/stop/);
    expect(out).not.toMatch(/unreachable/);
  });
});

describe('C. Validate attributes', () => {
  it('C1 ValidateRange rejects out-of-range values', () => {
    const out = run(`
function Inc {
  param([ValidateRange(1, 10)][int]$N)
  $N + 1
}
try { Inc -N 5 } catch { "err" }
try { Inc -N 99 } catch { "err" }
`);
    expect(out).toMatch(/6/);
    expect(out).toMatch(/err/);
  });
  it('C2 ValidateSet rejects unknown choices', () => {
    const out = run(`
function Pick {
  param([ValidateSet('red','green','blue')][string]$C)
  "got $C"
}
try { Pick -C red } catch { "err" }
try { Pick -C purple } catch { "err" }
`);
    expect(out).toMatch(/got red/);
    expect(out).toMatch(/err/);
  });
  it('C3 ValidatePattern enforces a regex', () => {
    const out = run(`
function Ip {
  param([ValidatePattern('^\\d+\\.\\d+\\.\\d+\\.\\d+$')][string]$Addr)
  "ok $Addr"
}
try { Ip -Addr "10.0.0.1" } catch { "bad" }
try { Ip -Addr "not-an-ip" } catch { "bad" }
`);
    expect(out).toMatch(/ok 10\.0\.0\.1/);
    expect(out).toMatch(/bad/);
  });
  it('C4 Mandatory parameter raises on omission', () => {
    const out = run(`
function Need {
  param([Parameter(Mandatory=$true)][string]$X)
  "got $X"
}
try { Need -X hello } catch { "err" }
try { Need } catch { "err" }
`);
    expect(out).toMatch(/got hello/);
    expect(out).toMatch(/err/);
  });
});

describe('D. Splatting @hash and @array', () => {
  it('D1 @hash splats named parameters into a cmdlet call', () => {
    const out = run(`
function Greet {
  param([string]$Name, [int]$Times)
  1..$Times | ForEach-Object { "Hi $Name" }
}
$p = @{Name='World'; Times=3}
Greet @p
`);
    const lines = out.trim().split(/\r?\n/);
    expect(lines.filter(l => l === 'Hi World').length).toBe(3);
  });
  it('D2 @array splats positional arguments', () => {
    const out = run(`
function Add { param($A, $B) $A + $B }
$args = @(7, 8)
Add @args
`);
    expect(out.trim()).toBe('15');
  });
});

describe('E. -f format operator', () => {
  it('E1 basic positional formatting', () => {
    expect(run('"{0} {1}" -f "hello", "world"').trim()).toBe('hello world');
  });
  it('E2 numeric format specifiers', () => {
    expect(run('"{0:N2}" -f 1234.5').trim()).toMatch(/1,?234\.50/);
  });
  it('E3 padding and alignment', () => {
    expect(run('"[{0,-5}|{1,5}]" -f "a", "b"').trim()).toBe('[a    |    b]');
  });
});

describe('F. Stateful real-world scripts', () => {
  it('F1 batch file rename with regex pattern', () => {
    const out = run(`
$files = @('log_2024.txt', 'log_2025.txt', 'log_2026.txt')
$renamed = $files | ForEach-Object { $_ -replace 'log_', 'archive_' }
$renamed -join ','
`);
    expect(out.trim()).toBe('archive_2024.txt,archive_2025.txt,archive_2026.txt');
  });
  it('F2 group-and-count with pipeline', () => {
    const out = run(`
$data = @(
  @{Region='EU'; Sales=100},
  @{Region='US'; Sales=200},
  @{Region='EU'; Sales=150}
)
$totals = @{}
foreach ($item in $data) {
  $r = $item.Region
  if (-not $totals.ContainsKey($r)) { $totals[$r] = 0 }
  $totals[$r] += $item.Sales
}
"EU=" + $totals['EU'] + ",US=" + $totals['US']
`);
    expect(out.trim()).toBe('EU=250,US=200');
  });
  it('F3 hashtable + class produces structured output', () => {
    const out = run(`
class Person {
  [string]$Name
  [int]$Age
  Person([string]$n, [int]$a) { $this.Name = $n; $this.Age = $a }
  [string]Describe() { return "$($this.Name) is $($this.Age)" }
}
$p = [Person]::new("Ada", 36)
$p.Describe()
`);
    expect(out.trim()).toBe('Ada is 36');
  });
  it('F4 try/catch/finally and $Error', () => {
    const out = run(`
try {
  throw "bad input"
} catch {
  "caught: $_"
} finally {
  "cleanup"
}
"errcount=$($Error.Count)"
`);
    expect(out).toMatch(/caught: bad input/);
    expect(out).toMatch(/cleanup/);
    expect(out).toMatch(/errcount=1/);
  });
});
