/**
 * Cmdlet attribute suite — ConvertTo/ConvertFrom-Json / -Csv,
 * Select-String, Compare-Object, Tee-Object, Get-Unique.
 *
 * ConvertTo-Json -Depth/-Compress, round-trips through ConvertFrom-Json;
 * ConvertTo-Csv -NoTypeInformation / -Delimiter, ConvertFrom-Csv;
 * Select-String -Pattern/-SimpleMatch/-CaseSensitive/-NotMatch/
 *   -AllMatches/-Context; Compare-Object -Property/-IncludeEqual/
 *   -ExcludeDifferent/-PassThru.
 *
 * Transcript → debug-output/cmdlets/conversion-cmdlets-*_results_debug.txt
 */
import { describe, it, beforeEach } from 'vitest';
import { resetSim, dumpCmdletSuite } from './_cmdlet-suite';
import type { DebugCommandInput } from '../_dump';

beforeEach(resetSim);

describe('cmdlet attributes — Convert / Select-String / Compare', () => {
  it('runs a 55+ command conversion matrix', async () => {
    const commands: DebugCommandInput[] = [
      // ── ConvertTo-Json ───────────────────────────────────────────
      { section: 'ConvertTo-Json', cmd: '@{ name="test"; value=42 } | ConvertTo-Json' },
      '[pscustomobject]@{ a=1; b=2; c=3 } | ConvertTo-Json',
      '1..5 | ConvertTo-Json',
      '@{ outer = @{ inner = @{ deep = 1 } } } | ConvertTo-Json -Depth 5',
      '@{ outer = @{ inner = 1 } } | ConvertTo-Json -Depth 1',
      '@{ a=1; b=2 } | ConvertTo-Json -Compress',
      'Get-Process | Select-Object -First 3 Name, Id | ConvertTo-Json',
      'Get-Service | Select-Object -First 2 Name, Status | ConvertTo-Json',
      '@(1,2,3) | ConvertTo-Json -Compress',
      '[pscustomobject]@{ list=@(1,2,3); map=@{x=1} } | ConvertTo-Json -Depth 3',
      "'a string' | ConvertTo-Json",
      '$true | ConvertTo-Json',

      // ── ConvertFrom-Json + round-trip ────────────────────────────
      { section: 'ConvertFrom-Json', cmd: "'{ \"name\": \"alice\", \"age\": 30 }' | ConvertFrom-Json" },
      "'{ \"x\": 1, \"y\": 2 }' | ConvertFrom-Json | Select-Object x, y",
      "'[1,2,3,4,5]' | ConvertFrom-Json | Measure-Object -Sum",
      "'{ \"items\": [10,20,30] }' | ConvertFrom-Json | Select-Object -ExpandProperty items",
      '(@{ k="v"; n=7 } | ConvertTo-Json | ConvertFrom-Json).n',
      '([pscustomobject]@{ a=1; b=2 } | ConvertTo-Json | ConvertFrom-Json).a',
      "'{ \"nested\": { \"deep\": \"value\" } }' | ConvertFrom-Json | Select-Object -ExpandProperty nested",
      "(1..10 | ConvertTo-Json | ConvertFrom-Json | Measure-Object -Sum).Sum",

      // ── ConvertTo-Csv / ConvertFrom-Csv ──────────────────────────
      { section: 'ConvertTo-Csv', cmd: 'Get-Process | Select-Object -First 3 Name, Id | ConvertTo-Csv' },
      'Get-Process | Select-Object -First 3 Name, Id | ConvertTo-Csv -NoTypeInformation',
      'Get-Service | Select-Object -First 3 Name, Status | ConvertTo-Csv -NoTypeInformation',
      '1..3 | ForEach-Object { [pscustomobject]@{ N=$_; Sq=$_*$_ } } | ConvertTo-Csv -NoTypeInformation',
      "[pscustomobject]@{ a='x'; b='y' } | ConvertTo-Csv -NoTypeInformation -Delimiter ';'",
      { section: 'ConvertFrom-Csv', cmd: "\"Name,Age`nAlice,30`nBob,25\" | ConvertFrom-Csv" },
      "\"Name,Age`nAlice,30`nBob,25\" | ConvertFrom-Csv | Where-Object { [int]$_.Age -gt 26 }",
      "\"a;b`n1;2`n3;4\" | ConvertFrom-Csv -Delimiter ';' | Measure-Object",
      '(Get-Service | Select-Object -First 3 Name, Status | ConvertTo-Csv -NoTypeInformation | ConvertFrom-Csv | Measure-Object).Count',

      // ── Select-String ────────────────────────────────────────────
      { section: 'Select-String', cmd: "'apple','banana','cherry' | Select-String 'an'" },
      "'apple','banana','cherry' | Select-String -Pattern 'a.*a'",
      "'Apple','apple','APPLE' | Select-String 'apple' -CaseSensitive",
      "'apple','banana','cherry' | Select-String 'a' -NotMatch",
      "'one.two.three' | Select-String '.' -SimpleMatch",
      "'foo bar baz','qux foo' | Select-String 'foo' -AllMatches",
      "'line1','line2','line3','line4','line5' | Select-String 'line3' -Context 1",
      "'aaa','bbb','aaa' | Select-String 'aaa' | Measure-Object",
      "Get-Service | Select-Object -ExpandProperty Name | Select-String '^S' | Select-Object -First 5",
      "'CamelCaseWord' | Select-String '[A-Z][a-z]+' -AllMatches",

      // ── Compare-Object ───────────────────────────────────────────
      { section: 'Compare-Object', cmd: 'Compare-Object (1,2,3,4) (3,4,5,6)' },
      'Compare-Object (1,2,3,4) (3,4,5,6) -IncludeEqual',
      'Compare-Object (1,2,3,4) (3,4,5,6) -ExcludeDifferent -IncludeEqual',
      "Compare-Object 'a','b','c' 'b','c','d'",
      'Compare-Object (1..5) (3..7) -PassThru',
      '$a = Get-Service | Select-Object -First 5 Name; $b = Get-Service | Select-Object -First 3 Name; Compare-Object $a $b -Property Name',
      'Compare-Object (1,1,2,3) (1,2,2,3) | Sort-Object SideIndicator',
      '(Compare-Object (1..10) (5..15)).Count',

      // ── Tee-Object / Get-Unique ──────────────────────────────────
      { section: 'Tee-Object / Get-Unique', cmd: '1..5 | Tee-Object -Variable t | Measure-Object -Sum; $t' },
      '1..10 | Tee-Object -FilePath C:\\tee.txt | Measure-Object -Sum',
      'Get-Content C:\\tee.txt',
      '3,1,1,4,1,5,9,2,6,5,3,5 | Sort-Object | Get-Unique',
      "'a','a','b','b','c' | Get-Unique",
      'Get-Process | ForEach-Object { $_.SI } | Sort-Object | Get-Unique',

      // ── creative cross-cmdlet combinations ───────────────────────
      { section: 'creative combos', cmd: 'Get-Service | Select-Object -First 5 Name, Status | ConvertTo-Json -Compress | ConvertFrom-Json | Where-Object Status -EQ Running' },
      'Get-Process | Select-Object -First 5 Name, Id | ConvertTo-Csv -NoTypeInformation | ConvertFrom-Csv | Sort-Object { [int]$_.Id } | Select-Object -First 3',
      "1..20 | Where-Object { $_ % 2 } | ConvertTo-Json -Compress",
      "(Get-Service | Select-Object -ExpandProperty Name | Select-String 'Service' | Measure-Object).Count",
      'Compare-Object (Get-Service | Select-Object -First 5 -ExpandProperty Name) (Get-Service | Select-Object -First 3 -ExpandProperty Name) | Select-Object InputObject, SideIndicator',
      '@{ services = (Get-Service | Select-Object -First 3 Name, Status) } | ConvertTo-Json -Depth 3',
      "'{ \"nums\": [5,3,8,1,9] }' | ConvertFrom-Json | ForEach-Object { $_.nums } | Sort-Object -Descending | Select-Object -First 3",
      'Get-Process | Select-Object -First 4 Name, WS | ConvertTo-Csv -NoTypeInformation -Delimiter "|"',
      "'red,1','green,2','blue,3' | ForEach-Object { $_ } | ConvertFrom-Csv -Header Color,Rank | Sort-Object { [int]$_.Rank } -Descending",
    ];
    await dumpCmdletSuite('conversion-cmdlets', commands);
  });
});
