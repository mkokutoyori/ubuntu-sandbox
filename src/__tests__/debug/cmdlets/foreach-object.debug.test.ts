/**
 * Cmdlet attribute suite — ForEach-Object.
 *
 * -Process (scriptblock), -Begin / -End accumulators, -MemberName
 * property/method shorthand, -ArgumentList, the `%` alias, $_ closures,
 * nested ForEach, multi-emit blocks, and ForEach feeding Where/Sort/
 * Group/Measure/Select.
 *
 * Transcript → debug-output/cmdlets/foreach-object-*_results_debug.txt
 */
import { describe, it, beforeEach } from 'vitest';
import { resetSim, dumpCmdletSuite } from './_cmdlet-suite';
import type { DebugCommandInput } from '../_dump';

beforeEach(resetSim);

describe('cmdlet attributes — ForEach-Object', () => {
  it('runs a 55+ command ForEach-Object matrix', async () => {
    const commands: DebugCommandInput[] = [
      // ── -Process basics + $_ ─────────────────────────────────────
      { section: '-Process / $_', cmd: '1..10 | ForEach-Object { $_ * 2 }' },
      '1..5 | ForEach-Object { "[$_]" }',
      '1..5 | ForEach-Object { $_ * $_ } | ForEach-Object { $_ + 1 }',
      "'a','b','c' | ForEach-Object { $_.ToUpper() }",
      "'Hello','World' | ForEach-Object { $_.Substring(0,3) }",
      '1..3 | ForEach-Object { $_; $_ * 10 }',
      '1..3 | ForEach-Object { @($_, $_*$_, $_*$_*$_) }',
      '1..4 | ForEach-Object { [pscustomobject]@{ N=$_; Sq=$_*$_ } }',
      '1..5 | ForEach-Object { if ($_ % 2) { "odd:$_" } else { "even:$_" } }',
      '(1..10 | ForEach-Object { $_ }) -join ","',

      // ── % alias ──────────────────────────────────────────────────
      { section: '% alias', cmd: '1..6 | % { $_ * $_ }' },
      "'x','y','z' | % { $_.ToUpper() }",
      '1..5 | % { $_ } | % { $_ + 100 }',
      '1..20 | ? { $_ % 2 -eq 0 } | % { $_ / 2 }',

      // ── -Begin / -Process / -End accumulators ────────────────────
      { section: '-Begin / -End', cmd: '1..10 | ForEach-Object -Begin { $s=0 } -Process { $s+=$_ } -End { $s }' },
      '1..5 | ForEach-Object -Begin { $p=1 } -Process { $p*=$_ } -End { "product=$p" }',
      "1..10 | ForEach-Object -Begin { $acc=@() } -Process { $acc+=$_*$_ } -End { $acc -join '+' }",
      '1..100 | ForEach-Object -Begin { $c=0 } -Process { if ($_ % 7 -eq 0) { $c++ } } -End { "multiples of 7: $c" }',
      "'a','bb','ccc' | ForEach-Object -Begin { $t=0 } -Process { $t+=$_.Length } -End { $t }",

      // ── -MemberName shorthand ────────────────────────────────────
      { section: '-MemberName', cmd: 'Get-Process | Select-Object -First 5 | ForEach-Object -MemberName Name' },
      'Get-Service | Select-Object -First 5 | ForEach-Object Name',
      "'hello','world' | ForEach-Object -MemberName Length",
      "'a-b-c','x-y' | ForEach-Object -MemberName Split -ArgumentList '-'",
      "'Hello World' | ForEach-Object ToUpper",
      'Get-ChildItem C:\\ | Select-Object -First 5 | ForEach-Object Name',
      "'  pad  ','  me  ' | ForEach-Object Trim",

      // ── -ArgumentList ────────────────────────────────────────────
      { section: '-ArgumentList', cmd: "'a,b,c','d,e' | ForEach-Object { $_.Split(',') } " },
      "'one two three' | ForEach-Object -MemberName Split -ArgumentList ' '",
      "1..3 | ForEach-Object { '{0:000}' -f $_ }",

      // ── nested ForEach ───────────────────────────────────────────
      { section: 'nested ForEach', cmd: '1..3 | ForEach-Object { $r=$_; 1..3 | ForEach-Object { "$r*$_=$($r*$_)" } }' },
      '1..3 | ForEach-Object { $o=$_; 1..2 | ForEach-Object { $o * $_ } }',
      "'ab','cd' | ForEach-Object { $w=$_; 0..($w.Length-1) | ForEach-Object { $w[$_] } }",
      '1..4 | ForEach-Object { ,(1..$_) } | ForEach-Object { ($_ | Measure-Object -Sum).Sum }',

      // ── ForEach feeding Where / Sort / Group / Measure / Select ──
      { section: 'ForEach + pipeline', cmd: '1..50 | ForEach-Object { $_ * $_ } | Where-Object { $_ -gt 100 } | Select-Object -First 5' },
      '1..20 | ForEach-Object { $_ * 3 } | Sort-Object -Descending | Select-Object -First 5',
      '1..30 | ForEach-Object { $_ % 4 } | Group-Object | Select-Object Name, Count',
      '1..100 | ForEach-Object { $_ * $_ } | Measure-Object -Sum -Average',
      'Get-Process | ForEach-Object { $_.WS } | Measure-Object -Sum -Maximum',
      'Get-Service | ForEach-Object { $_.Name.ToUpper() } | Sort-Object | Select-Object -First 5',
      'Get-Process | Select-Object -First 5 | ForEach-Object { "$($_.Name)=$($_.Id)" }',
      "'apple','banana','cherry' | ForEach-Object { [pscustomobject]@{ Fruit=$_; Len=$_.Length } } | Sort-Object Len -Descending",
      '1..10 | ForEach-Object { $_ } | Where-Object { $_ -gt 5 } | ForEach-Object { -$_ }',
      'Get-Service | Where-Object Status -EQ Running | ForEach-Object Name | Sort-Object | Select-Object -First 5',
      '1..5 | ForEach-Object { $_ * $_ } | ForEach-Object -Begin { $sum=0 } -Process { $sum+=$_ } -End { "sum of squares=$sum" }',
      '1..3 | ForEach-Object { Get-Random -Minimum 0 -Maximum 1 }',
      "'2024-01-15','2023-12-31' | ForEach-Object { ([datetime]$_).Year }",
      '1..6 | ForEach-Object { [math]::Pow(2,$_) }',
      "(1..10 | ForEach-Object { if ($_ -band 1) { $_ } }) -join ','",
      'Get-ChildItem C:\\ | ForEach-Object { $_.Name } | Where-Object { $_ -match "^[A-P]" } | Sort-Object',
      '1..4 | ForEach-Object { ,@($_, $_*2, $_*3) } | ForEach-Object { $_ -join "-" }',
      '"hello" | ForEach-Object { $_.ToCharArray() } | ForEach-Object { [int][char]$_ }',
      'Get-Process | Select-Object -First 8 | ForEach-Object { $_.Name } | Group-Object { $_.Length } | Select-Object Name, Count | Sort-Object Name',
      '1..20 | ForEach-Object -Begin { $even=@(); $odd=@() } -Process { if ($_ % 2) { $odd+=$_ } else { $even+=$_ } } -End { "even=$($even -join ","); odd=$($odd -join ",")" }',
      "'a','bb','ccc','dddd' | ForEach-Object { $_ * 2 }",
      '1..3 | ForEach-Object { New-Object psobject -Property @{ V = $_ } } | Select-Object -ExpandProperty V',
    ];
    await dumpCmdletSuite('foreach-object', commands);
  });
});
