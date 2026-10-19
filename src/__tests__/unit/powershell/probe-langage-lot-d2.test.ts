/**
 * Probe — langage mesure par le harnais Pester sur test/powershell/Language/Parser/Parser.Tests.ps1 :
 * affectation et ++/-- parenthesees rendues comme valeur, `return` qui garde la sortie deja emise, sortie de
 * try/catch/finally qui garde son type, `$(a;b)` qui rend toutes les valeurs, `$input` d'un scriptblock appele par
 * `&`, listes a virgule imbriquees et `$null` conserve, alias utilisateur (New-/Set-/Remove-/Get-Alias),
 * `[powershell]::Create()` (runspace isole, AddScript/AddCommand/AddParameter/AddStatement, commandes pipees),
 * constructeur `: base(...)`, `${nom`}}`, `` `u{hex} ``, pipeline vers une expression refuse, virgule finale refusee.
 * Discrimination : sur la base a19a7d11b, 34 cas rouges sur 46.
 * Temoins (12, verts avant et apres) : `$a++` en instruction, `function F { 1; 2 }`, try/catch/finally sans return,
 * `for`/`foreach` avec continue hors hote, `$x = 5; $x`, `(1,2,3).Count`, `@(1,2,3).Count`, `'a','b' -join '-'`,
 * `1,2 | ForEach-Object`, `Get-Alias gci`, `${a b}`.
 */
import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

function run(code: string, language: 'core' | 'desktop' = 'core'): string {
  return new PSInterpreter(undefined, { language }).execute(code).replace(/\r?\n/g, '|');
}

const VALUES: Array<[string, string]> = [
  ['($x = 5)', '5'],
  ['$a = 0; ($a++); $a', '0|1'],
  ['$a = 0; (++$a)', '1'],
  ['$a = 0; $a++; $a', '1'],
  ['$a = 0; 1, ($a++)', '1|0'],
  ['function G { 1; return 5 }; G', '1|5'],
  ['function G { if ($true) { 1; return 5 }; 9 }; G', '1|5'],
  ['function G { foreach ($i in 1,2) { $i; if ($i -eq 2) { return "done" } } }; G', '1|2|done'],
  ['function F { 1; 2 }; F', '1|2'],
  ['function F { try { 3 } finally { } }; (F) -is [int]', 'True'],
  ['function F { try { 1; throw "x" } catch { 2 } finally { 3 } }; F', '1|2|3'],
  ['for ($a = 0; $a -lt 2; $a += 1) { 9; continue; 3 }', '9|9'],
  ['foreach ($a in 0, 1) { $a; continue; 2 }', '0|1'],
  ['$(1;2)', '1|2'],
  ['"a $(1;2) b"', 'a 1 2 b'],
  ['$(1+1)', '2'],
  ['$($a = 1) ? 2 : 3', '3'],
  ['$x = 5; $x', '5'],
  ['$input = 1,2,3; 4,-5,6 | & { $input }', '4|-5|6'],
  ['$s = { $input }; $r = @(0, 0), -1 | & $s; $r.Count', '2'],
  ['(1,2,3).Count', '3'],
  ['@(1,2,3).Count', '3'],
  ['(1,2,@(3,4)).Count', '3'],
  ['(1,$null,3).Count', '3'],
  ['$t = 1,2,@(3,4); ($t -eq 3).Count', '0'],
  ['"a","b" -join "-"', 'a-b'],
  ['1,2 | ForEach-Object { $_ }', '1|2'],
  ['Set-Alias zz Get-Date; Get-Alias zz | ForEach-Object { $_.Definition }', 'Get-Date'],
  ['New-Alias gg2 Get-Date -PassThru | ForEach-Object { $_.Definition }', 'Get-Date'],
  ['function foo { "func" }; Set-Alias bar foo; bar', 'func'],
  ['Set-Alias ls2 Get-ChildItem; Remove-Alias ls2; Get-Alias ls2 -ErrorAction SilentlyContinue', ''],
  ['Get-Alias gci | ForEach-Object { $_.Name }', 'gci'],
  ['$p = [powershell]::Create(); $p.AddScript("1+1; \'a\'").Invoke() -join ","', '2,a'],
  ['$p = [powershell]::Create(); [void]$p.AddScript("function Foo { 42 }").Invoke(); $p.Commands.Clear(); $p.AddScript("Foo").Invoke()', '42'],
  ['$p = [powershell]::Create(); [void]$p.AddScript(\'$z = 5\').Invoke(); $z', ''],
  ['$p = [powershell]::Create(); $r = $p.AddScript("\'cmdlet\'").Invoke(); $p.AddScript("\'func\'").Invoke()', 'func'],
  ['$p = [powershell]::Create(); $p.AddScript("1").AddStatement().AddScript("2").Invoke() -join ","', '1,2'],
  ['class A { A($x) { $this.v = $x }; $v }; class B : A { B($y) : base($y * 2) { } }; ([B]::new(4)).v', '8'],
  ['${a`}b} = 5; ${a`}b}', '5'],
  ['${a b} = 3; ${a b}', '3'],
  ['"`u{41}`u{2195}"', 'A↕'],
];

const FAILURES: Array<[string, string]> = [
  ['Get-Date | 3', 'Expressions are only allowed as the first element of a pipeline.'],
  ['Get-Date | "abc"', 'Expressions are only allowed as the first element of a pipeline.'],
  ['1,2,', "Missing expression after ','."],
  ['New-Alias gg Get-Date; New-Alias gg Get-Date', "The alias is not allowed, because an alias with the name 'gg' already exists."],
  ['$p = [powershell]::Create(); $p.AddScript("throw \'boom\'").Invoke()', 'boom'],
];

describe('probe langage lot D2 : valeurs', () => {
  it.each(VALUES)('%s', (code, expected) => {
    expect(run(code)).toBe(expected);
  });
});

describe('probe langage lot D2 : erreurs', () => {
  it.each(FAILURES)('%s', (code, fragment) => {
    expect(() => new PSInterpreter(undefined, { language: 'core' }).execute(code)).toThrow(fragment);
  });
});
