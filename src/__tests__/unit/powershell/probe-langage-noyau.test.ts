/**
 * Probe — noyau du langage PowerShell (types numeriques, caracteres, operateurs,
 * exceptions typees), valeurs attendues relevees dans le code source de PowerShell
 * (NumericOps.cs, LanguagePrimitives.cs, tokenizer.cs).
 * Discrimination : sur la base 22de22e43, 16 cas rouges sur 24.
 * Temoins (verts avant et apres, 8) : (5).GetType(), 7 / 2, (6 / 3).GetType(), [decimal]1.5 + 1,
 * -contains, -split/-join, [Math]::Pow, -band : non-regression de la grammaire d'operateurs.
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const CASES: Array<[string, string]> = [
  ["(5).GetType().FullName", "System.Int32"],
  ["(5.0).GetType().FullName", "System.Double"],
  ["(2147483647 + 1).GetType().Name", "Double"],
  ["7 / 2", "3.5"],
  ["(6 / 3).GetType().Name", "Int32"],
  ["[char]65", "A"],
  ["[int][char]'A'", "65"],
  ["'abc'[1]", "b"],
  ["'abc'[-1]", "c"],
  ["(1,2,3,4).Where({$_ -gt 2}) -join ','", "3,4"],
  ["(1,2,3).ForEach({$_ * 2}) -join ','", "2,4,6"],
  ["[decimal]1.5 + 1", "2.5"],
  ["1,2,3 -contains 2", "True"],
  ["'a,b' -split ',' -join '|'", "a|b"],
  ["[Math]::Pow(2,3)", "8"],
  ["-5 -band 3", "3"],
  ["try { 1/0 } catch [System.DivideByZeroException] { 'div0' }", "div0"],
  ["try { 1/0 } catch [System.IO.IOException] { 'io' } catch { 'other' }", "other"],
  ["try { [int]'x' } catch [System.InvalidCastException] { 'cast' }", "cast"],
  ["try { throw [System.ArgumentException]::new('a') } catch [System.InvalidOperationException] { 'wrong' } catch [System.ArgumentException] { 'right' }", "right"],
  ["try { throw [System.InvalidOperationException]::new('bad op') } catch { $_.Exception.GetType().FullName }", "System.InvalidOperationException"],
  ["try { throw 'boom' } catch { $_.Exception.GetType().FullName }", "System.Management.Automation.RuntimeException"],
  ["try { 1/0 } catch { $_.Exception.GetType().Name }", "DivideByZeroException"],
  ["try { try { 1/0 } catch { throw $_ } } catch [System.DivideByZeroException] { 'rethrown typed' }", "rethrown typed"],
];

describe('PowerShell language core', () => {
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
