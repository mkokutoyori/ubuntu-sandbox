/**
 * Expansion — Word expansion for the bash interpreter.
 *
 * Handles:
 * - Variable expansion ($VAR, ${VAR}, ${VAR:-default}, etc.)
 * - Command substitution $(cmd) and `cmd` (delegates to interpreter)
 * - Arithmetic expansion $((expr))
 * - Quote removal (single/double quotes)
 * - Glob expansion (basic *, ?, [...]) — deferred to filesystem
 *
 * Does NOT handle tilde expansion or brace expansion (bash-specific
 * features that are less common in network simulator scripts).
 */

import type { Word, WordPart } from '@/bash/parser/ASTNode';
import type { Environment } from './Environment';
import { ExpansionError, ArithmeticError } from '@/bash/errors/BashError';

/** Callback for executing command substitutions. */
export type CommandSubstitutionFn = (command: string) => string;

/**
 * Expand a Word AST node into its final string value.
 */
export function expandWord(
  word: Word,
  env: Environment,
  execCmd?: CommandSubstitutionFn,
): string {
  switch (word.type) {
    case 'LiteralWord':
      return word.value;
    case 'SingleQuotedWord':
      return word.value;
    case 'DoubleQuotedWord':
      return expandDoubleQuotedParts(word.parts, env, execCmd);
    case 'VariableRef':
      return expandVariable(word.name, word.braced, word.modifier, env);
    case 'CommandSubstitution':
      return execCmd ? execCmd(word.command).trimEnd() : '';
    case 'ArithmeticSubstitution':
      return evaluateArithmetic(word.expression, env);
    case 'CompoundWord':
      return word.parts.map(p => expandWord(p, env, execCmd)).join('');
    default:
      return '';
  }
}

/**
 * Expand an array of Words (e.g. command arguments).
 */
export function expandWords(
  words: Word[],
  env: Environment,
  execCmd?: CommandSubstitutionFn,
): string[] {
  return words.map(w => expandWord(w, env, execCmd));
}

// ─── Variable Expansion ─────────────────────────────────────────

function expandVariable(
  name: string,
  braced: boolean,
  modifier: string | undefined,
  env: Environment,
): string {
  if (!modifier) {
    return env.get(name) ?? '';
  }

  // Length prefix: ${#VAR}
  if (modifier === '#') {
    const val = env.get(name) ?? '';
    return String(val.length);
  }

  // Modifiers: ${VAR:-default}, ${VAR:+alt}, ${VAR:=val}, ${VAR-default}
  const match = modifier.match(/^(:-|:=|:\+|:|-|=|\+)(.*)$/);
  if (!match) return env.get(name) ?? '';

  const [, op, word] = match;
  const val = env.get(name);

  switch (op) {
    case ':-':
    case '-':
      // Use default if unset or (for :-) empty
      if (val === undefined || (op === ':-' && val === '')) return word;
      return val;
    case ':=':
    case '=':
      // Assign default if unset or (for :=) empty
      if (val === undefined || (op === ':=' && val === '')) {
        env.set(name, word);
        return word;
      }
      return val;
    case ':+':
    case '+':
      // Use alternative if set and (for :+) non-empty
      if (op === ':+') return val !== undefined && val !== '' ? word : '';
      return val !== undefined ? word : '';
    default:
      return val ?? '';
  }
}

// ─── Double-Quoted Expansion ────────────────────────────────────

function expandDoubleQuotedParts(
  parts: WordPart[],
  env: Environment,
  execCmd?: CommandSubstitutionFn,
): string {
  return parts.map(part => {
    switch (part.type) {
      case 'text': return expandInlineVars(part.value, env);
      case 'variable': return expandVariable(part.name, part.braced, part.modifier, env);
      case 'special': return env.get(part.name) ?? '';
      case 'command': return execCmd ? execCmd(part.command).trimEnd() : '';
      case 'arithmetic': return evaluateArithmetic(part.expression, env);
      default: return '';
    }
  }).join('');
}

/** Expand $VAR, ${VAR}, and $? etc. inline within a text string. */
function expandInlineVars(text: string, env: Environment): string {
  return text.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z_0-9]*|\?|#|@|\*|\$|!|\d+)/g,
    (_match, braced, simple) => {
      const name = braced ?? simple;
      return env.get(name) ?? '';
    });
}

// ─── Arithmetic Expansion ───────────────────────────────────────

