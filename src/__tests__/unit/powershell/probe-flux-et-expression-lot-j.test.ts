/**
 * Probe — flux d'erreur/avertissement et Invoke-Expression (DollarHook.Tests.ps1 de PowerShell) :
 * les lignes des flux (erreur, avertissement...) ne sont PAS des valeurs de sortie : `$x = f` ne les capture pas (elles restent a
 * l'ecran), y compris dans `"a $(Write-Error 'b')"` et `$(...)` ; une instruction qui n'est qu'une chaine rend `$?` vrai meme si
 * une sous-expression a ecrit une erreur ; `Invoke-Expression` rend la sortie de TOUTES ses instructions, dans la portee de
 * l'appelant ; a l'affichage, valeurs et lignes de flux gardent leur ordre d'apparition.
 * Discrimination : sur la base 773124358 (HEAD avant ce lot), 8 cas rouges sur 14.
 * Temoins (6, verts avant et apres) : `"Hi"; $?`, `Write-Error "Bad"; $?`, `Invoke-Expression "1+1"`, sortie capturee d'une fonction
 * sans erreur, ordre `o` puis `VERBOSE` d'une fonction avancee.
 */
import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

function run(code: string): string {
  const interp = new PSInterpreter(undefined, { language: 'core' });
  interp.beginInteractive(code);
  return interp.resumeInteractive().replace(/\r?\n/g, '|');
}

const CASES: Array<[string, string]> = [
  ['$x = $(Write-Error "Bad"); "[$x]"', 'Write-Error: Bad|[]'],
  ['$x = & { Write-Error "Bad"; "v" }; "[$x]"', 'Write-Error: Bad|[v]'],
  ['function f { Write-Error "e"; "v" }; $x = f; "[$x]"', 'Write-Error: e|[v]'],
  ['$x = "a $(Write-Warning "w") b"; $x', 'WARNING: w|a  b'],
  ['$x = @(Write-Error "e"); $x.Count', 'Write-Error: e|0'],
  ['$x = @(Write-Output a); $x.Count', '1'],
  ['"Hi $(Write-Error "Bad")"; $?', 'Write-Error: Bad|Hi |True'],
  ['$o = Invoke-Expression \'"Hi"; $x = 1\'; "o=[$o]"', 'o=[Hi]'],
  ['$o = Invoke-Expression \'"a"; "b"\'; $o.Count', '2'],
  ['"Hi"; $?', 'Hi|True'],
  ['Write-Error "Bad"; $?', 'Write-Error: Bad|False'],
  ['Invoke-Expression "1+1"', '2'],
  ['function g { "v" }; $x = g; "[$x]"', '[v]'],
  ["function g { [CmdletBinding()] param() 'o'; Write-Verbose 'v' }; g -Verbose", 'o|VERBOSE: v'],
];

describe('flux et Invoke-Expression', () => {
  for (const [code, expected] of CASES) {
    it(code.slice(0, 80), () => {
      expect(run(code)).toBe(expected);
    });
  }
});
