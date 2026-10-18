/**
 * Probe — fonctions avancees mesurees par le harnais Pester (CommonParameters, OutErrorVariable, CmdletDeclaration) :
 * parametres communs d'une fonction `[CmdletBinding()]` (-Verbose/-Debug/-ErrorAction/-WarningAction/-InformationAction
 * et leurs alias, variables de preference portees par la portee de la fonction), -ErrorVariable/-WarningVariable/
 * -InformationVariable/-OutVariable (remplacement et `+nom`, portees `script:`), imbrication (seul le dernier etage d'un
 * pipeline remonte au collecteur du parent), -PipelineVariable, `$PSCmdlet` (WriteObject/WriteError/ShouldProcess/
 * ParameterSetName/ThrowTerminatingError), redirections de flux (`2>`, `3>&1`, `*>`, `2>&1 > $null`), `[ref]`,
 * `[powershell]` (Streams.* et InvocationStateInfo), `[PSParser]::Tokenize`, mot nu colle a une variable (`+$x`, `foo$x`),
 * `Get-Variable -ValueOnly nom`.
 * Discrimination : sur la base c61aa5aef, 63 cas rouges sur 77 (dont `@($vide.Propriete)` : un tableau vide enumere RIEN, `@($null.x)` garde 1 element).
 * Temoins (14, verts avant et apres) : fonction avancee sans parametre commun (Write-Verbose, Write-Debug, Write-Information
 * silencieux par defaut, Write-Warning affiche, `-Verbose:$false`), fonction simple, `Write-Output`, expansion `"a $x"`,
 * `1,2 | ForEach-Object`, `[int]::Parse`, `Write-Output +abc`, `@($null.x)`.
 */
import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

function run(code: string): string {
  return new PSInterpreter(undefined, { language: 'core' }).execute(code).replace(/\r?\n/g, '|');
}

const ADVANCED = 'function g { [CmdletBinding()] param() ';

