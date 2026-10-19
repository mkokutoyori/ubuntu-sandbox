/**
 * Probe — introspection des fonctions et erreurs du bloc `clean` (CleanBlockErrorHandling.Tests.ps1 de PowerShell) :
 * `Write-Verbose -Verbose 'msg'` (un commutateur commun n'absorbe pas l'argument qui le suit), `(Get-Command f).ScriptBlock`
 * / `.Definition`, `$sb.Ast.Extent.Text` (texte source de la fonction ou du bloc), affichage a quatre colonnes d'une
 * fonction, et une erreur levee dans `clean` ne remonte pas : elle va dans le flux d'erreur de l'hote et arrete le bloc.
 * Discrimination : sur la base e68cc2607, 8 cas rouges sur 11.
 * Temoins (3, verts avant et apres) : `Write-Verbose 'hi' -Verbose`, `(Get-Command f).CommandType`, affichage de `Get-Command f`.
 */
import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

function interactive(code: string): string {
  const interp = new PSInterpreter(undefined, { language: 'core' });
  interp.beginInteractive(code);
  return interp.resumeInteractive().replace(/\r?\n/g, '|');
}

const HOST = "$p = [PowerShell]::Create(); $p.AddScript((Get-Command F).ScriptBlock.Ast.Extent.Text).Invoke(); $p.Commands.Clear(); $p.AddCommand('F') > $null; $p.Invoke();";

const CASES: Array<[string, string]> = [
  ["Write-Verbose -Verbose 'hi'", 'VERBOSE: hi'],
  ['Write-Verbose -Verbose "hi there"', 'VERBOSE: hi there'],
  ["function F { [CmdletBinding()]param() Write-Verbose -Verbose 'in-f' }; F", 'VERBOSE: in-f'],
  ["function Foo { 'x' }; (Get-Command Foo).ScriptBlock.Ast.Extent.Text", "function Foo { 'x' }"],
  ['$sb = { 1 + 2 }; $sb.Ast.Extent.Text', '{ 1 + 2 }'],
  ["function Foo { 'x' }; (Get-Command Foo).Definition", "'x'"],
  ["function Foo { 'x' }; Get-Command Foo", '|CommandType Name Version Source|----------- ---- ------- ------|Function    Foo                |'],
  [`function F { [CmdletBinding()]param() end {} clean { throw 'clean-throw'; Write-Verbose -Verbose 'after' } }; ${HOST} "v=" + $p.Streams.Verbose.Count; "e=" + $p.Streams.Error.Count; $p.Streams.Error[0].Exception.Message`, 'v=0|e=1|clean-throw'],
  ["Write-Verbose 'hi' -Verbose", 'VERBOSE: hi'],
  ['function Foo { 1 }; (Get-Command Foo).CommandType', 'Function'],
  [`function F { [CmdletBinding()]param() end {} clean { Write-Verbose -Verbose 'cleaned' } }; ${HOST} "v=" + $p.Streams.Verbose.Count`, 'v=1'],
];

describe('introspection des fonctions et bloc clean', () => {
  for (const [code, expected] of CASES) {
    it(code.slice(0, 90), () => {
      expect(interactive(code)).toBe(expected);
    });
  }
});
