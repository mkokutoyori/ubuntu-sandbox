/**
 * Cmdlet attribute suite — Where-Object.
 *
 * -FilterScript ($_ predicates, nested/chained, -and/-or/-not),
 * the comparison-parameter form (-EQ/-NE/-GT/-GE/-LT/-LE/-Like/
 * -NotLike/-Match/-NotMatch/-Contains/-NotContains/-In/-NotIn/-Is),
 * and `?` alias, against ranges, strings and live objects.
 *
 * Transcript → debug-output/cmdlets/where-object-*_results_debug.txt
 */
import { describe, it, beforeEach } from 'vitest';
import { resetSim, dumpCmdletSuite } from './_cmdlet-suite';
import type { DebugCommandInput } from '../_dump';

beforeEach(resetSim);

describe('cmdlet attributes — Where-Object', () => {
  it('runs a 60+ command Where-Object matrix', async () => {
    const commands: DebugCommandInput[] = [
      // ── -FilterScript on numbers ─────────────────────────────────
      { section: '-FilterScript (numbers)', cmd: '1..30 | Where-Object { $_ -gt 20 }' },
      '1..30 | Where-Object { $_ % 2 -eq 0 }',
      '1..100 | Where-Object { $_ % 3 -eq 0 -and $_ % 5 -eq 0 }',
      '1..100 | Where-Object { $_ % 7 -eq 0 -or $_ % 11 -eq 0 } | Select-Object -First 8',
      '1..50 | Where-Object { -not ($_ % 2) }',
      '1..50 | Where-Object { $_ -gt 10 -and $_ -lt 20 }',
      '1..1000 | Where-Object { [math]::Sqrt($_) -eq [math]::Floor([math]::Sqrt($_)) } | Select-Object -First 10',
      '1..30 | Where-Object { $_ } ',
      '0..5 | Where-Object { $_ }',
      '(1..200 | Where-Object { $_ % 13 -eq 0 }).Count',

      // ── -FilterScript on strings ─────────────────────────────────
      { section: '-FilterScript (strings)', cmd: "'apple','banana','avocado','cherry' | Where-Object { $_ -like 'a*' }" },
      "'apple','banana','cherry','date' | Where-Object { $_.Length -gt 5 }",
      "'PowerShell','cmd','bash','zsh' | Where-Object { $_ -match 'sh' }",
      "'one','two','three','four' | Where-Object { $_.Contains('o') }",
      "'a','bb','ccc','dddd' | Where-Object { $_.Length -ge 3 }",
      "@('  trim me  ','x') | Where-Object { $_.Trim().Length -gt 3 }",

      // ── ?  alias ─────────────────────────────────────────────────
      { section: '? alias', cmd: '1..20 | ? { $_ -gt 15 }' },
      '1..20 | ? { $_ % 4 -eq 0 } | % { $_ }',
      "Get-Service | ? { $_.Status -eq 'Running' } | Select-Object -First 3 Name",

      // ── comparison-parameter form ────────────────────────────────
      { section: '-EQ / -NE / -GT / -LT', cmd: '1..10 | Where-Object Name -EQ 5' },
      'Get-Service | Where-Object Status -EQ Running | Select-Object -First 5 Name, Status',
      'Get-Service | Where-Object Status -NE Running | Select-Object -First 5 Name, Status',
      'Get-Process | Where-Object WS -GT 0 | Select-Object -First 5 Name, WS',
      'Get-Process | Where-Object Id -GE 1000 | Select-Object -First 5 Name, Id',
      'Get-Process | Where-Object Id -LT 500 | Select-Object Name, Id',
      'Get-Process | Where-Object SI -LE 1 | Select-Object -First 5 Name, SI',
      { section: '-Like / -NotLike / -Match', cmd: 'Get-Service | Where-Object Name -Like "*o*" | Select-Object -First 5 Name' },
      'Get-Service | Where-Object Name -NotLike "*x*" | Select-Object -First 5 Name',
      'Get-Process | Where-Object Name -Match "^s" | Select-Object -First 5 Name',
      'Get-Process | Where-Object Name -NotMatch "svc" | Select-Object -First 5 Name',
      'Get-ChildItem C:\\ | Where-Object Name -Like "P*" | Select-Object Name',
      { section: '-In / -Contains', cmd: 'Get-Service | Where-Object Status -In @("Running","Stopped") | Select-Object -First 5 Name, Status' },
      "1..10 | Where-Object { $_ -in @(2,4,6,8) }",
      "@(1,2,3) | Where-Object { 2 -in $_ }",
      "'red','green','blue' | Where-Object { 'green' -contains $_ }",

      // ── nested / chained Where ───────────────────────────────────
      { section: 'chained Where', cmd: '1..100 | Where-Object { $_ -gt 10 } | Where-Object { $_ -lt 90 } | Where-Object { $_ % 5 -eq 0 }' },
      'Get-Process | Where-Object { $_.WS -gt 0 } | Where-Object { $_.Name -match "s" } | Select-Object -First 5 Name, WS',
      'Get-Service | Where-Object { $_.Status -eq "Running" } | Where-Object { $_.Name.Length -le 6 } | Select-Object Name',
      '1..50 | Where-Object { $_ % 2 -eq 0 } | Where-Object { $_ -gt 20 } | Measure-Object -Sum',

      // ── Where + Sort / Group / Measure / Select / ForEach ────────
      { section: 'Where + other cmdlets', cmd: 'Get-Process | Where-Object WS -GT 0 | Sort-Object WS -Descending | Select-Object -First 3 Name, WS' },
      'Get-Service | Where-Object Status -EQ Running | Group-Object StartType | Select-Object Name, Count',
      'Get-Service | Where-Object Status -EQ Stopped | Measure-Object',
      '1..100 | Where-Object { $_ % 4 -eq 0 } | ForEach-Object { $_ / 4 } | Measure-Object -Sum',
      'Get-ChildItem C:\\ | Where-Object { $_.PSIsContainer } | Sort-Object Name | Select-Object -First 5 -ExpandProperty Name',
      'Get-Process | Where-Object { $_.Name -like "s*" } | Group-Object Name | Where-Object { $_.Count -ge 1 } | Select-Object Name, Count',
      '(1..1000 | Where-Object { $_ % 9 -eq 0 } | Measure-Object -Sum).Sum',
      'Get-Service | Where-Object { $_.DisplayName -match "Service" } | Select-Object -First 5 Name, DisplayName',
      '1..20 | Where-Object { $_ -band 1 }',
      'Get-Process | Where-Object { $_.Id -gt 0 -and $_.WS -gt 0 } | Select-Object -First 5 Name',
      'Get-Service | ? Status -eq Running | ? { $_.Name -notmatch "[0-9]" } | Select-Object -First 5 Name',
      "@('aa','bbb','c','dddd') | Where-Object Length -GE 3",
      '1..30 | Where-Object { ($_ -gt 5) -and ($_ -lt 25) -and ($_ % 2) } | Select-Object -First 6',
      'Get-Process | Where-Object { $_.WS -gt 0 } | Select-Object -ExpandProperty Name | Where-Object { $_ -match "^[a-m]" } | Sort-Object',
      'Get-Service | Where-Object { @("Running") -contains $_.Status } | Measure-Object',
      '1..100 | Where-Object { $_ -as [int] -and $_ % 25 -eq 0 }',
      "Get-ChildItem C:\\ | Where-Object Length -GT 0 | Select-Object Name, Length",
      'Get-Process | Where-Object { $_.Name } | Group-Object { $_.Name.Length } | Select-Object Name, Count | Sort-Object Name',
      '1..50 | Where-Object { $_ -notin (1..10) } | Select-Object -First 5',
    ];
    await dumpCmdletSuite('where-object', commands);
  });
});
