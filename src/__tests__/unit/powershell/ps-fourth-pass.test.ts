import { describe, it, expect, beforeEach } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

let ps: PSInterpreter;
beforeEach(() => { ps = new PSInterpreter(); });
function run(code: string): string {
  const r = ps.execute(code);
  return typeof r === 'string' ? r : (r?.output ?? '');
}

describe('V. Hashtable instance methods', () => {
  it('V1 ContainsKey / Add / Remove / Clear', () => {
    const out = run(`
$h = @{ a=1; b=2 }
$h.ContainsKey('a')
$h.ContainsKey('z')
$h.Add('c', 3)
$h['c']
$h.Remove('a')
$h.ContainsKey('a')
$h.Count
$h.Clear()
$h.Count
`);
    const lines = out.trim().split(/\r?\n/);
    expect(lines).toEqual(['True','False','3','False','2','0']);
  });
  it('V2 Keys and Values enumerate the hash', () => {
    const out = run(`
$h = @{ x=10; y=20; z=30 }
($h.Keys | Sort-Object) -join ','
((($h.Values) | Sort-Object) -join ',')
`);
    expect(out).toMatch(/x,y,z/);
    expect(out).toMatch(/10,20,30/);
  });
  it('V3 GetEnumerator yields key/value pairs', () => {
    const out = run(`
$h = @{ alpha=1; bravo=2 }
$h.GetEnumerator() | Sort-Object -Property Key | ForEach-Object { "$($_.Key)=$($_.Value)" }
`);
    expect(out).toMatch(/alpha=1/);
    expect(out).toMatch(/bravo=2/);
  });
});

describe('W. Compare-Object', () => {
  it('W1 reports differences between two arrays', () => {
    const out = run(`
$a = @('apple','banana','cherry')
$b = @('banana','cherry','date')
Compare-Object -ReferenceObject $a -DifferenceObject $b | ForEach-Object { "$($_.SideIndicator) $($_.InputObject)" } | Sort-Object
`);
    expect(out).toMatch(/<= apple/);
    expect(out).toMatch(/=> date/);
  });
  it('W2 -IncludeEqual returns the matching items too', () => {
    const out = run(`
$a = @(1,2,3)
$b = @(2,3,4)
$result = Compare-Object -ReferenceObject $a -DifferenceObject $b -IncludeEqual
($result | Where-Object SideIndicator -eq '==').Count
`);
    expect(out.trim()).toBe('2');
  });
});

describe('X. Measure-Object', () => {
  it('X1 -Sum / -Average / -Min / -Max on a number stream', () => {
    const out = run(`
$m = 1..10 | Measure-Object -Sum -Average -Minimum -Maximum
"Sum=$($m.Sum);Avg=$($m.Average);Min=$($m.Minimum);Max=$($m.Maximum)"
`);
    expect(out.trim()).toBe('Sum=55;Avg=5.5;Min=1;Max=10');
  });
  it('X2 -Property on objects', () => {
    const out = run(`
$objs = @(
  [PSCustomObject]@{ N=10 },
  [PSCustomObject]@{ N=20 },
  [PSCustomObject]@{ N=30 }
)
$m = $objs | Measure-Object -Property N -Sum -Average
"$($m.Sum)/$($m.Average)"
`);
    expect(out.trim()).toBe('60/20');
  });
  it('X3 -Line / -Word / -Character on string input', () => {
    const out = run(`
$m = "alpha bravo charlie","delta echo" | Measure-Object -Line -Word -Character
"L=$($m.Lines);W=$($m.Words);C=$($m.Characters)"
`);
    expect(out).toMatch(/L=2/);
    expect(out).toMatch(/W=5/);
  });
});

describe('Y. Array slicing with ranges', () => {
  it('Y1 positive range $arr[1..3]', () => {
    expect(run('(@(0,10,20,30,40,50)[1..3]) -join ","').trim()).toBe('10,20,30');
  });
  it('Y2 negative index $arr[-1] returns last element', () => {
    expect(run('@(10,20,30)[-1]').trim()).toBe('30');
  });
  it('Y3 negative range $arr[-3..-1]', () => {
    expect(run('(@(10,20,30,40,50)[-3..-1]) -join ","').trim()).toBe('30,40,50');
  });
  it('Y4 reverse via descending range', () => {
    expect(run('(@(1,2,3,4,5)[4..0]) -join ","').trim()).toBe('5,4,3,2,1');
  });
  it('Y5 indexed pick $arr[0,2,4]', () => {
    expect(run('(@("a","b","c","d","e")[0,2,4]) -join ","').trim()).toBe('a,c,e');
  });
});

describe('Z. Tee-Object', () => {
  it('Z1 Tee-Object -Variable captures the pipeline mid-flight', () => {
    const out = run(`
1..5 | Tee-Object -Variable copy | ForEach-Object { $_ * 2 } | Out-Null
($copy | Sort-Object) -join ','
`);
    expect(out.trim()).toBe('1,2,3,4,5');
  });
});

describe('AA. Select-String', () => {
  it('AA1 finds matching lines in a string array', () => {
    const out = run(`
$lines = @('error: file missing', 'INFO: ok', 'error: timeout', 'INFO: ok')
($lines | Select-String -Pattern 'error').Count
`);
    expect(out.trim()).toBe('2');
  });
  it('AA2 -SimpleMatch treats the pattern as a literal', () => {
    const out = run(`
$lines = @('a+b', 'aab', 'a*b')
($lines | Select-String -Pattern 'a+b' -SimpleMatch).Count
`);
    expect(out.trim()).toBe('1');
  });
  it('AA3 -CaseSensitive distinguishes Foo from foo', () => {
    const out = run(`
$lines = @('foo','Foo','FOO')
($lines | Select-String -Pattern 'Foo' -CaseSensitive).Count
`);
    expect(out.trim()).toBe('1');
  });
});

describe('BB. ConvertTo-Csv / ConvertFrom-Csv', () => {
  it('BB1 round-trip a PSCustomObject set', () => {
    const out = run(`
$objs = @(
  [PSCustomObject]@{ Name='Ada'; Age=36 },
  [PSCustomObject]@{ Name='Bob'; Age=29 }
)
$csv = $objs | ConvertTo-Csv -NoTypeInformation
$back = $csv | ConvertFrom-Csv
"$($back[0].Name)|$($back[1].Name)"
`);
    expect(out.trim()).toBe('Ada|Bob');
  });
});

describe('CC. Real-world: registry-style processing', () => {
  it('CC1 track active services in a hashtable + report sum', () => {
    const out = run(`
$svcs = @(
  [PSCustomObject]@{ Name='web';   Conns=12 },
  [PSCustomObject]@{ Name='db';    Conns=5  },
  [PSCustomObject]@{ Name='cache'; Conns=20 }
)
$total = ($svcs | Measure-Object -Property Conns -Sum).Sum
"total=$total"
`);
    expect(out.trim()).toBe('total=37');
  });
  it('CC2 diff two service lists with Compare-Object', () => {
    const out = run(`
$before = @('nginx','sshd','rsyslogd')
$after  = @('nginx','sshd','systemd-journald','postgresql')
$delta  = Compare-Object -ReferenceObject $before -DifferenceObject $after
$added   = ($delta | Where-Object SideIndicator -eq '=>').InputObject -join ','
$removed = ($delta | Where-Object SideIndicator -eq '<=').InputObject -join ','
"added=$added;removed=$removed"
`);
    expect(out).toMatch(/added=systemd-journald,postgresql|added=postgresql,systemd-journald/);
    expect(out).toMatch(/removed=rsyslogd/);
  });
});
