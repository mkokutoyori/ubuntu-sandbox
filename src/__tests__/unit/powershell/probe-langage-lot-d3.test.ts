/**
 * Probe — langage mesure par le harnais Pester (TryCatch, Trap, Parser, ErrorRecord) :
 * `trap` type (`trap [Type] {}`) et `continue`/`break` dans le trap, `$a = try { }`, `finally` execute meme quand le
 * `catch` relance, sortie emise avant un `throw` dans une fonction, `@($null)` a un element, `"$x:"` refuse,
 * `` `e `` (ESC) en pwsh seulement, `[int]` evalue en objet type (`.FullName`, `.Name`), CommandNotFoundException
 * (type et FullyQualifiedErrorId), tuyau vide refuse (`Get-Date |`, `| Get-Date`).
 * Discrimination : sur la base 8fd78f1b4, 14 cas rouges sur 28 (trap type et trap de fonction, `$a = try`, `@($null)`,
 * CommandNotFoundException x2, finally apres catch qui relance, sortie avant throw, finally sans catch, `e ESC,
 * "$x:", tuyau vide x2).
 * Temoins (14, verts avant et apres) : `trap [DivideByZero]` seul, `trap` sans type, `[int].FullName`, `[string].Name`,
 * `@($null, $null)`, `finally` sur `break`, `try/catch` simple, `throw` dans une fonction, `1,2 | ForEach-Object`,
 * `"a $x b"`, `[string]5`, `$null -eq @()`, `"a`nb"`, `e en edition 5.1.
 */
import { describe, it, expect } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

function run(code: string, language: 'core' | 'desktop' = 'core'): string {
  return new PSInterpreter(undefined, { language }).execute(code).replace(/\r?\n/g, '|');
}

const VALUES: Array<[string, string]> = [
  ['trap [System.DivideByZeroException] { "div"; continue }; 1/0; "after"', 'div|after'],
  ['trap [System.IO.IOException] { "io"; continue }; trap [System.DivideByZeroException] { "div"; continue }; 1/0; "after"', 'div|after'],
  ['trap { "any"; continue }; throw "x"; "after"', 'any|after'],
  ['function F { trap { "t"; continue }; throw "a"; "next" }; F', 't|next'],
  ['$a = try { 5 } catch { 6 }; $a', '5'],
  ['$a = try { throw "x" } catch { 6 }; $a', '6'],
  ['@($null).Count', '1'],
  ['@($null, $null).Count', '2'],
  ['[int].FullName', 'System.Int32'],
  ['[string].Name', 'String'],
  ['try { Get-Zork } catch { $_.FullyQualifiedErrorId }', 'CommandNotFoundException'],
  ['try { Get-Zork } catch { $_.Exception.GetType().FullName }', 'System.Management.Automation.CommandNotFoundException'],
  ['function F { foreach ($i in 1..3) { try { if ($i -eq 2) { break }; $i } finally { "f$i" } } }; F', '1|f1|f2'],
  ['function F { try { throw "a" } catch { throw "b" } finally { "fin" } }; try { F } catch { $_.Exception.Message }', 'fin|b'],
  ['function F { "pre"; throw "a" }; try { F } catch { "c" }', 'pre|c'],
  ['function F { try { throw "a" } finally { "fin" } }; try { F } catch { "c" }', 'fin|c'],
  ['[int][char]"`e"[0]', '27'],
  ['try { throw "x" } catch { "c" }', 'c'],
  ['function F { throw "a" }; try { F } catch { "c" }', 'c'],
  ['1,2 | ForEach-Object { $_ }', '1|2'],
  ['$x = 1; "a $x b"', 'a 1 b'],
  ['[string]5', '5'],
  ['$null -eq @()', 'False'],
  ['"a`nb"', 'a|b'],
];

describe('lot D3 — valeurs', () => {
  for (const [code, expected] of VALUES) {
    it(code, () => {
      expect(run(code)).toBe(expected);
    });
  }
});

describe('lot D3 — refus', () => {
  it('"$x:" est une ParseException', () => {
    expect(() => run('"$x:"')).toThrow(/Variable reference is not valid/);
  });
  it('tuyau vide en fin', () => {
    expect(() => run('Get-Date |')).toThrow(/empty pipe element/);
  });
  it('tuyau vide au debut', () => {
    expect(() => run('| Get-Date')).toThrow(/empty pipe element/);
  });
});

describe('lot D3 — edition 5.1', () => {
  it('`e n\'est pas un echappement ESC', () => {
    expect(run('[int][char]"`e"[0]', 'desktop')).toBe('101');
  });
});