/**
 * Evaluate a simple arithmetic expression.
 * Supports: +, -, *, /, %, parentheses, variable references, integers.
 */
export function evaluateArithmetic(expr: string, env: Environment): string {
  try {
    const result = evalArithExpr(expr.trim(), env);
    return String(result);
  } catch (e) {
    throw new ArithmeticError(`bad arithmetic expression: ${expr}`);
  }
}

/** Tokenize and evaluate an arithmetic expression. */
function evalArithExpr(expr: string, env: Environment): number {
  const tokens = tokenizeArith(expr, env);
  const result = parseArithExpr(tokens, 0);
  return result.value;
}

interface ArithToken {
  type: 'number' | 'op' | 'lparen' | 'rparen';
  value: string;
}

function tokenizeArith(expr: string, env: Environment): ArithToken[] {
  const tokens: ArithToken[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch)) {
      let num = '';
      while (i < expr.length && /[0-9]/.test(expr[i])) { num += expr[i]; i++; }
      tokens.push({ type: 'number', value: num });
    } else if (/[a-zA-Z_]/.test(ch)) {
      let name = '';
      while (i < expr.length && /[a-zA-Z_0-9]/.test(expr[i])) { name += expr[i]; i++; }
      const val = env.get(name) ?? '0';
      tokens.push({ type: 'number', value: /^-?\d+$/.test(val) ? val : '0' });
    } else if (ch === '$') {
      i++;
      let name = '';
      while (i < expr.length && /[a-zA-Z_0-9]/.test(expr[i])) { name += expr[i]; i++; }
      const val = env.get(name) ?? '0';
      tokens.push({ type: 'number', value: /^-?\d+$/.test(val) ? val : '0' });
    } else if (ch === '(') {
      tokens.push({ type: 'lparen', value: '(' }); i++;
    } else if (ch === ')') {
      tokens.push({ type: 'rparen', value: ')' }); i++;
    } else if ('+-*/%'.includes(ch)) {
      // Handle unary minus
      if (ch === '-' && (tokens.length === 0 || tokens[tokens.length - 1].type === 'op' || tokens[tokens.length - 1].type === 'lparen')) {
        i++;
        let num = '';
        if (i < expr.length && /[0-9]/.test(expr[i])) {
          while (i < expr.length && /[0-9]/.test(expr[i])) { num += expr[i]; i++; }
          tokens.push({ type: 'number', value: '-' + num });
        } else {
          tokens.push({ type: 'number', value: '0' });
        }
      } else {
        tokens.push({ type: 'op', value: ch }); i++;
      }
    } else {
      i++; // skip unknown
    }
  }
  return tokens;
}

interface ArithResult { value: number; pos: number; }

function parseArithExpr(tokens: ArithToken[], pos: number): ArithResult {
  let left = parseArithTerm(tokens, pos);
  while (left.pos < tokens.length && tokens[left.pos]?.type === 'op' &&
         (tokens[left.pos].value === '+' || tokens[left.pos].value === '-')) {
    const op = tokens[left.pos].value;
    const right = parseArithTerm(tokens, left.pos + 1);
    left = { value: op === '+' ? left.value + right.value : left.value - right.value, pos: right.pos };
  }
  return left;
}

function parseArithTerm(tokens: ArithToken[], pos: number): ArithResult {
  let left = parseArithFactor(tokens, pos);
  while (left.pos < tokens.length && tokens[left.pos]?.type === 'op' &&
         ('*/%'.includes(tokens[left.pos].value))) {
    const op = tokens[left.pos].value;
    const right = parseArithFactor(tokens, left.pos + 1);
    if ((op === '/' || op === '%') && right.value === 0) {
      throw new ArithmeticError('division by zero');
    }
    const val = op === '*' ? left.value * right.value :
                op === '/' ? Math.trunc(left.value / right.value) :
                left.value % right.value;
    left = { value: val, pos: right.pos };
  }
  return left;
}

function parseArithFactor(tokens: ArithToken[], pos: number): ArithResult {
  if (pos >= tokens.length) return { value: 0, pos };
  const tok = tokens[pos];
  if (tok.type === 'lparen') {
    const inner = parseArithExpr(tokens, pos + 1);
    // skip rparen
    return { value: inner.value, pos: inner.pos + 1 };
  }
  if (tok.type === 'number') {
    return { value: parseInt(tok.value, 10), pos: pos + 1 };
  }
  return { value: 0, pos: pos + 1 };
}
