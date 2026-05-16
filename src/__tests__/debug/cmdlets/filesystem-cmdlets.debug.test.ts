/**
 * Cmdlet attribute suite — filesystem cmdlets.
 *
 * Get-ChildItem (-Path/-Filter/-Include/-Exclude/-Recurse/-Depth/
 *   -File/-Directory/-Force/-Name), Get-Content (-Raw/-TotalCount/
 *   -Tail/-ReadCount), Set-Content/Add-Content (-Value/-NoNewline),
 *   New-Item (-ItemType/-Value/-Force), Copy-Item/Move-Item/Remove-Item
 *   (-Recurse/-Force/-Filter), Split-Path/Join-Path/Test-Path/
 *   Resolve-Path/Get-Item, exercised in creative pipelines.
 *
 * Transcript → debug-output/cmdlets/filesystem-cmdlets-*_results_debug.txt
 */
import { describe, it, beforeEach } from 'vitest';
import { resetSim, dumpCmdletSuite } from './_cmdlet-suite';
import type { DebugCommandInput } from '../_dump';

beforeEach(resetSim);

describe('cmdlet attributes — filesystem', () => {
  it('runs a 60+ command filesystem matrix', async () => {
    const commands: DebugCommandInput[] = [
      // ── scaffolding ──────────────────────────────────────────────
      { section: 'scaffold', cmd: 'New-Item -Path C:\\Lab -ItemType Directory -Force | Out-Null' },
      'New-Item -Path C:\\Lab\\sub1 -ItemType Directory -Force | Out-Null',
      'New-Item -Path C:\\Lab\\sub1\\deep -ItemType Directory -Force | Out-Null',
      'New-Item -Path C:\\Lab\\sub2 -ItemType Directory -Force | Out-Null',
      '1..6 | ForEach-Object { Set-Content -Path "C:\\Lab\\file$_.txt" -Value ("x" * $_) }',
      'Set-Content -Path C:\\Lab\\sub1\\inner.log -Value "alpha`nbeta`ngamma"',
      'Set-Content -Path C:\\Lab\\sub1\\deep\\nested.txt -Value "deep-content"',
      'New-Item -Path C:\\Lab\\readme.md -ItemType File -Value "# Title" -Force | Out-Null',

      // ── New-Item attributes ──────────────────────────────────────
      { section: 'New-Item', cmd: 'New-Item -Path C:\\Lab\\fresh.txt -ItemType File -Value "hello"' },
      'New-Item -Path C:\\Lab\\fresh.txt -ItemType File -Value "again" -Force',
      'New-Item C:\\Lab\\d2 -ItemType Directory',
      '(New-Item -Path C:\\Lab\\x.txt -ItemType File -Value "v").FullName',

      // ── Get-ChildItem attributes ─────────────────────────────────
      { section: 'Get-ChildItem', cmd: 'Get-ChildItem C:\\Lab' },
      'Get-ChildItem C:\\Lab -File',
      'Get-ChildItem C:\\Lab -Directory',
      'Get-ChildItem C:\\Lab -Name',
      'Get-ChildItem C:\\Lab -Filter *.txt',
      'Get-ChildItem C:\\Lab -Recurse',
      'Get-ChildItem C:\\Lab -Recurse -File',
      'Get-ChildItem C:\\Lab -Recurse -Directory',
      'Get-ChildItem C:\\Lab -Recurse -Filter *.txt | Select-Object -ExpandProperty Name',
      'Get-ChildItem C:\\Lab -Include *.txt -Recurse',
      'Get-ChildItem C:\\Lab -Force',
      'Get-ChildItem C:\\Lab -Recurse | Where-Object { -not $_.PSIsContainer } | Measure-Object',
      'Get-ChildItem C:\\Lab -Recurse -Name | Sort-Object',
      '(Get-ChildItem C:\\Lab -File | Measure-Object Length -Sum).Sum',
      'Get-ChildItem C:\\Lab | Sort-Object Length -Descending | Select-Object -First 3 Name, Length',
      'Get-ChildItem C:\\Lab | Group-Object PSIsContainer | Select-Object Name, Count',
      'Get-ChildItem C:\\Lab\\*.txt',
      'Get-ChildItem C:\\Lab -Recurse -Depth 1',

      // ── Get-Content attributes ───────────────────────────────────
      { section: 'Get-Content', cmd: 'Get-Content C:\\Lab\\sub1\\inner.log' },
      'Get-Content C:\\Lab\\sub1\\inner.log -Raw',
      'Get-Content C:\\Lab\\sub1\\inner.log -TotalCount 2',
      'Get-Content C:\\Lab\\sub1\\inner.log -Tail 1',
      '(Get-Content C:\\Lab\\sub1\\inner.log).Count',
      'Get-Content C:\\Lab\\sub1\\inner.log | Select-String "beta"',
      'Get-Content C:\\Lab\\sub1\\inner.log | Measure-Object -Line',
      '1..20 | Set-Content C:\\Lab\\nums.txt; Get-Content C:\\Lab\\nums.txt -Tail 3',
      'Get-Content C:\\Lab\\nums.txt -TotalCount 5 | ForEach-Object { [int]$_ * 2 }',
      'Get-Content C:\\Lab\\readme.md -Raw',

      // ── Set-Content / Add-Content ────────────────────────────────
      { section: 'Set/Add-Content', cmd: 'Set-Content -Path C:\\Lab\\acc.txt -Value "first"' },
      'Add-Content -Path C:\\Lab\\acc.txt -Value "second"',
      'Add-Content -Path C:\\Lab\\acc.txt -Value "third"',
      'Get-Content C:\\Lab\\acc.txt',
      '"a","b","c" | Set-Content C:\\Lab\\multi.txt; Get-Content C:\\Lab\\multi.txt',
      'Set-Content -Path C:\\Lab\\nn.txt -Value "noeol" -NoNewline; (Get-Content C:\\Lab\\nn.txt -Raw)',

      // ── Copy / Move / Remove ─────────────────────────────────────
      { section: 'Copy/Move/Remove', cmd: 'Copy-Item C:\\Lab\\file1.txt C:\\Lab\\file1-copy.txt; Test-Path C:\\Lab\\file1-copy.txt' },
      'Copy-Item C:\\Lab\\sub1 C:\\Lab\\sub1-copy -Recurse; Get-ChildItem C:\\Lab\\sub1-copy -Recurse -Name',
      'Move-Item C:\\Lab\\file1-copy.txt C:\\Lab\\file1-moved.txt; Test-Path C:\\Lab\\file1-moved.txt',
      'Remove-Item C:\\Lab\\file1-moved.txt; Test-Path C:\\Lab\\file1-moved.txt',
      'Remove-Item C:\\Lab\\sub2 -Recurse -Force; Test-Path C:\\Lab\\sub2',
      'Get-ChildItem C:\\Lab -Filter file*.txt | Remove-Item; Get-ChildItem C:\\Lab -Filter file*.txt',
      'New-Item C:\\Lab\\tmp\\a.txt -ItemType File -Force | Out-Null; Remove-Item C:\\Lab\\tmp -Recurse -Force; Test-Path C:\\Lab\\tmp',

      // ── Split-Path / Join-Path / Resolve-Path / Get-Item ─────────
      { section: 'path cmdlets', cmd: 'Split-Path C:\\Lab\\sub1\\inner.log' },
      'Split-Path C:\\Lab\\sub1\\inner.log -Leaf',
      'Split-Path C:\\Lab\\sub1\\inner.log -Parent',
      'Split-Path C:\\Lab\\sub1\\inner.log -Extension',
      'Split-Path C:\\Lab\\sub1\\inner.log -LeafBase',
      'Split-Path C:\\Lab\\sub1\\inner.log -Qualifier',
      'Join-Path C:\\Lab sub1',
      'Join-Path C:\\Lab (Join-Path sub1 deep)',
      'Test-Path C:\\Lab\\sub1\\deep\\nested.txt',
      'Test-Path C:\\Lab\\does-not-exist',
      'Test-Path C:\\Lab -PathType Container',
      'Test-Path C:\\Lab\\readme.md -PathType Leaf',
      'Get-Item C:\\Lab | Format-List Name, FullName, Mode',
      '(Get-Item C:\\Lab\\readme.md).Length',
      'Resolve-Path C:\\Lab\\sub1',

      // ── creative cross-cmdlet combinations ───────────────────────
      { section: 'creative combos', cmd: 'Get-ChildItem C:\\Lab -Recurse -File | Sort-Object Length -Descending | Select-Object -First 3 Name, Length' },
      'Get-ChildItem C:\\Lab -Recurse -File | Group-Object Extension | Select-Object Name, Count',
      'Get-ChildItem C:\\Lab -Recurse -File | ForEach-Object { [pscustomobject]@{ File=$_.Name; Bytes=$_.Length } } | Sort-Object Bytes -Descending',
      'Get-ChildItem C:\\Lab -Recurse -Name | Where-Object { $_ -match "\\.txt$" } | Sort-Object',
      '(Get-ChildItem C:\\Lab -Recurse -File | Measure-Object Length -Sum -Average -Maximum)',
      'Get-ChildItem C:\\Lab -File | Select-Object Name, @{N="KB";E={[math]::Round($_.Length/1KB,3)}} | Format-Table -AutoSize',
      'Get-ChildItem C:\\Lab -Recurse -File | ConvertTo-Json -Depth 1 | ConvertFrom-Json | Measure-Object',
      'Get-Content C:\\Lab\\nums.txt | Where-Object { [int]$_ % 5 -eq 0 } | Measure-Object -Sum',
      'Get-ChildItem C:\\Lab -Directory | ForEach-Object { "$($_.Name): $((Get-ChildItem $_.FullName -Recurse -File | Measure-Object).Count) files" }',
      'Get-ChildItem C:\\Lab -Recurse -File | Select-Object FullName | ConvertTo-Csv -NoTypeInformation',
    ];
    await dumpCmdletSuite('filesystem-cmdlets', commands);
  });
});
