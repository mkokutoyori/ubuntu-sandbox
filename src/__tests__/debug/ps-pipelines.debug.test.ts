/**
 * Debug run — complex pipelines, scriptblocks & operators.
 *
 * Focuses on the parts of PowerShell where bugs are most likely to hide:
 *   - chained Where-Object / Sort-Object / Group-Object / Measure-Object
 *   - ForEach-Object with `$_` (closure semantics)
 *   - comparison / matching operators (-match, -like, -contains, -in)
 *   - splatting, ranges, arithmetic
 *   - calculated properties in Select-Object
 *   - Tee-Object and Out-* targets
 *
 * Transcript → `debug-output/ps-pipelines_results_debug.txt`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { runAndDump, type DebugCommandInput } from './_dump';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('debug — PowerShell pipelines & operators', () => {
  it('runs pipeline-heavy commands and writes the transcript', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-PIPE-DBG');
    pc.setCurrentUser('Administrator');
    const ps = new PowerShellExecutor(pc);

    const commands: DebugCommandInput[] = [
      // ── 1. ranges / arithmetic / arrays ───────────────────────────
      { section: 'ranges & arithmetic', cmd: '1..5' },
      '1..10 | Measure-Object -Sum',
      '1..10 | Measure-Object -Sum -Average -Min -Max',
      '1..100 | Where-Object { $_ % 2 -eq 0 } | Measure-Object -Sum',
      '1..50 | Where-Object { $_ % 3 -eq 0 -and $_ % 5 -eq 0 }',
      '1..20 | ForEach-Object { $_ * $_ }',
      '(1..10 | ForEach-Object { $_ * 2 })',
      '1..10 | Where-Object { $_ -gt 3 } | Where-Object { $_ -lt 8 }',
      '1..10 | Sort-Object -Descending',
      '5..1',
      '(1..1000 | Measure-Object -Sum).Sum',
      '@(1,2,3) + @(4,5,6)',
      '@(1,2,3,2,1) | Sort-Object -Unique',
      '@(3,1,4,1,5,9,2,6,5,3,5) | Sort-Object | Get-Unique',

      // ── 2. ForEach-Object closure semantics ───────────────────────
      { section: 'ForEach-Object closures', cmd: '1..3 | ForEach-Object { "[$_]" }' },
      '1..3 | ForEach-Object -Begin { $sum=0 } -Process { $sum+=$_ } -End { $sum }',
      '"a","b","c" | ForEach-Object { $_.ToUpper() }',
      '"abc","de","fghij" | ForEach-Object { $_.Length }',
      '"abc","de","fghij" | ForEach-Object { [pscustomobject]@{ S=$_; L=$_.Length } }',
      '1..5 | ForEach-Object { @{ n=$_; sq=$_*$_ } }',
      '@(@{ k="a"; v=1 }, @{ k="b"; v=2 }) | ForEach-Object { "$($_.k)=$($_.v)" }',
      '1..3 | ForEach-Object { if ($_ -eq 2) { return }; $_ }',
      '"x","y","z" | ForEach-Object { "$_-$_" }',

      // ── 3. Where-Object variants ──────────────────────────────────
      { section: 'Where-Object', cmd: '1..10 | Where-Object { $_ -gt 5 }' },
      '1..10 | Where-Object { $_ -lt 5 -or $_ -gt 8 }',
      '1..10 | ? { $_ % 2 -eq 0 }',
      '"alpha","beta","gamma","delta" | Where-Object { $_ -like "*a" }',
      '"alpha","beta","gamma","delta" | Where-Object { $_ -match "^[ab]" }',
      '"alpha","beta","gamma","delta" | Where-Object { $_ -notmatch "^[ab]" }',
      '1..10 | Where-Object { $_ -in @(2,4,6,8) }',
      '@("a","b","c","d") | Where-Object { $_ -in @("b","d") }',

      // ── 4. Sort / Group ───────────────────────────────────────────
      { section: 'Sort / Group', cmd: '@("banana","apple","cherry") | Sort-Object' },
      '@("banana","apple","cherry") | Sort-Object -Descending',
      '@("banana","apple","cherry","apple") | Sort-Object -Unique',
      'Get-Process | Sort-Object Name | Select-Object -First 5 Name, Id',
      'Get-Process | Sort-Object -Property CPU -Descending | Select-Object -First 3 Name, CPU',
      'Get-Process | Group-Object ProcessName | Sort-Object Count -Descending | Select-Object -First 5',
      '1..20 | Group-Object { $_ % 3 } | Format-Table Name, Count -AutoSize',
      '"alpha","beta","gamma","delta","epsilon" | Group-Object Length',
      'Get-Service | Group-Object Status | ForEach-Object { "$($_.Name): $($_.Count)" }',

      // ── 5. Select-Object & calculated properties ──────────────────
      { section: 'Select-Object', cmd: 'Get-Process | Select-Object -First 3 Name, Id' },
      'Get-Process | Select-Object -First 3 -Property Name, Id, @{ Name="kbWS"; Expression={ [int]($_.WS/1024) } }',
      'Get-Process | Select-Object -First 5 -Property Name, @{ N="UpperName"; E={ $_.Name.ToUpper() } }',
      '1..3 | Select-Object @{ N="Doubled"; E={ $_ * 2 } }',
      'Get-Service | Select-Object Name, Status -First 5',
      'Get-Service | Select-Object Name, Status -Last 5',
      'Get-Service | Select-Object -Unique Status',
      'Get-Process | Select-Object -ExpandProperty Name | Sort-Object | Get-Unique | Select-Object -First 5',
      '"a","b","c" | Select-Object @{ N="L"; E={ $_ } }, @{ N="U"; E={ $_.ToUpper() } }',

      // ── 6. Measure-Object on strings ──────────────────────────────
      { section: 'Measure-Object on strings',
        cmd: '"hello world" | Measure-Object -Word -Character -Line' },
      'Get-Content (Join-Path $env:TEMP "doesnotexist") -ErrorAction SilentlyContinue | Measure-Object',
      '"line1`nline2`nline3" -split "`n" | Measure-Object',
      '"red","green","blue" | Measure-Object -Character',
      '"x","y","z","x","y" | Group-Object | Measure-Object -Property Count -Sum',

      // ── 7. comparison / matching operators ────────────────────────
      { section: 'operators', cmd: '"PowerShell" -like "*Shell"' },
      '"PowerShell" -like "powershell"',
      '"PowerShell" -clike "powershell"',
      '"PowerShell" -match "^[Pp]ower"',
      '"abc-123-xyz" -match "(\\w+)-(\\d+)-(\\w+)"',
      '$Matches',
      '"a","b","c","d" -contains "b"',
      '"b" -in @("a","b","c")',
      '5 -gt 3',
      '5 -ge 5',
      '5 -lt 3',
      '$null -eq $null',
      '"" -eq $null',
      '@() -eq $null',
      '5 -is [int]',
      '"a" -is [string]',
      '"abc" -replace "b","B"',
      '"alpha,beta,gamma" -split ","',
      '@("a","b","c") -join "-"',

      // ── 8. splatting & function calls ─────────────────────────────
      { section: 'splatting & functions',
        cmd: '$p = @{ Path = "C:\\Splat"; ItemType = "Directory"; Force = $true }; New-Item @p' },
      'Test-Path C:\\Splat',
      'Remove-Item C:\\Splat -Force',
      'function Add-Two { param($a,$b) $a + $b }; Add-Two 3 4',
      'function Multiply { param($x,$y) $x * $y }; Multiply -x 5 -y 6',
      'function Repeat { param($Text, [int]$Count=3) for ($i=0;$i -lt $Count;$i++) { $Text } }; Repeat -Text "hi" -Count 3',
      'function Sum { param([int[]]$Nums) $Nums | Measure-Object -Sum | Select-Object -ExpandProperty Sum }; Sum -Nums 1,2,3,4,5',
      'filter Double { $_ * 2 }; 1..5 | Double',
      'filter Even { if ($_ % 2 -eq 0) { $_ } }; 1..10 | Even',

      // ── 9. control flow ───────────────────────────────────────────
      { section: 'control flow',
        cmd: 'for ($i=1; $i -le 5; $i++) { "i=$i" }' },
      '$j = 0; while ($j -lt 3) { "j=$j"; $j++ }',
      '$k = 5; do { "k=$k"; $k-- } while ($k -gt 0)',
      'foreach ($n in 1..3) { "n=$n" }',
      'switch (3) { 1 { "one" } 2 { "two" } 3 { "three" } default { "other" } }',
      'switch -Regex ("foo123") { "^foo" { "matched-foo" } "\\d+$" { "matched-digits" } }',
      'if ($true) { "yes" } else { "no" }',
      'if ($false) { "yes" } elseif ($true) { "elif" } else { "no" }',

      // ── 10. composed real-world pipelines ─────────────────────────
      { section: 'composed real-world',
        cmd: 'Get-Process | Sort-Object WS -Descending | Select-Object -First 5 -Property Name, Id, @{ N="MB"; E={ [int]($_.WS/1MB) } } | Format-Table -AutoSize' },
      'Get-Service | Where-Object { $_.Status -eq "Running" } | Sort-Object Name | ForEach-Object { "[RUN] $($_.Name)" }',
      'New-Item -Path C:\\PipeTest -ItemType Directory -Force | Out-Null; 1..10 | ForEach-Object { Set-Content -Path "C:\\PipeTest\\f$_.txt" -Value "row $_" }; Get-ChildItem C:\\PipeTest | Measure-Object Length -Sum',
      'Get-ChildItem C:\\PipeTest | Sort-Object Length -Descending | Select-Object -First 3 Name, Length',
      'Get-ChildItem C:\\PipeTest | ForEach-Object { (Get-Content $_.FullName) } | Sort-Object | Get-Unique',
      'Get-ChildItem C:\\PipeTest -Recurse | Where-Object { $_.Length -gt 0 } | Measure-Object Length -Sum -Average',
      'Get-ChildItem C:\\PipeTest | ForEach-Object { [pscustomobject]@{ N=$_.Name; L=$_.Length } } | Sort-Object L -Descending | Select-Object -First 3',
      'Get-ChildItem C:\\PipeTest | Tee-Object -Variable allFiles | Measure-Object | Select-Object Count',
      '$allFiles.Count',
      'Remove-Item C:\\PipeTest -Recurse -Force',

      // ── 11. error handling in pipelines ───────────────────────────
      { section: 'error handling',
        cmd: 'try { Get-Item C:\\NoSuchFile -ErrorAction Stop } catch { "caught: $($_.Exception.Message)" }' },
      'try { 1/0 } catch { "div0: $($_.Exception.Message)" }',
      '$ErrorActionPreference = "Continue"; Get-Item C:\\NoSuchFile2 -ErrorAction SilentlyContinue; "after"',
      '$Error.Count',
      '$Error | Select-Object -First 3 | ForEach-Object { $_.Exception.Message }',

      // ── 12. output redirection ────────────────────────────────────
      { section: 'output redirection', cmd: 'Get-Process | Select-Object -First 3 | Out-Null' },
      'Get-Process | Select-Object -First 3 Name | Out-String',
      '"hello" | Out-String -Stream',
      'Write-Output "stream-1"; Write-Output "stream-2"',
      'Write-Warning "be careful"',
      '1..3 | Write-Output',
    ];

    await runAndDump('ps-pipelines', commands, ps,
      'host=WIN-PIPE-DBG (windows-pc)');
    expect(commands.length).toBeGreaterThanOrEqual(100);
  }, 180_000);
});
