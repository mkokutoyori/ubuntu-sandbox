/**
 * Probe — `$?` et chaines `&&` / `||` du shell interactif PowerShell (about_Pipeline_Chain_Operators, about_Automatic_Variables) :
 * une erreur non terminante ecrite par une commande rend `$?` faux (Get-Item d'un chemin absent, Write-Error), la partie droite
 * d'un `||` s'execute alors ; une ligne d'erreur ecrite sur le flux d'erreur ne compte pas comme « sortie » de l'instruction,
 * donc les valeurs de la chaine sont rendues apres elle.
 * Aussi : `(a && b) && c` (une chaine entre parentheses est une expression, pas un nom de commande), `break` dans une chaine
 * ne perd pas les valeurs deja produites, `[ErrorRecord]::new(exception, id, categorie, cible)` et l'enumeration ErrorCategory,
 * `return` dans un filtre/bloc process ne termine que l'element courant.
 * Discrimination : sur la base 71bcfb10b, 14 cas rouges sur 21.
 * Temoins (7, verts avant et apres) : `1 + 1 && "Hi"`, `"a" && "b"; "c"`, `"hello" || "there"`, avertissement suivi d'une valeur,
 * Write-Error suivi d'une valeur dans une fonction, `Write-Output 1 > $null; $?`, `Get-Item` d'un chemin absent puis `&&` (la
 * partie droite ne s'execute pas : verte parce que l'erreur levee interrompait deja l'instruction).
 */
import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

function interactive(code: string): string {
  const interp = new PSInterpreter(undefined, { language: 'core' });
  interp.beginInteractive(code);
  return interp.resumeInteractive().replace(/\r?\n/g, '|');
}

const MISSING = "Get-Item: Cannot find path 'nope_zz' because it does not exist.";

const CASES: Array<[string, string]> = [
  ['Get-Item nope_zz; $?', `${MISSING}|False`],
  ['Write-Error x; $?', 'Write-Error: x|False'],
  ['function e { Write-Error x }; e; $?', 'Write-Error: x|False'],
  ['Get-Item nope_zz || "there"', `${MISSING}|there`],
  ['Get-Item nope_zz && "yes"; "next"', `${MISSING}|next`],
  ['Get-Item nope_zz -ErrorAction SilentlyContinue && "yes"; "next"', 'next'],
  ['"hello" && Get-Item nope_zz || "there"; "hello" || "there"', `${MISSING}|hello|there|hello`],
  ['function f { Write-Error "e"; "v" }; f', 'Write-Error: e|v'],
  ['1 + 1 && "Hi"', '2|Hi'],
  ['"a" && "b"; "c"', 'a|b|c'],
  ['"hello" || "there"', 'hello'],
  ['function f { Write-Warning "w"; "v" }; f', 'WARNING: w|v'],
  ['Write-Output 1 > $null; $?', 'True'],
  ['(Write-Output a) && "Hi"', 'a|Hi'],
  ['(1 && 2) && "Hi"', '1|2|Hi'],
  ['foreach ($v in 1,2,3) { $v && Get-Item nope_zz -ErrorAction SilentlyContinue || $(break) }', '1'],
  ["$e = [System.Management.Automation.ErrorRecord]::new([System.Exception]::new('NT'), 'NTID', 'NotSpecified', $null); $e.FullyQualifiedErrorId", 'NTID'],
  ['[System.Management.Automation.ErrorCategory]::ObjectNotFound', 'ObjectNotFound'],
  ['[int][System.Management.Automation.ErrorCategory]::ObjectNotFound', '13'],
  ["filter T { param([Parameter(ValueFromPipeline)]$x) if ($x -ne 2) { return $x }; 'two' }; 1,2,3 | T", '1|two|3'],
  ['function w { Write-Error "x" }; w; $?; "after"', 'Write-Error: x|False|after'],
];

describe('$? et chaines de pipelines (shell interactif)', () => {
  for (const [code, expected] of CASES) {
    it(code, () => {
      expect(interactive(code)).toBe(expected);
    });
  }
});
