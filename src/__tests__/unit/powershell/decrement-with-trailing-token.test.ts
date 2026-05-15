/**
 * `--` after a variable must always tokenize as DECREMENT, even when
 * immediately followed by a separator (`;`, space, newline).
 *
 * Bug: the lexer treated `--` followed by whitespace or `;` as a GNU-style
 * end-of-parameters marker (PARAMETER:'-'), which (a) PowerShell doesn't have
 * and (b) caused `do { ...; $k-- } while ($k -gt 0)` to loop forever because
 * `$k` was never actually decremented inside the body.
 */

import { describe, it, expect } from 'vitest';
import { PSLexer } from '@/powershell/lexer/PSLexer';
import { PSTokenType } from '@/powershell/lexer/PSToken';
import { PSInterpreter } from '@/powershell/interpreter/PSInterpreter';

describe('lexer: -- always emits DECREMENT', () => {
  it.each([
    ['$k--',         ['VARIABLE:k', 'DECREMENT:--']],
    ['$k--;',        ['VARIABLE:k', 'DECREMENT:--', 'SEMICOLON:;']],
    ['$k--; $k',     ['VARIABLE:k', 'DECREMENT:--', 'SEMICOLON:;', 'VARIABLE:k']],
    ['$k-- $rest',   ['VARIABLE:k', 'DECREMENT:--', 'VARIABLE:rest']],
  ])('%s → %j', (input, expected) => {
    const toks = new PSLexer().tokenize(input)
      .filter(t => t.type !== PSTokenType.EOF)
      .map(t => `${t.type}:${t.value}`);
    expect(toks).toEqual(expected);
  });
});

describe('runtime: decrement persists across semicolon-separated statements', () => {
  it('$k = 3; $k--; $k yields 2 as the last value', () => {
    const i = new PSInterpreter();
    const out = i.executeInteractive('$k = 3; $k--; $k');
    // Last line of the interactive output is the final $k value.
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    expect(lines[lines.length - 1]).toBe('2');
  });

  it('do { $k-- } while ($k -gt 0) terminates instead of looping forever', () => {
    const i = new PSInterpreter();
    // The point of the test is that this returns — the pre-fix runtime hung
    // because $k-- inside the body wasn't decrementing $k.
    const out = i.executeInteractive('$k = 3; do { $k-- } while ($k -gt 0); $k');
    expect(out.trim()).toBe('0');
  });
});
