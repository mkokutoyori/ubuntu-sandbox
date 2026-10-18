/**
 * Probe — langage PowerShell, lot A2 : enumerations (EnumType, [Flags()], [Enum]::),
 * Compare-Object (algorithme de Compare-Object.cs : fenetres de synchronisation,
 * ordre d'emission), operateurs unaires -split/-join (spec 7.2.7/7.2.8), methodes
 * System.String (ordinal / culture, StringComparison), [ordered], Get-Member
 * (MemberComparer de GetMember.cs), prefixes de parametres de cmdlet.
 * Discrimination : sur la base 66d0bf89b, 33 cas rouges sur 41.
 * Temoins (8, verts avant et apres) : cast d'exception, Sort-Object, Get-Member -Name, Split() simple, Trim, IndexOf minuscule, Replace minuscule, Count.
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const CASES: Array<[string, string]> = [
  ["enum Color2 { Red; Green; Blue }; [Color2]::Green", "Green"],
  ["enum Color3 { Red; Green; Blue }; [int][Color3]::Blue", "2"],
  ["enum Color4 { Red = 5; Green }; [int][Color4]::Green", "6"],
  ["enum Color5 { Red; Green }; [Color5]'Green' -eq [Color5]::Green", "True"],
  ["enum Color6 { Red; Green }; [Color6]::Green.GetType().Name", "Color6"],
  ["enum Color7 { Red; Green }; [Enum]::GetNames([Color7]) -join ','", "Red,Green"],
  ["enum Color8 { Red; Green }; \"$([Color8]::Red)\"", "Red"],
  ["enum Color10 { Red; Green }; [Color10]1", "Green"],
  ["enum Color12 { Red; Green }; [Color12]::Green -eq 'green'", "True"],
  ["enum Color13 { Red; Green }; switch ([Color13]::Green) { Red { 'r' } Green { 'g' } }", "g"],
  ["[Flags()] enum Perm { None = 0; Read = 1; Write = 2; Exec = 4 }; [Perm]'Read,Write'", "Read, Write"],
  ["[Flags()] enum Perm2 { None = 0; Read = 1; Write = 2; Exec = 4 }; [Perm2]::Read -bor [Perm2]::Exec", "Read, Exec"],
  ["[Flags()] enum Perm3 { None = 0; Read = 1; Write = 2 }; ([Perm3]'Read,Write').HasFlag([Perm3]::Write)", "True"],
  ["function f { param([DayOfWeek]$d) $d }; f Friday", "Friday"],
  ["Compare-Object 1,2,3 2,3,4 | ForEach-Object { \"$($_.InputObject)$($_.SideIndicator)\" }", "4=>\n1<="],
  ["Compare-Object 1,2,3 2,3,4 -IncludeEqual | ForEach-Object { \"$($_.InputObject)$($_.SideIndicator)\" }", "2==\n3==\n4=>\n1<="],
  ["Compare-Object 'a','b' 'b','c' -ExcludeDifferent | ForEach-Object { $_.InputObject }", "b"],
  ["'A' | Compare-Object -Reference 'a' | Measure-Object | ForEach-Object Count", "0"],
  ["-split ' red  blue green '", "red\nblue\ngreen"],
  ["-join (10,20,30)", "102030"],
  ["-join $null", ""],
  ["(-split 'a b c').Count", "3"],
  ["'Hello'.Contains('ELL')", "False"],
  ["'Hello'.StartsWith('he')", "False"],
  ["'Hello'.StartsWith('he', [StringComparison]::OrdinalIgnoreCase)", "True"],
  ["'Hello'.EndsWith('LO')", "False"],
  ["'Hello'.IndexOf('L')", "-1"],
  ["'Hello'.IndexOf('L', [StringComparison]::OrdinalIgnoreCase)", "2"],
  ["'Hello'.Replace('L','x')", "Hello"],
  ["'a,b,,c'.Split(',', [StringSplitOptions]::RemoveEmptyEntries) -join '|'", "a|b|c"],
  ["'Hello'.Substring(9)", "Exception calling \"Substring\" with \"1\" argument(s): \"startIndex cannot be larger than length of string.\nParameter name: startIndex\""],
  ["'xxhixx'.Trim('x')", "hi"],
  ["$h = [ordered]@{a=1;b=2}; $h.GetType().Name", "OrderedDictionary"],
  ["[datetime]'2020-01-02' | Get-Date -Format 'yyyy/MM/dd'", "2020/01/02"],
  ["[pscustomobject]@{a=1} | Get-Member -MemberType NoteProperty | ForEach-Object Definition", "int a=1"],
  ["[pscustomobject]@{a=1} | Get-Member -Name a | ForEach-Object { $_.MemberType }", "NoteProperty"],
  ["[pscustomobject]@{a=1} | Get-Member | Select-Object -First 1 | ForEach-Object Name", "Equals"],
  ["[pscustomobject]@{a=1} | Get-Member | Select -Expand Name | Select -Last 1", "a"],
  ["Get-Service -Name W* | ForEach-Object { $_.Name.Substring(0,1) } | Sort-Object -Unique", "W"],
  ["Get-Service -Na LanmanWorkstation | ForEach-Object Name", "LanmanWorkstation"],
  ["1,2,3 | Select -First 2 | Measure-Object | ForEach-Object Count", "2"],
];

describe('PowerShell language lot A2', () => {
  const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
  win.setCurrentUser('Administrator');
  const sub = PowerShellSubShell.create(win).subShell;
  for (const [code, expected] of CASES) {
    it(code, async () => {
      const out = (await sub.processLine(code)).output.join('\n');
      expect(out).toBe(expected);
    });
  }
});