const VALUES: Array<[string, string]> = [
  [`${ADVANCED}'o'; Write-Verbose 'v' }; g`, 'o'],
  [`${ADVANCED}'o'; Write-Verbose 'v' }; g -Verbose`, 'o|VERBOSE: v'],
  [`${ADVANCED}'o'; Write-Verbose 'v' }; g -vb`, 'o|VERBOSE: v'],
  [`${ADVANCED}'o'; Write-Verbose 'v' }; g -Verbose:$false`, 'o'],
  [`${ADVANCED}Write-Debug 'd' }; g -Debug`, 'DEBUG: d'],
  [`${ADVANCED}Write-Debug 'd' }; g`, ''],
  [`${ADVANCED}Write-Warning 'w' }; g`, 'WARNING: w'],
  [`${ADVANCED}Write-Warning 'w' }; g -WarningAction SilentlyContinue`, ''],
  [`${ADVANCED}Write-Warning 'w' }; g -wa SilentlyContinue -WarningVariable wv; $wv.Count`, '1'],
  [`${ADVANCED}Write-Warning 'w' }; g -WarningAction SilentlyContinue -WarningVariable wv; $wv[0].Message`, 'w'],
  [`${ADVANCED}Write-Information 'i' }; g`, ''],
  [`${ADVANCED}Write-Information 'i' }; g -InformationAction Continue`, 'i'],
  [`${ADVANCED}Write-Information 'i' }; g -InformationVariable iv; $iv.Count`, '1'],
  [`${ADVANCED}Write-Information 'i' }; g -iv iv; $iv[0].MessageData`, 'i'],
  [`${ADVANCED}Write-Error 'e'; 'after' }; try { g -ErrorAction Stop } catch { $_.Exception.Message }`,
    'The running command stopped because the preference variable "ErrorActionPreference" or common parameter is set to Stop: e'],
  [`${ADVANCED}Write-Error 'e'; 'after' }; g -ErrorAction SilentlyContinue`, 'after'],
  [`${ADVANCED}Write-Error 'e'; 'after' }; g -ea Ignore`, 'after'],
  [`${ADVANCED}Write-Error 'e'; 'o' }; g -ErrorVariable ev 2>$null; $ev.Count`, 'o|1'],
  [`${ADVANCED}Write-Error 'e'; 'o' }; g -ErrorVariable ev 2>$null; $ev[0].ToString()`, 'o|e'],
  [`${ADVANCED}Write-Error 'e'; 'o' }; g -ev ev 2>$null | Out-Null; $ev.Count`, '1'],
  [`${ADVANCED}Write-Error 'e'; 'o' }; $ev = 'a','b'; g -ErrorVariable +ev 2>$null | Out-Null; $ev.Count`, '3'],
  [`${ADVANCED}Write-Error 'e'; 'o' }; $n = 'ev'; $ev = 'a','b'; g -ErrorVariable +$n 2>$null | Out-Null; $ev -join ','`, 'a,b,e'],
  [`${ADVANCED}Write-Error 'e'; 'o' }; g -ErrorVariable script:ev 2>$null | Out-Null; $script:ev.Count`, '1'],
  [`${ADVANCED}'a'; 'b' }; g -OutVariable ov | Out-Null; $ov -join ','`, 'a,b'],
  [`${ADVANCED}'a'; 'b' }; $ov = 'x'; g -OutVariable +ov | Out-Null; $ov -join ','`, 'x,a,b'],
  [`${ADVANCED}$PSCmdlet.WriteObject('wo') }; g -ov x | Out-Null; $x`, 'wo'],
  [`${ADVANCED}$PSCmdlet.WriteObject(@(1,2), $true) }; (g).Count`, '2'],
  [`${ADVANCED}$PSCmdlet.WriteObject(@(1,2)) }; (g).Count`, '2'],
  ['function foo { [CmdletBinding()] param() "foo" }; function bar { [CmdletBinding()] param() "bar"; foo -OutVariable script:a }; bar -OutVariable b | Out-Null; ($b -join ",") + "|" + $script:a',
    'bar,foo|foo'],
  ['function foo { [CmdletBinding()] param() Write-Error "foo" }; function bar { [CmdletBinding()] param() Write-Error "bar"; foo -ErrorVariable script:a }; bar -ErrorVariable b 2>$null; ($b | ForEach-Object { $_.ToString() }) -join ","',
    'bar,foo'],
  ['function foo { [CmdletBinding()] param([Parameter(ValueFromPipeline)]$i) process { Write-Error "foo"; $i } }; function bar { [CmdletBinding()] param() foo 1 | foo }; bar -ErrorVariable b 2>$null | Out-Null; $b.Count',
    '1'],
  ['function foo { [CmdletBinding()] param() "o"; Write-Error "e" }; function bar { [CmdletBinding()] param() foo -OutVariable script:o -ErrorVariable script:e }; bar -OutVariable bo -ErrorVariable be 2>$null | Out-Null; "$($bo -join ",")|$($be.Count)"',
    'o|1'],
  [`${ADVANCED}try { throw "x" } catch { } }; g -ErrorVariable ev; $ev.Count`, '1'],
  ['1..3 | ForEach-Object -PipelineVariable p { $_ * 2 } | ForEach-Object { "p=$p" }', 'p=2|p=4|p=6'],
  ['1..3 | ForEach-Object -pv p { $_ * 2 } | Where-Object { $p -gt 2 } | ForEach-Object { "k=$_" }', 'k=4|k=6'],
  ['function g { [CmdletBinding(SupportsShouldProcess)] param() if ($PSCmdlet.ShouldProcess("t", "act")) { "did" } }; g', 'did'],
  ['function g { [CmdletBinding(SupportsShouldProcess)] param() if ($PSCmdlet.ShouldProcess("t", "act")) { "did" } }; g -WhatIf', 'What if: Performing the operation "act" on target "t".'],
  ['function g { [CmdletBinding(SupportsShouldProcess)] param() if ($PSCmdlet.ShouldProcess("t")) { "did" } }; g -WhatIf', 'What if: Performing the operation "g" on target "t".'],
  ['function g { [CmdletBinding(SupportsShouldProcess)] param() if ($PSCmdlet.ShouldProcess("t", "act")) { "did" } }; g -Verbose', 'VERBOSE: Performing the operation "act" on target "t".|did'],
  ['function g { [CmdletBinding(SupportsShouldProcess, ConfirmImpact="None")] param() if ($PSCmdlet.ShouldProcess("t", "act")) { "did" } }; g -Confirm', 'did'],
  ['function g { [CmdletBinding(SupportsShouldProcess, ConfirmImpact="High")] param() if ($PSCmdlet.ShouldProcess("t", "act")) { "did" } }; try { g } catch { $_.Exception.Message }',
    'PowerShell is in NonInteractive mode. Read and Prompt functionality is not available.'],
  ['function g { [CmdletBinding(SupportsShouldProcess, ConfirmImpact="High")] param() if ($PSCmdlet.ShouldProcess("t", "act")) { "did" } }; g -Confirm:$false', 'did'],
  ['function g { [CmdletBinding()] param() $PSCmdlet.ParameterSetName }; g', '__AllParameterSets'],
  ['function g { [CmdletBinding(DefaultParameterSetName="A")] param([Parameter(ParameterSetName="A")]$a, [Parameter(ParameterSetName="B")]$b) $PSCmdlet.ParameterSetName }; g -b 1', 'B'],
  ['function g { [CmdletBinding()] param() try { 1/0 } catch { $PSCmdlet.ThrowTerminatingError($_) } }; try { g } catch { $_.Exception.Message }', 'Attempted to divide by zero.'],
  ['function g { [CmdletBinding()] param() Write-Error "e" -ErrorAction Stop }; try { g } catch { $_.Exception.GetType().Name }', 'ActionPreferenceStopException'],
  [`${ADVANCED}Write-Error 'e'; 'o' }; $x = g 2>&1; $x.Count`, '2'],
  [`${ADVANCED}Write-Error 'e'; 'o' }; g 2>&1 > $null; 'end'`, 'end'],
  [`${ADVANCED}Write-Error 'e'; Write-Warning 'w'; 'o' }; g *> $null; 'end'`, 'end'],
  [`${ADVANCED}Write-Warning 'w'; 'o' }; $y = g 3>&1; $y.Count`, '2'],
  [`${ADVANCED}Write-Error 'e'; 'o' }; g 2> $null`, 'o'],
  ['Write-Output "x" > $null; "z"', 'z'],
  ['$e = 0; [void][int]::TryParse("5", [ref]$e); $e', '5'],
  ['$v = 1; $r = [ref]$v; $r.Value = 7; $v', '7'],
  ['function f($p) { $p.Value = 9 }; $v = 1; f ([ref]$v); $v', '9'],
  ['$x = "a"; Write-Output +$x', '+a'],
  ['$x = "a"; Write-Output foo$x', 'fooa'],
  ['$a = "foo"; Get-Variable -ValueOnly a', 'foo'],
  ['$e = $null; $t = [System.Management.Automation.PSParser]::Tokenize("Get-Date", [ref]$e); "$($t.Count)|$($e.Count)"', '1|0'],
  ['$e = $null; $t = [System.Management.Automation.PSParser]::Tokenize("{ [CmdletBinding()] param() $a }", [ref]$e); $e.Count', '0'],
  ['$ps = [powershell]::Create(); [void]$ps.AddScript("function f { [CmdletBinding()] param() Write-Verbose v; Write-Warning w }; f -Verbose"); $null = $ps.Invoke(); "$($ps.Streams.Verbose.Count)|$($ps.Streams.Warning.Count)|$($ps.Streams.Verbose[0].Message)"', '1|1|v'],
  ['$ps = [powershell]::Create(); [void]$ps.AddScript("Write-Error boom; 1"); $r = $ps.Invoke(); "$($r.Count)|$($ps.HadErrors)|$($ps.Streams.Error.Count)"', '1|True|1'],
  ['$ps = [powershell]::Create(); [void]$ps.AddScript("1"); $null = $ps.Invoke(); $ps.InvocationStateInfo.State', 'Completed'],
  ['$ps = [powershell]::Create(); [void]$ps.AddScript("Write-Error x -ErrorAction Stop"); try { $null = $ps.Invoke() } catch { "caught" }; $ps.InvocationStateInfo.State', 'caught|Failed'],
  ['$ps = [powershell]::Create(); [void]$ps.AddScript("function f { [CmdletBinding()] param() Write-Error boom; 1 }; f"); $a = $ps.BeginInvoke(); $o = $ps.EndInvoke($a); "$($o[0])|$($ps.Streams.Error.Count)"', '1|1'],
  ['function f { 1 }; f', '1'],
  ['function f { Write-Warning "w" }; f', 'WARNING: w'],
  ['function f { Write-Verbose "v"; "o" }; f', 'o'],
  ['Write-Output "w"', 'w'],
  ['$x = 1; "a $x"', 'a 1'],
  ['1,2 | ForEach-Object { $_ }', '1|2'],
  ['[int]::Parse("12")', '12'],
  ['function g { [CmdletBinding()] param() Write-Error "e" }; try { g -ErrorAction Stop } catch { "c" }', 'c'],
  ['Write-Output +abc', '+abc'],
  ['$e = @(); @($e.IPAddress).Count', '0'],
  ['@(@().a.b).Count', '0'],
  ['$o = $null; @($o.IPAddress).Count', '1'],
];

describe('lot E — fonctions avancees', () => {
  for (const [code, expected] of VALUES) {
    it(code, () => {
      expect(run(code)).toBe(expected);
    });
  }
});
