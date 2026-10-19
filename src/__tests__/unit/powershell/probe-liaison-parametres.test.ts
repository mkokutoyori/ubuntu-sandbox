/**
 * Probe — liaison des parametres de fonction PowerShell (ParameterBinder.cs,
 * CompiledScriptBlock.cs, Compiler.cs GetParameterMetaData, Metadata.resx,
 * ParameterBinderStrings.resx) : positions automatiques, alias, prefixes uniques,
 * switch, $PSBoundParameters, coercition typee, Mandatory, attributs Validate*.
 * Discrimination : sur la base 66d0bf89b, 21 cas rouges sur 28.
 * Temoins (7, verts avant et apres) : liaison positionnelle, alias, $args, switch present, pipeline Mandatory, scriptblock typé.
 */
import { describe, it, expect } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const CASES: Array<[string, string]> = [
  ["function f { param([ValidateSet('a','b')]$p) $p }; f a", "a"],
  ["function f { param([ValidateSet('a','b')]$p) $p }; f -p c", "Cannot validate argument on parameter 'p'. The argument \"c\" does not belong to the set \"a,b\" specified by the ValidateSet attribute. Supply an argument that is in the set and then try the command again."],
  ["function f { param([ValidateRange(1,5)][int]$n) $n }; f 9", "Cannot validate argument on parameter 'n'. The 9 argument is greater than the maximum allowed range of 5. Supply an argument that is less than or equal to 5 and then try the command again."],
  ["function f { param([ValidateRange(1,5)][int]$n) $n }; f 0", "Cannot validate argument on parameter 'n'. The 0 argument is less than the minimum allowed range of 1. Supply an argument that is greater than or equal to 1 and then try the command again."],
  ["function g { param([ValidateRange('Positive')][int]$n) $n }; g -3", "Cannot validate argument on parameter 'n'. The argument \"-3\" cannot be validated because its value is not greater than zero."],
  ["function f { param([ValidatePattern('^\\d+$')]$s) $s }; f abc", "Cannot validate argument on parameter 's'. The argument \"abc\" does not match the \"^\\d+$\" pattern. Supply an argument that matches \"^\\d+$\" and try the command again."],
  ["function f { param([ValidateLength(2,4)]$s) $s }; f abcdef", "Cannot validate argument on parameter 's'. The character length (6) of the argument is too long. Specify an argument with a length that is shorter than or equal to \"4\", and then try the command again."],
  ["function f { param([ValidateNotNullOrEmpty()]$s) $s }; f ''", "Cannot validate argument on parameter 's'. The argument is null or empty. Provide an argument that is not null or empty, and then try the command again."],
  ["function f { param([ValidateScript({ $_ -gt 0 })]$n) $n }; f -1", "Cannot validate argument on parameter 'n'. The \"$_ -gt 0\" validation script for the argument with value \"-1\" did not return a result of True. Determine why the validation script failed, and then try the command again."],
  ["function f { param([ValidateCount(1,2)]$x) $x }; f 1,2,3", "Cannot validate argument on parameter 'x'. The parameter requires at least 1 value(s) and no more than 2 value(s) - 3 value(s) were provided."],
  ["function f { param([int]$n) $n }; f x", "Cannot process argument transformation on parameter 'n'. Cannot convert value \"x\" to type \"System.Int32\". Error: \"Input string was not in a correct format.\""],
  ["function f { param([Parameter(Mandatory)]$a, $b) \"$a$b\" }; f", "Cannot process command because of one or more missing mandatory parameters: a."],
  ["function f { param($a, $b) \"$a-$b\" }; f 1 2", "1-2"],
  ["function f { param($a, [switch]$s) \"$a-$s\" }; f 1 -s", "1-True"],
  ["function f { param($a, [switch]$s) \"$a-$s\" }; f 1", "1-False"],
  ["function f { param($a, $b) $PSBoundParameters.Keys -join ',' }; f -a 1", "a"],
  ["function f { param($a, $b) $PSBoundParameters.Count }; f 1 2", "2"],
  ["function f { param($Alpha, $Beta) \"$Alpha$Beta\" }; f -Al 1 -Be 2", "12"],
  ["function f { param($Alpha, $Alps) 1 }; f -Al 1", "Parameter cannot be processed because the parameter name 'Al' is ambiguous. Possible matches include: -Alpha -Alps."],
  ["function f { param($a) $a }; f -zz 1", "A parameter cannot be found that matches parameter name 'zz'."],
  ["function f { param([string]$s, [int]$i) \"[$s][$i]\" }; f", "[][0]"],
  ["function f { [CmdletBinding()]param($a) $a }; f 1 2", "A positional parameter cannot be found that accepts argument '2'."],
  ["function f { param($a) \"$a|$args\" }; f 1 2 3", "1|2 3"],
  ["function f { param([Alias('n')]$name) $name }; f -n bob", "bob"],
  ["function f { param([Parameter(ValueFromRemainingArguments)]$rest) $rest -join ',' }; f 1 2 3", "1,2,3"],
  ["function f { param([int[]]$list) $list.GetType().Name }; f 1,2,3", "Int32[]"],
  ["function f { param([Parameter(Mandatory, ValueFromPipeline)]$v) process { \"got $v\" } }; 5 | f", "got 5"],
  ["$sb = { param([int]$x) $x * 2 }; & $sb 4", "8"],
];

describe('PowerShell parameter binder', () => {
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
