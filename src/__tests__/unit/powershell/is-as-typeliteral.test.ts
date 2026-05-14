/**
 * `-is` / `-isnot` / `-as` with a [Type] right operand.
 *
 * Bug from debug-output/ps-pipelines_results_debug.txt:
 *
 *     PS> 5 -is [int]
 *       5 : The term '5' is not recognized as the name of a cmdlet ...
 *
 * Two distinct bugs surfaced:
 * 1. The parser treated `[int]` as a type cast (which needs an operand),
 *    not as a TypeLiteral, so `5 -is [int]` had no valid AST and fell
 *    back to command-name dispatch ⇒ "term '5' not recognized".
 * 2. `applyBinaryOpByName` re-bracketed the right operand, so psIs saw
 *    `[[int]]` and never matched any known type, returning False.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

let interp: PSInterpreter;
beforeEach(() => { interp = new PSInterpreter(); });

describe('-is / -isnot with [Type]', () => {
  it('5 -is [int] returns True', () => {
    expect(interp.executeInteractive('5 -is [int]')).toBe('True');
  });

  it('5 -is [string] returns False', () => {
    expect(interp.executeInteractive('5 -is [string]')).toBe('False');
  });

  it('"abc" -is [string] returns True', () => {
    expect(interp.executeInteractive('"abc" -is [string]')).toBe('True');
  });

  it('"abc" -isnot [int] returns True', () => {
    expect(interp.executeInteractive('"abc" -isnot [int]')).toBe('True');
  });

  it('@(1,2,3) -is [array] returns True', () => {
    expect(interp.executeInteractive('@(1,2,3) -is [array]')).toBe('True');
  });
});

describe('-as with [Type]', () => {
  it('"42" -as [int] returns 42', () => {
    expect(interp.executeInteractive('"42" -as [int]')).toBe('42');
  });
});
