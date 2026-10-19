/**
 * Probe — litteraux numeriques et erreurs d'analyse (Parser.Tests.ps1 de PowerShell) :
 * suffixes y/uy/s/us/u/l/ul/n/d et multiplicateurs (ScanNumberHelper / TryGetNumberValue de tokenizer.cs), signe fusionne au
 * litteral (`-10y` est un SByte, `-2147483648` un Int32), hexadecimal et binaire signes par la largeur (`0xFFFFFFFF` = -1),
 * reels tronques a l'arrondi bancaire (`2.5n` = 2), `0.0d` garde son echelle, `16p` / `100ll` ne sont pas des nombres (commande
 * inconnue) et `0xFFFFy` / `500sgb` sont des constantes numeriques invalides (ParseException) ; `[ScriptBlock]::Create` (absent),
 * identifiants d'erreur ParseException / IncompleteParseException (premiere erreur en fin de saisie), InnerException portant
 * l'identifiant precis, Invoke-Expression suffixe de la commande ; bornes MinValue / MaxValue de tous les entiers ; indexation
 * d'une chaine par unites UTF-16 (`[int]$s[1]` sur une paire de substitution).
 * Discrimination : sur la base a44679de5 (HEAD avant ce lot), 56 cas rouges sur 72.
 * Temoins (16, verts avant et apres) : 7 temoins de la derniere suite (`1+2`, `0x10`, `1.5`, `-5 + 3`, `5kb`, `Write-Output 5kb`,
 * `1.5.ToString()`) et 9 litteraux que l'ancien analyseur traitait deja bien (`+10y`, `0xFFFFFFFF`, `0xFFFFFFFFFF`, `0x80000000`,
 * `0b10`, `0b11111111y`, `15e3d`, `0x1d`, `1tb`) : non-regression.
 */
import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

function run(code: string): string {
  const interp = new PSInterpreter(undefined, { language: 'core' });
  interp.beginInteractive(code);
  return interp.resumeInteractive().replace(/\r?\n/g, '|');
}

const typed = (literal: string): string => `$v = ${literal}\n$v\n$v.GetType().Name`;

const LITERALS: Array<[string, string]> = [
  ['-10y', '-10|SByte'], ['+10y', '10|SByte'], ['0xFFy', '-1|SByte'], ['3.72y', '4|SByte'], ['-3.72s', '-4|Int16'],
  ['0xFFFFs', '-1|Int16'], ['0xFFFFFFFF', '-1|Int32'], ['0xFFFFFFFFFF', '1099511627775|Int64'],
  ['0xFFFFFFFFFFFFFFFF', '-1|Int64'], ['0x80000000', '-2147483648|Int32'], ['0b11111111', '-1|Int32'], ['0b10', '2|Int32'],
  ['0b11111111y', '-1|SByte'], ['1dkb', '1024|Decimal'], ['0.0d', '0.0|Decimal'], ['15e3d', '15000|Decimal'],
  ['2.5n', '2|BigInteger'], ['-2.5n', '-2|BigInteger'], ['0x41n', '65|BigInteger'], ['0xFFFFFFFFu', '4294967295|UInt32'],
  ['0xFFFFFFFFFFu', '1099511627775|UInt64'], ['0xFFFFFFFFFFFFFFFFul', '18446744073709551615|UInt64'], ['1utb', '1099511627776|UInt64'],
  ['0xFFuy', '255|Byte'], ['3.72uy', '4|Byte'], ['0xFFFFus', '65535|UInt16'], ['1ukb', '1024|UInt32'], ['1lkb', '1024|Int64'],
  ['1skb', '1024|Int16'], ['-2147483648', '-2147483648|Int32'], ['0x1d', '29|Int32'], ['1tb', '1099511627776|Int64'],
  ['0b1111111111111111111111111111111111111111111111111111111111111111u', '18446744073709551615|UInt64'],
];

const NOT_NUMBERS = ['16p', '1_6', '80x', '20ux', '18uu', '21ss', '100ll', '100Il', '100un', '100sn', '160dd', '10ds', '16sl', '188lu', '10_000ul'];
const BAD_CONSTANTS = ['0xFFFFy', '500sgb', '10000usgb', '10000.0usgb', '1uykb'];

