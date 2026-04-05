/**
 * Tests for Expansion — word expansion and arithmetic evaluation.
 */

import { describe, it, expect } from 'vitest';
import { Environment } from '@/bash/runtime/Environment';
import { expandWord, expandWords, evaluateArithmetic } from '@/bash/runtime/Expansion';
import type { Word, LiteralWord, SingleQuotedWord, DoubleQuotedWord, VariableRef, CommandSubstitution, ArithmeticSubstitution, CompoundWord } from '@/bash/parser/ASTNode';

function mkLiteral(value: string): LiteralWord {
  return { type: 'LiteralWord', value };
}

function mkSingleQuoted(value: string): SingleQuotedWord {
  return { type: 'SingleQuotedWord', value };
}

function mkDoubleQuoted(parts: DoubleQuotedWord['parts']): DoubleQuotedWord {
  return { type: 'DoubleQuotedWord', parts };
}

function mkVarRef(name: string, braced = false, modifier?: string): VariableRef {
  return { type: 'VariableRef', name, braced, modifier };
}

function mkCmdSub(command: string): CommandSubstitution {
  return { type: 'CommandSubstitution', command, backtick: false };
}

function mkArithSub(expression: string): ArithmeticSubstitution {
  return { type: 'ArithmeticSubstitution', expression };
}

// ─── Literal Words ──────────────────────────────────────────────

describe('Expansion — Literal Words', () => {
  it('expands literal word as-is', () => {
    const env = new Environment();
    expect(expandWord(mkLiteral('hello'), env)).toBe('hello');
  });
});

// ─── Quoted Words ───────────────────────────────────────────────

describe('Expansion — Quoted Words', () => {
  it('expands single-quoted word without interpretation', () => {
    const env = new Environment({ variables: { X: '1' } });
    expect(expandWord(mkSingleQuoted('$X'), env)).toBe('$X');
  });

  it('expands double-quoted word with text', () => {
    const env = new Environment();
    expect(expandWord(mkDoubleQuoted([{ type: 'text', value: 'hello' }]), env)).toBe('hello');
  });

  it('expands double-quoted word with variable', () => {
    const env = new Environment({ variables: { NAME: 'world' } });
    const word = mkDoubleQuoted([
      { type: 'text', value: 'hello ' },
      { type: 'variable', name: 'NAME', braced: false },
    ]);
    expect(expandWord(word, env)).toBe('hello world');
  });
});

// ─── Variable Expansion ─────────────────────────────────────────

describe('Expansion — Variable Expansion', () => {
  it('expands simple variable', () => {
    const env = new Environment({ variables: { FOO: 'bar' } });
    expect(expandWord(mkVarRef('FOO'), env)).toBe('bar');
  });

  it('expands unset variable to empty string', () => {
    const env = new Environment();
    expect(expandWord(mkVarRef('UNSET'), env)).toBe('');
  });

  it('expands braced variable', () => {
    const env = new Environment({ variables: { FOO: 'bar' } });
    expect(expandWord(mkVarRef('FOO', true), env)).toBe('bar');
  });

  it('expands ${VAR:-default} when unset', () => {
    const env = new Environment();
    expect(expandWord(mkVarRef('X', true, ':-fallback'), env)).toBe('fallback');
  });

  it('expands ${VAR:-default} when set', () => {
    const env = new Environment({ variables: { X: 'val' } });
    expect(expandWord(mkVarRef('X', true, ':-fallback'), env)).toBe('val');
  });

  it('expands ${VAR:-default} when empty', () => {
    const env = new Environment();
    env.set('X', '');
    expect(expandWord(mkVarRef('X', true, ':-fallback'), env)).toBe('fallback');
  });

  it('expands ${VAR-default} does not trigger on empty', () => {
    const env = new Environment();
    env.set('X', '');
    expect(expandWord(mkVarRef('X', true, '-fallback'), env)).toBe('');
  });

  it('expands ${VAR:=default} assigns and returns', () => {
    const env = new Environment();
    expect(expandWord(mkVarRef('X', true, ':=hello'), env)).toBe('hello');
    expect(env.get('X')).toBe('hello');
  });

  it('expands ${VAR:+alt} when set and non-empty', () => {
    const env = new Environment({ variables: { X: 'val' } });
    expect(expandWord(mkVarRef('X', true, ':+ALT'), env)).toBe('ALT');
  });

  it('expands ${VAR:+alt} when unset', () => {
    const env = new Environment();
    expect(expandWord(mkVarRef('X', true, ':+ALT'), env)).toBe('');
  });

  it('expands ${#VAR} as length', () => {
    const env = new Environment({ variables: { X: 'hello' } });
    expect(expandWord(mkVarRef('X', true, '#'), env)).toBe('5');
  });

  it('expands ${#VAR} for empty var', () => {
    const env = new Environment();
    expect(expandWord(mkVarRef('X', true, '#'), env)).toBe('0');
  });
});

