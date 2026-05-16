/**
 * Cmdlet attribute suite — utility / object cmdlets.
 *
 * New-Object, [pscustomobject], Get-Date (-Format/-UFormat/arithmetic),
 * Get-Random (-Minimum/-Maximum/-Count/-InputObject/-SetSeed),
 * Set/Get/New/Clear-Variable (-Name/-Value/-Scope), Get-Command
 * (-Name/-Verb/-Noun/-CommandType), Get-Alias, Get-Member, and
 * Write-Output / Out-Null in creative pipelines.
 *
 * Transcript → debug-output/cmdlets/utility-cmdlets-*_results_debug.txt
 */
import { describe, it, beforeEach } from 'vitest';
import { resetSim, dumpCmdletSuite } from './_cmdlet-suite';
import type { DebugCommandInput } from '../_dump';

beforeEach(resetSim);

describe('cmdlet attributes — utility / object', () => {
  it('runs a 60+ command utility matrix', async () => {
    const commands: DebugCommandInput[] = [
      // ── New-Object / pscustomobject ──────────────────────────────
      { section: 'New-Object / pscustomobject', cmd: 'New-Object psobject -Property @{ Name="x"; Val=1 }' },
      'New-Object -TypeName System.Collections.ArrayList',
      '$l = New-Object System.Collections.ArrayList; $l.Add(1) | Out-Null; $l.Add(2) | Out-Null; $l.Count',
      '[pscustomobject]@{ A=1; B=2; C=3 }',
      '[pscustomobject]@{ A=1; B=2 } | Get-Member -MemberType NoteProperty | Select-Object Name',
      '1..3 | ForEach-Object { [pscustomobject]@{ Idx=$_; Square=$_*$_ } } | Format-Table -AutoSize',
      '$o = [pscustomobject]@{ X=10; Y=20 }; $o.X + $o.Y',
      'New-Object psobject -Property @{ a=1 } | ConvertTo-Json',

      // ── Get-Date ─────────────────────────────────────────────────
      { section: 'Get-Date', cmd: 'Get-Date -Format "yyyy-MM-dd"' },
      'Get-Date -Format "HH:mm"',
      'Get-Date -Format "dddd"',
      '(Get-Date).Year -gt 2000',
      '(Get-Date).GetType().Name',
      '(Get-Date -Year 2020 -Month 6 -Day 15).Month',
      '(Get-Date).AddDays(7) -gt (Get-Date)',
      '(Get-Date).DayOfWeek',
      "Get-Date -Date '2024-01-15' -Format 'MM/dd/yyyy'",
      '((Get-Date).AddHours(-2)) -lt (Get-Date)',
      '(Get-Date) - (Get-Date).AddDays(-1) | Select-Object -ExpandProperty Days',

      // ── Get-Random ───────────────────────────────────────────────
      { section: 'Get-Random', cmd: 'Get-Random -Minimum 1 -Maximum 2' },
      '(Get-Random -Minimum 0 -Maximum 1) -in 0,1',
      'Get-Random -SetSeed 42 -Minimum 1 -Maximum 100; Get-Random -SetSeed 42 -Minimum 1 -Maximum 100',
      '1..10 | Get-Random -Count 3 | Measure-Object',
      '(Get-Random -InputObject @(1,2,3,4,5)) -in 1..5',
      '1..100 | Get-Random -Count 5 | Sort-Object',
      "Get-Random -InputObject 'a','b','c'",
      '(1..1000 | Get-Random -Count 10 | Where-Object { $_ -ge 1 -and $_ -le 1000 } | Measure-Object).Count',

      // ── Variables ────────────────────────────────────────────────
      { section: 'Set/Get/New/Clear-Variable', cmd: 'Set-Variable -Name v1 -Value 42; Get-Variable -Name v1 -ValueOnly' },
      'New-Variable -Name pi -Value 3.14159; $pi',
      'Set-Variable greeting "hello"; (Get-Variable greeting).Value',
      'Set-Variable -Name arr -Value (1..5); ($arr | Measure-Object -Sum).Sum',
      'New-Variable -Name k -Value 7; Set-Variable -Name k -Value ($k * 6); $k',
      'Clear-Variable -Name greeting; $null -eq $greeting',
      'Set-Variable -Name dyn -Value (Get-Service | Measure-Object).Count; $dyn -gt 0',
      '$x = 10; Set-Variable x 99; $x',

      // ── Get-Command / Get-Alias ──────────────────────────────────
      { section: 'Get-Command / Get-Alias', cmd: 'Get-Command Get-Process' },
      'Get-Command -Verb Get -CommandType Cmdlet | Select-Object -First 5 Name',
      'Get-Command -Noun Object | Select-Object Name',
      'Get-Command Get-* -CommandType Cmdlet | Measure-Object',
      '(Get-Command -CommandType Alias | Measure-Object).Count -gt 10',
      'Get-Command -Name Sort-Object | Select-Object Name, CommandType',
      'Get-Alias ls',
      'Get-Alias | Where-Object { $_.Definition -eq "get-childitem" } | Select-Object Name',
      'Get-Command -Verb Set -CommandType Cmdlet | Sort-Object Name | Select-Object -First 5 Name',
      'Get-Command *Service* | Select-Object -First 5 Name',

      // ── Get-Member deep ──────────────────────────────────────────
      { section: 'Get-Member', cmd: '(Get-Date) | Get-Member -MemberType Method | Select-Object -First 5 Name' },
      '"text" | Get-Member -Name Substring',
      '@(1,2,3) | Get-Member -MemberType Property | Select-Object -First 3 Name',
      '[pscustomobject]@{ q=1 } | Get-Member | Where-Object MemberType -EQ NoteProperty',

      // ── Write-Output / Out-Null ──────────────────────────────────
      { section: 'Write-Output / Out-Null', cmd: 'Write-Output 1 2 3' },
      'Write-Output (1..5) | Measure-Object -Sum',
      'Write-Output "single"',
      '1..10 | Out-Null',
      '(1..10 | Out-Null) -eq $null',
      'Write-Output @(1,2,3),@(4,5,6)',

      // ── creative cross-cmdlet combinations ───────────────────────
      { section: 'creative combos', cmd: '1..5 | ForEach-Object { [pscustomobject]@{ N=$_; R=(Get-Random -SetSeed $_ -Minimum 0 -Maximum 10) } } | Sort-Object R' },
      'Get-Command -Verb Get -CommandType Cmdlet | Group-Object { $_.Name.Split("-")[1].Length } | Sort-Object Name | Select-Object Name, Count',
      '1..3 | ForEach-Object { New-Object psobject -Property @{ Index=$_; Stamp=(Get-Date -Format "yyyy") } } | Format-Table -AutoSize',
      'Set-Variable -Name nums -Value (1..20); ($nums | Where-Object { $_ % 3 -eq 0 } | Measure-Object -Sum).Sum',
      '(Get-Command -CommandType Cmdlet | Select-Object -ExpandProperty Name | Sort-Object | Select-Object -First 5)',
      '[pscustomobject]@{ when=(Get-Date -Format "yyyy-MM-dd"); rand=(Get-Random -SetSeed 1 -Maximum 100) } | ConvertTo-Json',
      'Get-Alias | Group-Object Definition | Sort-Object Count -Descending | Select-Object -First 5 Name, Count',
      '1..10 | ForEach-Object { Get-Random -SetSeed $_ -Minimum 1 -Maximum 7 } | Group-Object | Sort-Object Name | Select-Object Name, Count',
      'Get-Command -Noun Object | Sort-Object Name | ForEach-Object { $_.Name } | Select-String "Object$"',
      '$total=0; 1..50 | ForEach-Object { Set-Variable -Name total -Value ($total + $_) }; $total',
      'New-Object psobject -Property @{ A=(1..5); B=(Get-Service|Measure-Object).Count } | ConvertTo-Json -Depth 2',
    ];
    await dumpCmdletSuite('utility-cmdlets', commands);
  });
});
