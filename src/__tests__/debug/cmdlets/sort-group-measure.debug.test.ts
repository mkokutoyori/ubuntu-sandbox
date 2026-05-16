/**
 * Cmdlet attribute suite — Sort-Object / Group-Object / Measure-Object.
 *
 * Sort-Object: -Property (single/multi), -Descending, -Unique,
 *   -CaseSensitive, -Top, -Bottom, scriptblock keys.
 * Group-Object: -Property, -NoElement, -AsHashTable, scriptblock keys.
 * Measure-Object: -Sum/-Average/-Minimum/-Maximum/-Property and the
 *   text mode (-Line/-Word/-Character).
 *
 * Transcript → debug-output/cmdlets/sort-group-measure-*_results_debug.txt
 */
import { describe, it, beforeEach } from 'vitest';
import { resetSim, dumpCmdletSuite } from './_cmdlet-suite';
import type { DebugCommandInput } from '../_dump';

beforeEach(resetSim);

describe('cmdlet attributes — Sort/Group/Measure', () => {
  it('runs a 60+ command Sort/Group/Measure matrix', async () => {
    const commands: DebugCommandInput[] = [
      // ── Sort-Object basics ───────────────────────────────────────
      { section: 'Sort-Object', cmd: '5,3,9,1,7,2 | Sort-Object' },
      '5,3,9,1,7,2 | Sort-Object -Descending',
      "'banana','apple','cherry' | Sort-Object",
      "'banana','apple','cherry' | Sort-Object -Descending",
      '3,1,4,1,5,9,2,6 | Sort-Object -Unique',
      '3,1,4,1,5,9,2,6 | Sort-Object -Unique -Descending',
      "'a','A','b','B' | Sort-Object -CaseSensitive",
      '1..20 | Sort-Object { -$_ }',
      '1..20 | Sort-Object { $_ % 3 }',
      "'one','three','seven','to' | Sort-Object Length",
      "'one','three','seven','to' | Sort-Object Length, { $_ }",
      '10,2,33,4 | Sort-Object { [int]$_ }',

      // ── Sort -Property on objects + -Top / -Bottom ───────────────
      { section: 'Sort -Property / -Top / -Bottom', cmd: 'Get-Process | Sort-Object WS -Descending | Select-Object -First 5 Name, WS' },
      'Get-Process | Sort-Object Name | Select-Object -First 5 -ExpandProperty Name',
      'Get-Process | Sort-Object WS -Top 3 | Select-Object Name, WS',
      'Get-Process | Sort-Object WS -Bottom 3 | Select-Object Name, WS',
      'Get-Service | Sort-Object Status, Name | Select-Object -First 6 Name, Status',
      'Get-Service | Sort-Object -Property Status -Descending | Select-Object -First 5 Name, Status',
      'Get-ChildItem C:\\ | Sort-Object Length -Descending | Select-Object -First 5 Name, Length',
      'Get-Process | Sort-Object @{Expression="WS";Descending=$true} | Select-Object -First 3 Name, WS',
      'Get-Process | Sort-Object Name -Unique | Select-Object -First 5 -ExpandProperty Name',

      // ── Group-Object ─────────────────────────────────────────────
      { section: 'Group-Object', cmd: '1..20 | Group-Object { $_ % 3 }' },
      '1..20 | Group-Object { $_ % 3 } | Select-Object Name, Count',
      "'apple','avocado','banana','cherry','blueberry' | Group-Object { $_[0] }",
      "'apple','avocado','banana','cherry' | Group-Object { $_[0] } | Select-Object Name, Count",
      'Get-Service | Group-Object Status | Select-Object Name, Count',
      'Get-Service | Group-Object StartType | Sort-Object Count -Descending | Select-Object Name, Count',
      'Get-Process | Group-Object SI | Select-Object Name, Count',
      'Get-Process | Group-Object { $_.Name.Length } | Sort-Object Name | Select-Object Name, Count',
      '1..30 | Group-Object { $_ % 2 -eq 0 } -NoElement',
      'Get-Service | Group-Object Status -NoElement | Select-Object Name, Count',
      "1..10 | Group-Object { if ($_ % 2) {'odd'} else {'even'} } | Select-Object Name, Count",
      '(Get-Process | Group-Object SI -AsHashTable)',
      'Get-Service | Group-Object Status | ForEach-Object { "$($_.Name): $($_.Count)" }',
      'Get-ChildItem C:\\ | Group-Object PSIsContainer | Select-Object Name, Count',

      // ── Measure-Object numeric ───────────────────────────────────
      { section: 'Measure-Object (numeric)', cmd: '1..100 | Measure-Object' },
      '1..100 | Measure-Object -Sum',
      '1..100 | Measure-Object -Sum -Average -Minimum -Maximum',
      '(1..100 | Measure-Object -Sum).Sum',
      '(1..100 | Measure-Object -Average).Average',
      '10,20,30,40 | Measure-Object -Maximum -Minimum',
      'Get-Process | Measure-Object WS -Sum -Average -Maximum',
      'Get-Process | Measure-Object Id -Minimum -Maximum',
      '(Get-Process | Measure-Object WS -Sum).Sum',
      'Get-Service | Measure-Object',
      '(Get-Service | Where-Object Status -EQ Running | Measure-Object).Count',
      'Get-ChildItem C:\\ -File | Measure-Object Length -Sum -Average',
      '1..10 | ForEach-Object { $_ * $_ } | Measure-Object -Sum -Average',

      // ── Measure-Object text mode ─────────────────────────────────
      { section: 'Measure-Object (text)', cmd: '"the quick brown fox" | Measure-Object -Word' },
      '"line one`nline two`nline three" | Measure-Object -Line',
      '"hello world" | Measure-Object -Character',
      '"a b c d e" | Measure-Object -Word -Character',
      "'apple pie','banana split' | Measure-Object -Word",
      'Get-Service | Select-Object -ExpandProperty Name | Measure-Object -Character -Maximum',

      // ── creative cross-cmdlet combinations ───────────────────────
      { section: 'cross-cmdlet combos', cmd: 'Get-Process | Group-Object SI | Sort-Object Count -Descending | Select-Object -First 2 Name, Count' },
      '1..1000 | Where-Object { $_ % 3 -eq 0 } | Group-Object { $_ % 5 } | Select-Object Name, Count | Sort-Object Name',
      'Get-Service | Group-Object Status | ForEach-Object { [pscustomobject]@{ State=$_.Name; N=$_.Count } } | Sort-Object N -Descending',
      '1..50 | Group-Object { $_ % 7 } | Measure-Object Count -Sum -Average',
      'Get-Process | Sort-Object WS -Descending | Select-Object -First 10 | Measure-Object WS -Sum -Average -Maximum',
      "'red','green','blue','red','green','red' | Group-Object | Sort-Object Count -Descending | Select-Object Name, Count",
      'Get-Service | Sort-Object Status, Name -Descending | Group-Object Status | Select-Object Name, Count',
      '1..100 | Where-Object { $_ % 2 } | Sort-Object -Descending | Select-Object -First 5 | Measure-Object -Sum',
      'Get-Process | Group-Object { [math]::Floor($_.WS/10KB) } | Sort-Object Name | Select-Object Name, Count',
      '(1..20 | Sort-Object -Descending | Select-Object -First 5) -join "->"',
      'Get-ChildItem C:\\ | Group-Object { $_.Mode[0] } | Select-Object Name, Count',
    ];
    await dumpCmdletSuite('sort-group-measure', commands);
  });
});
