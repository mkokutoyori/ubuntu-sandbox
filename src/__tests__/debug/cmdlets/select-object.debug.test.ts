/**
 * Cmdlet attribute suite — Select-Object.
 *
 * Every Select-Object parameter, exercised in creative combinations:
 *   -Property (string list, wildcards), -ExcludeProperty,
 *   -ExpandProperty, -First / -Last / -Skip / -SkipLast, -Index,
 *   -Unique, calculated properties (@{Name=;Expression=}), and the
 *   cmdlet chained behind Where/Sort/Group/ForEach/Measure.
 *
 * Transcript → debug-output/cmdlets/select-object-*_results_debug.txt
 */
import { describe, it, beforeEach } from 'vitest';
import { resetSim, dumpCmdletSuite } from './_cmdlet-suite';
import type { DebugCommandInput } from '../_dump';

beforeEach(resetSim);

describe('cmdlet attributes — Select-Object', () => {
  it('runs a 60+ command Select-Object matrix', async () => {
    const commands: DebugCommandInput[] = [
      // ── -First / -Last / -Skip / -SkipLast ───────────────────────
      { section: '-First / -Last / -Skip / -SkipLast', cmd: '1..20 | Select-Object -First 5' },
      '1..20 | Select-Object -Last 5',
      '1..20 | Select-Object -Skip 15',
      '1..20 | Select-Object -SkipLast 17',
      '1..20 | Select-Object -Skip 5 -First 3',
      '1..20 | Select-Object -First 100',
      '1..20 | Select-Object -First 0',
      '1..20 | Select-Object -Skip 100',
      '1..10 | Select-Object -First 3 | Select-Object -Last 1',
      '(1..20 | Select-Object -Last 4) -join ","',

      // ── -Index ───────────────────────────────────────────────────
      { section: '-Index', cmd: '1..20 | Select-Object -Index 0,4,9,19' },
      '1..20 | Select-Object -Index 100',
      "'a','b','c','d','e' | Select-Object -Index 1,3",
      '(10..30 | Select-Object -Index 0,5,10) | Measure-Object -Sum',

      // ── -Unique ──────────────────────────────────────────────────
      { section: '-Unique', cmd: '1,1,2,2,3,3,3,4 | Select-Object -Unique' },
      "'A','a','B','b' | Select-Object -Unique",
      '@(5,3,5,1,3,1) | Sort-Object | Select-Object -Unique',
      '(1..100 | ForEach-Object { $_ % 7 }) | Select-Object -Unique | Sort-Object',

      // ── -Property on real objects ────────────────────────────────
      { section: '-Property (objects)', cmd: 'Get-Process | Select-Object -First 3 -Property Name, Id' },
      'Get-Process | Select-Object Name, Id, WS -First 5',
      'Get-Service | Select-Object -First 4 Name, Status, StartType',
      'Get-Service | Select-Object -Property Name -First 3',
      'Get-ChildItem C:\\ | Select-Object Name, Mode, Length -First 6',
      'Get-Process | Select-Object -Property *name* -First 2',
      'Get-Service | Select-Object Name, DisplayName -First 3 | Sort-Object Name',

      // ── -ExcludeProperty ─────────────────────────────────────────
      { section: '-ExcludeProperty', cmd: 'Get-Process | Select-Object -First 2 -ExcludeProperty Handles, NPM(K), PM(K)' },
      'Get-Service | Select-Object -First 2 -Property Name, Status, StartType -ExcludeProperty StartType',

      // ── -ExpandProperty ──────────────────────────────────────────
      { section: '-ExpandProperty', cmd: 'Get-Process | Select-Object -First 5 -ExpandProperty Name' },
      'Get-Service | Select-Object -First 3 -ExpandProperty Status',
      'Get-ChildItem C:\\ | Select-Object -First 5 -ExpandProperty Name',
      '(Get-Process | Select-Object -First 10 -ExpandProperty Id | Measure-Object -Sum).Sum',
      'Get-Process | Select-Object -ExpandProperty Name -First 3 | ForEach-Object { $_.ToUpper() }',

      // ── calculated properties ────────────────────────────────────
      { section: 'calculated properties', cmd: '1..5 | Select-Object @{Name="N";Expression={$_}}, @{Name="Sq";Expression={$_*$_}}' },
      '1..5 | Select-Object @{N="Val";E={$_}}, @{N="Cube";E={$_*$_*$_}}',
      "'abc','de','fghi' | Select-Object @{Name='Str';Expression={$_}}, @{Name='Len';Expression={$_.Length}}",
      'Get-Process | Select-Object -First 3 Name, @{N="MB";E={[math]::Round($_.WS/1KB,1)}}',
      'Get-Service | Select-Object -First 3 @{N="Svc";E={$_.Name.ToUpper()}}, Status',
      '1..10 | Select-Object @{N="n";E={$_}}, @{N="even";E={$_ % 2 -eq 0}}',

      // ── chained behind Where / Sort / Group / ForEach / Measure ──
      { section: 'chained pipelines', cmd: '1..50 | Where-Object { $_ % 3 -eq 0 } | Select-Object -First 5' },
      '1..50 | Where-Object { $_ -gt 25 } | Select-Object -Last 3',
      'Get-Process | Sort-Object WS -Descending | Select-Object -First 5 Name, WS',
      'Get-Process | Sort-Object Name | Select-Object -First 3 -ExpandProperty Name',
      'Get-Service | Where-Object { $_.Status -eq "Running" } | Select-Object -First 5 Name, Status',
      'Get-Service | Group-Object Status | Select-Object Name, Count',
      'Get-Process | Group-Object SI | Select-Object Name, Count | Sort-Object Count -Descending',
      '1..100 | Where-Object { $_ % 2 -eq 0 } | Select-Object -First 10 | Measure-Object -Sum',
      '1..30 | ForEach-Object { $_ * $_ } | Select-Object -First 5',
      'Get-ChildItem C:\\ | Where-Object { $_.PSIsContainer } | Select-Object -ExpandProperty Name | Sort-Object',
      'Get-Process | Select-Object -First 5 Name, Id | Sort-Object Id | Select-Object -Last 2',
      '"x","y","z","x","y" | Select-Object -Unique | Measure-Object',
      'Get-Service | Select-Object -First 8 Name | Where-Object { $_.Name -like "*o*" }',
      'Get-Process | Select-Object Name -Unique -First 5',
      '1..20 | Select-Object @{N="v";E={$_}} | Where-Object { $_.v -gt 15 }',
      'Get-Process | Sort-Object WS -Descending | Select-Object -First 3 | Format-Table Name, WS -AutoSize',
      'Get-Service | Select-Object -First 3 Name, Status | ConvertTo-Json',
      'Get-Service | Select-Object -First 3 Name, Status | ConvertTo-Csv -NoTypeInformation',
      '(1..10 | Select-Object -First 5 | ForEach-Object { $_ }) -join "+"',
      'Get-Process | Select-Object -First 1 | Format-List Name, Id, WS',
      'Get-ChildItem C:\\ -File | Select-Object -First 3 Name, Length | Sort-Object Length -Descending',
      '1..5 | Select-Object @{N="i";E={$_}}, @{N="fact";E={$f=1; for($k=1;$k -le $_;$k++){$f*=$k}; $f}}',
      'Get-Service | Select-Object -Skip 2 -First 3 Name',
      'Get-Process | Select-Object Name, Id -First 50 | Measure-Object',
      '"alpha","beta","gamma" | Select-Object @{N="W";E={$_}}, @{N="Rev";E={-join ($_[-1..-($_.Length)])}}',
      'Get-Process | Where-Object { $_.WS -gt 0 } | Select-Object -First 5 -ExpandProperty Name | Sort-Object -Unique',
    ];
    await dumpCmdletSuite('select-object', commands);
  });
});