const ERRORS: Array<[string, string, string]> = [
  ['iex incomplete', `try { Invoke-Expression 'Write-Output (1' } catch { $_.FullyQualifiedErrorId }`,
    'MissingEndParenthesisInExpression,Microsoft.PowerShell.Commands.InvokeExpressionCommand'],
  ['Create unterminated string', `try { [ScriptBlock]::Create('"abc') } catch { $_.FullyQualifiedErrorId }`, 'IncompleteParseException'],
  ['Create empty pipe element', `try { [ScriptBlock]::Create('| foo') } catch { $_.FullyQualifiedErrorId }`, 'ParseException'],
  ['Create trailing comma', `try { [ScriptBlock]::Create('1,2,') } catch { $_.FullyQualifiedErrorId }`, 'IncompleteParseException'],
  ['Create missing index', `try { [ScriptBlock]::Create('$A=1; $A[ ;') } catch { $_.FullyQualifiedErrorId }`, 'ParseException'],
  ['Create foreach without collection', `try { [ScriptBlock]::Create('$c=0; foreach ($i in ;$c') } catch { $_.FullyQualifiedErrorId }`, 'ParseException'],
  ['inner exception carries the precise id', `try { [ScriptBlock]::Create('(') } catch { $_.Exception.InnerException.ErrorRecord.FullyQualifiedErrorId }`, 'MissingEndParenthesisInExpression'],
  ['host Invoke on incomplete script', `$p = [powershell]::Create()\ntry { $p.AddScript('if (1)').Invoke() } catch { $_.FullyQualifiedErrorId }`, 'IncompleteParseException'],
];

describe('litteraux numeriques', () => {
  for (const [literal, expected] of LITERALS) {
    it(literal, () => { expect(run(typed(literal))).toBe(expected); });
  }
  for (const text of NOT_NUMBERS) {
    it(`${text} est une commande inconnue`, () => {
      expect(run(`try { [ScriptBlock]::Create('${text}').Invoke() } catch { $_.FullyQualifiedErrorId }`)).toBe('CommandNotFoundException');
    });
  }
  for (const text of BAD_CONSTANTS) {
    it(`${text} est une constante invalide`, () => {
      expect(run(`try { [ScriptBlock]::Create('${text}').Invoke() } catch { $_.FullyQualifiedErrorId }`)).toBe('ParseException');
    });
  }
});

describe('erreurs d\'analyse et ScriptBlock.Create', () => {
  for (const [label, code, expected] of ERRORS) {
    it(label, () => { expect(run(code)).toBe(expected); });
  }
  it('Create returns a runnable script block', () => {
    expect(run("$s = [ScriptBlock]::Create('1+1')\n$s.Invoke()\n$s.ToString()")).toBe('2|1+1');
  });
});

describe('bornes et indexation', () => {
  it('MaxValue / MinValue des entiers', () => {
    expect(run('[uint]::MaxValue\n[ulong]::MaxValue\n[byte]::MaxValue\n[ushort]::MaxValue\n[sbyte]::MinValue\n[long]::MinValue'))
      .toBe('4294967295|18446744073709551615|255|65535|-128|-9223372036854775808');
  });
  it('[long]::MaxValue est un Int64', () => {
    expect(run('[long]::MaxValue.GetType().Name')).toBe('Int64');
  });
  it('indexation par unites UTF-16', () => {
    expect(run('$r = "`u{10FFFF}"\n$r.Length\n[int]$r[0]\n[int]$r[1]')).toBe('2|56319|57343');
  });
});

describe('temoins', () => {
  const witnesses: Array<[string, string, string]> = [
    ['addition', '1+2', '3|Int32'], ['hexadecimal court', '0x10', '16|Int32'], ['reel', '1.5', '1.5|Double'],
    ['soustraction apres signe', '-5 + 3', '-2|Int32'], ['multiplicateur', '5kb', '5120|Int32'],
  ];
  for (const [label, literal, expected] of witnesses) {
    it(label, () => { expect(run(typed(literal))).toBe(expected); });
  }
  it('Write-Output 5kb', () => { expect(run('Write-Output 5kb')).toBe('5120'); });
  it('1.5.ToString()', () => { expect(run('1.5.ToString()')).toBe('1.5'); });
});
