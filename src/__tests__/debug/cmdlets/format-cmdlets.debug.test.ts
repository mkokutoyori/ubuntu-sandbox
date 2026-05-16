/**
 * Cmdlet attribute suite — Format-Table / Format-List / Format-Wide /
 * Out-String / Get-Member.
 *
 * Format-Table: positional + -Property, -AutoSize, -Wrap, -GroupBy,
 *   -HideTableHeaders. Format-List: -Property, default vs explicit.
 *   Format-Wide: -Column. Out-String: -Stream/-Width. Get-Member:
 *   -MemberType, -Static, -Name, -InputObject.
 *
 * Transcript → debug-output/cmdlets/format-cmdlets-*_results_debug.txt
 */
import { describe, it, beforeEach } from 'vitest';
import { resetSim, dumpCmdletSuite } from './_cmdlet-suite';
import type { DebugCommandInput } from '../_dump';

beforeEach(resetSim);

describe('cmdlet attributes — Format / Out / Get-Member', () => {
  it('runs a 55+ command formatting matrix', async () => {
    const commands: DebugCommandInput[] = [
      // ── Format-Table ─────────────────────────────────────────────
      { section: 'Format-Table', cmd: 'Get-Process | Select-Object -First 5 | Format-Table' },
      'Get-Process | Select-Object -First 5 | Format-Table Name, Id, WS',
      'Get-Process | Select-Object -First 5 | Format-Table Name, Id -AutoSize',
      'Get-Service | Select-Object -First 5 | Format-Table Name, Status, StartType -AutoSize',
      'Get-Service | Format-Table -Property Name, Status -First 5',
      'Get-Process | Select-Object -First 8 | Format-Table Name, WS -GroupBy SI',
      'Get-Service | Select-Object -First 6 | Format-Table Name, Status -HideTableHeaders',
      'Get-ChildItem C:\\ | Format-Table Name, Mode, Length -AutoSize',
      'Get-Process | Sort-Object WS -Descending | Select-Object -First 5 | Format-Table Name, @{N="MB";E={[math]::Round($_.WS/1KB,1)}}',
      '1..5 | ForEach-Object { [pscustomobject]@{ N=$_; Sq=$_*$_; Cube=$_*$_*$_ } } | Format-Table -AutoSize',
      'Get-Service | Group-Object Status | Format-Table Name, Count -AutoSize',
      'Get-Process | Select-Object -First 3 | Format-Table * ',
      "'a','bb','ccc' | ForEach-Object { [pscustomobject]@{ S=$_; L=$_.Length } } | Format-Table -AutoSize",
      'Get-Process | Select-Object -First 4 Name, Id, WS | Format-Table -Wrap',

      // ── Format-List ──────────────────────────────────────────────
      { section: 'Format-List', cmd: 'Get-Process | Select-Object -First 1 | Format-List' },
      'Get-Process | Select-Object -First 1 | Format-List Name, Id, WS',
      'Get-Service | Select-Object -First 2 | Format-List Name, Status, StartType, DisplayName',
      'Get-ChildItem C:\\ | Select-Object -First 2 | Format-List *',
      'Get-Process | Select-Object -First 2 | Format-List Name, Id',
      '1..3 | ForEach-Object { [pscustomobject]@{ Index=$_; Value=$_*10 } } | Format-List',
      '(Get-Service | Select-Object -First 1 | Format-List | Out-String).Length -gt 0',
      'Get-Service Spooler | Format-List *',

      // ── Format-Wide ──────────────────────────────────────────────
      { section: 'Format-Wide', cmd: 'Get-Process | Select-Object -First 12 | Format-Wide Name' },
      'Get-Process | Select-Object -First 12 | Format-Wide Name -Column 3',
      'Get-Service | Select-Object -First 10 | Format-Wide Name -Column 2',
      '1..20 | Format-Wide -Column 5',
      'Get-ChildItem C:\\ | Format-Wide Name -Column 4',

      // ── Out-String ───────────────────────────────────────────────
      { section: 'Out-String', cmd: 'Get-Process | Select-Object -First 3 | Out-String' },
      'Get-Service | Select-Object -First 3 Name, Status | Out-String',
      '1..5 | Out-String',
      '(1..10 | Out-String).GetType().Name',
      'Get-Process | Select-Object -First 2 | Format-Table Name, Id | Out-String',
      "'one','two','three' | Out-String -Stream",
      'Get-Service | Select-Object -First 3 | Out-String -Width 40',

      // ── Get-Member ───────────────────────────────────────────────
      { section: 'Get-Member', cmd: 'Get-Process | Select-Object -First 1 | Get-Member' },
      'Get-Process | Select-Object -First 1 | Get-Member -MemberType Property',
      'Get-Service | Select-Object -First 1 | Get-Member -MemberType Property | Select-Object -First 5 Name, MemberType',
      "'hello' | Get-Member -MemberType Method | Select-Object -First 5 Name",
      "'hello' | Get-Member -Name Length",
      '(1..5) | Get-Member | Select-Object -First 3 Name, MemberType',
      'Get-Member -InputObject (Get-Date) -MemberType Property | Select-Object -First 5 Name',
      '42 | Get-Member | Select-Object -First 3 Name',
      '[pscustomobject]@{ A=1; B=2 } | Get-Member -MemberType NoteProperty',
      'Get-Service Spooler | Get-Member -Name Status',

      // ── creative format combinations ─────────────────────────────
      { section: 'creative combos', cmd: 'Get-Process | Sort-Object WS -Descending | Select-Object -First 5 Name, WS | Format-Table -AutoSize' },
      'Get-Service | Where-Object Status -EQ Running | Group-Object StartType | Format-Table Name, Count -AutoSize',
      'Get-Process | Group-Object SI | Sort-Object Count -Descending | Format-Table Name, Count -AutoSize',
      '1..10 | ForEach-Object { [pscustomobject]@{ N=$_; Parity=if($_%2){"odd"}else{"even"} } } | Format-Table -GroupBy Parity',
      'Get-ChildItem C:\\ | Where-Object PSIsContainer | Select-Object Name | Format-Wide -Column 3',
      'Get-Service | Select-Object -First 4 Name, Status | ConvertTo-Json | Out-String',
      'Get-Process | Select-Object -First 3 Name, Id, WS | Format-List | Out-String -Stream | Where-Object { $_ -match "Name" }',
      '(Get-Service | Select-Object -First 3 | Format-Table Name, Status -AutoSize | Out-String).Trim()',
      'Get-Process | Select-Object -First 5 | Get-Member -MemberType Property | Measure-Object',
      'Get-Service | Sort-Object Status | Format-Table Name, Status -GroupBy Status -First 8',
      '1..3 | ForEach-Object { [pscustomobject]@{ X=$_; Y=$_*$_; Z=$_*$_*$_ } } | Format-List X, Z',
      'Get-Process | Select-Object -First 6 Name | Format-Wide -Column 2',
    ];
    await dumpCmdletSuite('format-cmdlets', commands);
  });
});