// ─── Command Substitution ───────────────────────────────────────

describe('Expansion — Command Substitution', () => {
  it('expands command substitution via callback', () => {
    const env = new Environment();
    const exec = (cmd: string) => 'root\n';
    expect(expandWord(mkCmdSub('whoami'), env, exec)).toBe('root');
  });

  it('returns empty when no executor provided', () => {
    const env = new Environment();
    expect(expandWord(mkCmdSub('whoami'), env)).toBe('');
  });
});

// ─── Arithmetic Expansion ───────────────────────────────────────

describe('Expansion — Arithmetic', () => {
  it('evaluates simple addition', () => {
    const env = new Environment();
    expect(evaluateArithmetic('1 + 2', env)).toBe('3');
  });

  it('evaluates subtraction', () => {
    const env = new Environment();
    expect(evaluateArithmetic('10 - 3', env)).toBe('7');
  });

  it('evaluates multiplication', () => {
    const env = new Environment();
    expect(evaluateArithmetic('4 * 5', env)).toBe('20');
  });

  it('evaluates integer division', () => {
    const env = new Environment();
    expect(evaluateArithmetic('7 / 2', env)).toBe('3');
  });

  it('evaluates modulo', () => {
    const env = new Environment();
    expect(evaluateArithmetic('7 % 3', env)).toBe('1');
  });

  it('evaluates expression with parentheses', () => {
    const env = new Environment();
    expect(evaluateArithmetic('(2 + 3) * 4', env)).toBe('20');
  });

  it('evaluates variable references in arithmetic', () => {
    const env = new Environment({ variables: { X: '5', Y: '3' } });
    expect(evaluateArithmetic('X + Y', env)).toBe('8');
  });

  it('evaluates $ prefixed variables', () => {
    const env = new Environment({ variables: { X: '10' } });
    expect(evaluateArithmetic('$X + 1', env)).toBe('11');
  });

  it('evaluates arithmetic substitution word', () => {
    const env = new Environment();
    expect(expandWord(mkArithSub('2 + 3'), env)).toBe('5');
  });

  it('evaluates unary minus', () => {
    const env = new Environment();
    expect(evaluateArithmetic('-5 + 3', env)).toBe('-2');
  });

  it('evaluates complex expression', () => {
    const env = new Environment();
    expect(evaluateArithmetic('(10 + 5) * 2 - 3', env)).toBe('27');
  });
});

// ─── expandWords ────────────────────────────────────────────────

describe('Expansion — expandWords', () => {
  it('expands an array of words', () => {
    const env = new Environment({ variables: { X: 'world' } });
    const words: Word[] = [mkLiteral('hello'), mkVarRef('X')];
    expect(expandWords(words, env)).toEqual(['hello', 'world']);
  });
});

// ─── Compound Words ─────────────────────────────────────────────

describe('Expansion — Compound Words', () => {
  it('expands compound word by concatenating parts', () => {
    const env = new Environment({ variables: { NAME: 'world' } });
    const word: CompoundWord = {
      type: 'CompoundWord',
      parts: [mkLiteral('hello_'), mkVarRef('NAME')],
    };
    expect(expandWord(word, env)).toBe('hello_world');
  });
});
