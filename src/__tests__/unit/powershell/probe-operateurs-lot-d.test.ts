/**
 * Probe — operateurs et acces membre mesures par le harnais Pester sur test/powershell/Language/Operators du depot
 * PowerShell : precedences de token.cs (logique 1, bit a bit 2, comparaison 5, ?? 7, +/- 9, * / % 10, -f 12, .. 13,
 * virgule au-dessus), WildcardPattern (regex.cs : echappement par accent grave, classes entre crochets, motif invalide),
 * -is sur un type inconnu, [psobject]/[pscustomobject], enumerations [AceFlags]/[CommandTypes], acces membre dynamique
 * `.$nom` / `.$nom()` / `?.$nom()`, appel d'une methode absente (MethodNotFound), $input comme enumerateur.
 * Discrimination : sur la base 4bf606c04, 42 cas rouges sur 58.
 * Temoins (16, verts avant et apres) : `"{0}" -f $null ?? 'b'`, `2 + $null ?? 3`, `2 * $null ?? 3`, `(1..3).Count`,
 * `-1..1`, `${nx}?.$m()` (nul), `2*1..3` (la plage se formait deja avant le produit), `-like` sur `a[d-f]c` (faux dans
 * les deux lectures), `-like` avec * et ? et insensible a la casse, `'hello' -is [psobject]`, `'x' -is [string]`,
 * `-split " ", 2`, `-csplit "B"`, `-split "(:)"`, `-split` SimpleMatch,IgnoreCase.
 * Autres mesures portees par ce lot : -split fidele a parserutils.cs SplitOperatorImpl (limite negative, predicat,
 * options enumerees, combinaison refusee), chaine de pipeline `&&`/`||` dans la partie droite d'une affectation et
 * dans une condition, variable portant un scriptblock rendue comme valeur (et non executee), MatchEvaluator recevant
 * la correspondance en $args[0].
 */
import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

function run(code: string): string {
  return new PSInterpreter(undefined, { language: 'core' }).execute(code).replace(/\r?\n/g, '|');
}

const VALUES: Array<[string, string]> = [
  ['$true -and $null ?? $true', 'True'],
  ['1 -band $null ?? 1', '1'],
  ["'x' -eq $null ?? 'x'", 'True'],
  ["$null -eq $null ?? 'x'", 'False'],
  ['"{0}" -f $null ?? "b"', ''],
  ['2 + $null ?? 3', '2'],
  ['2 * $null ?? 3', '0'],
  ['(1,2+3).Count', '3'],
  ['(1..3).Count', '3'],
  ['-1..1 -join ","', '-1,0,1'],
  ['$s="abc"; $m="ToUpper"; $s.$m()', 'ABC'],
  ['$h=@{a=1;b=2}; ($h.get_Keys() | Sort-Object) -join ","', 'a,b'],
  ['$h=@{a=1;b=2}; $h.get_Count()', '2'],
  ['$o=@{a=5}; $p="a"; $o.$p', '5'],
  ['$s="abc"; $s.("Len"+"gth")', '3'],
  ['$m="ToLongDateString"; (Get-Date "11/11/2019")?.$m()', 'Monday, November 11, 2019'],
  ['${nx}?.$m()', ''],
  ["'abc`def' -like 'abc`def'", 'False'],
  ["'abc`def' -like 'abc``def'", 'True'],
  ["'abc`def' -like [WildcardPattern]::Escape('abc`def')", 'True'],
  ["'abc``def' -like [WildcardPattern]::Escape('abc``def')", 'True'],
  ["'abc' -like 'a[a-c]c'", 'True'],
  ["'abd' -like 'a[a-c]d'", 'True'],
  ["'abc' -like 'a[d-f]c'", 'False'],
  ["'ABC' -like 'a*'", 'True'],
  ["'abc' -like 'a?c'", 'True'],
  ["[pscustomobject]@{foo=1} -is [psobject]", 'True'],
  ["[pscustomobject]@{foo=1} -is [pscustomobject]", 'True'],
  ["'hello' -is [psobject]", 'False'],
  ["'x' -is [string]", 'True'],
  ['([System.Security.AccessControl.AceFlags]::ObjectInherit -bxor [System.Security.AccessControl.AceFlags]::ContainerInherit).ToString()', 'ObjectInherit, ContainerInherit'],
  ['([System.Management.Automation.CommandTypes]::Alias -bor [System.Management.Automation.CommandTypes]::Application).ToString()', 'Alias, Application'],
  ['([System.Management.Automation.CommandTypes]::Alias -band [System.Management.Automation.CommandTypes]::All).ToString()', 'Alias'],
  ['([System.Security.AccessControl.AceFlags]::ObjectInherit -band [System.Security.AccessControl.AceFlags]::ContainerInherit).ToString()', 'None'],
  ['"a b c d" -split " ", 2', 'a|b c d'],
  ['"a b c d" -split {$_ -like " "},-2', 'a b c|d'],
  ['"a2b3c4d" -split "\\d+",-2', 'a2b3c|d'],
  ['"abcBd" -csplit "B"', 'abc|d'],
  ['"abcBd" -csplit "B", 0 , "IgnoreCase"', 'a|c|d'],
  ['"a: b:c" -split ": ",0,"IgnorePatternWhitespace"', 'a| b|c'],
  ['"a:b" -split "(:)", 0, "ExplicitCapture"', 'a|b'],
  ['"a:b" -split "(:)"', 'a|:|b'],
  ['"abc" -split "B", 0, "SimpleMatch,IgnoreCase"', 'a|c'],
  ['$me = {param($m) "X" * $m.Value.Length}; "ID ABC123" -replace "\\b[A-C]+", $me', 'ID XXX123'],
  ['$me = {"hi"}; $me', '"hi"'],
  ['$x = 1 && @(2, 3); $x -join ","', '1,2,3'],
  ['if ($false && $true) { "Hi" }', 'Hi'],
  ['function F { process { if ($_ -eq 2) { $input.MoveNext() } else { $_ } } }; 1,2,3 | F', '1|True|3'],
];

const FAILURES: Array<[string, string]> = [
  ["'hello' -is [foo]", 'Unable to find type [foo].'],
  ["'hello' -isnot [foo]", 'Unable to find type [foo].'],
  ['2*1..3', "does not contain a method named 'op_Multiply'"],
  ["'abc' -like 'a[b'", 'The specified wildcard character pattern is not valid: a[b'],
  ['$m="DoesNotExist"; (Get-Date "11/11/2019")?.$m()', "Method invocation failed because [System.DateTime] does not contain a method named 'DoesNotExist'."],
  ['$m=$null; (Get-Date "11/11/2019")?.$m()', 'does not contain a method named'],
  ['"abc".Length()', "Method invocation failed because [System.String] does not contain a method named 'Length'."],
  ['$n=$null; $n.Foo()', 'You cannot call a method on a null-valued expression.'],
  ['"abc" -split "B", 0, "RegexMatch,SimpleMatch"', 'The combination of options with the -split operator is not valid.'],
  ['"abc" -split {$_ -eq "b"}, 0, "IgnoreCase"', 'Options are not allowed on the -split operator with a predicate.'],
];

describe('probe operateurs lot D : valeurs', () => {
  it.each(VALUES)('%s', (code, expected) => {
    expect(run(code)).toBe(expected);
  });
});

describe('probe operateurs lot D : erreurs', () => {
  it.each(FAILURES)('%s', (code, fragment) => {
    expect(() => new PSInterpreter(undefined, { language: 'core' }).execute(code)).toThrow(fragment);
  });
});
