/**
 * Probe — conversions de types (Conversions.Tests.ps1 de PowerShell) :
 * `-as` / `-is` dont l'operande de droite est une VARIABLE (resolue dans la portee courante, pas la portee globale),
 * `[type]` reconnu par `-is [type]`, vrai type [bigint] (BigInteger : `1n`, arithmetique exacte, division entiere, cast depuis
 * une chaine entiere sans perte), methodes IConvertible des nombres (`ToSingle`, `ToInt32`...), `Double.ToString()` sans format :
 * aller-retour le plus court sous pwsh (3.3000000000000003) mais G15 sous Windows PowerShell et dans `[string]`, statiques
 * `[float]::MaxValue`, `[LanguagePrimitives]::ConvertTo`, `List[T]` / `Collection[T]` types (conversion des elements, GetType().Name,
 * GetGenericArguments()).
 * Discrimination : sur la base 4078da12a (HEAD avant ce lot), 17 cas rouges sur 26.
 * Temoins (9, verts avant et apres) : `5 -is [int]`, `[int]"5"`, `[bigint]5 + 1`, `[string](1.1*3)`, ToString() sous Windows
 * PowerShell, `$null -as [int]`, `$true -as [int]`, `[Collections.ArrayList]` Count, expression de type litterale `-is [string]`.
 */
import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

function run(code: string, language: 'core' | 'desktop' = 'core'): string {
  const interp = new PSInterpreter(undefined, { language });
  interp.beginInteractive(code);
  return interp.resumeInteractive().replace(/\r?\n/g, '|');
}

const CASES: Array<[string, string, ('core' | 'desktop')?]> = [
  ['function f { param($T, $V) $V -as $T }; f -T ([int]) -V $true', '1'],
  ['function f { param($T, $V) $V -is $T }; f -T ([int]) -V 5', 'True'],
  ['$t = [int]; $t -is [type]', 'True'],
  ['5 -is [type]', 'False'],
  ['($true -as [bigint]).GetType().Name', 'BigInteger'],
  ['$null -as [bigint]', '0'],
  ['[bigint]"123456789012345678901234567890" * 2', '246913578024691357802469135780'],
  ['[bigint]7 / 2', '3'],
  ['(1n).GetType().Name', 'BigInteger'],
  ['(1.1*3).ToString()', '3.3000000000000003'],
  ['[float]::MaxValue', '3.402823E+38'],
  ['[float]::MaxValue.ToString()', '3.4028235E+38'],
  ['(2.7).ToInt32($null)', '3'],
  ['[float]$f = 1.1; ($f * 3).ToSingle($null).ToString()', '3.3000002'],
  ['[System.Management.Automation.LanguagePrimitives]::ConvertTo("5", [int]) + 1', '6'],
  ['$l = [System.Collections.Generic.List[int]]::new(); $l.Add("5"); $l[0].GetType().Name + "|" + $l.GetType().Name', 'Int32|List`1'],
  ['$r = [Collections.Generic.List[System.IO.FileInfo]]@("a"); $r.GetType().GetGenericArguments()[0].Name', 'FileInfo'],
  ['5 -is [int]', 'True'],
  ['[int]"5"', '5'],
  ['[bigint]5 + 1', '6'],
  ['[string](1.1*3)', '3.3'],
  ['(1.1*3).ToString()', '3.3', 'desktop'],
  ['$null -as [int]', '0'],
  ['$true -as [int]', '1'],
  ['$a = [Collections.ArrayList]::new(); $a.Add(1) > $null; $a.Count', '1'],
  ['"x" -is [string]', 'True'],
];

describe('conversions de types', () => {
  for (const [code, expected, language] of CASES) {
    it(`${language ?? 'core'}: ${code.slice(0, 80)}`, () => {
      expect(run(code, language ?? 'core')).toBe(expected);
    });
  }
});
