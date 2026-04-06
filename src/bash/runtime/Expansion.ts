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
  const result: string[] = [];
  for (const w of words) {
    const expanded = expandWord(w, env, execCmd);
    // Check for brace expansion: {start..end}
    const braceMatch = expanded.match(/^\{(-?\d+)\.\.(-?\d+)\}$/);
    if (braceMatch) {
      const start = parseInt(braceMatch[1]);
      const end = parseInt(braceMatch[2]);
      const step = start <= end ? 1 : -1;
      for (let i = start; step > 0 ? i <= end : i >= end; i += step) {
        result.push(String(i));
      }
    } else if (shouldWordSplit(w) && expanded.includes(' ')) {
      // Word splitting: unquoted variable/command expansions are split on IFS (whitespace)
      const parts = expanded.split(/\s+/).filter(Boolean);
      result.push(...parts);
    } else {
      result.push(expanded);
    }
  }
  return result;
}

/** Determine if a word should undergo IFS word splitting (unquoted expansions). */
function shouldWordSplit(w: Word): boolean {
  if (w.type === 'VariableRef' || w.type === 'CommandSubstitution') return true;
  if (w.type === 'CompoundWord') {
    return w.parts.some(p => p.type === 'VariableRef' || p.type === 'CommandSubstitution');
  }
  return false;
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

/** Expand $VAR, ${VAR}, and $? etc. inline within a text string. Handles \$ escapes. */
function expandInlineVars(text: string, env: Environment): string {
  // First pass: replace \$ with a placeholder, then expand, then restore
  const PLACEHOLDER = '%%ESC_DOLLAR%%';
  const escaped = text.replace(/\\\$/g, PLACEHOLDER);
  const expanded = escaped.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z_0-9]*|\?|#|@|\*|\$|!|\d+)/g,
    (_match, braced, simple) => {
      const name = braced ?? simple;
      return env.get(name) ?? '';
    });
  // Also handle other common escapes: \\, \", \n, \t within double-quote context
  return expanded
    .replaceAll(PLACEHOLDER, '$')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
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
  const parser = new ArithParser(tokens, env);
  return parser.parse();
}

interface ArithToken {
  type: 'number' | 'op' | 'lparen' | 'rparen' | 'question' | 'colon' | 'name';
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
      tokens.push({ type: 'name', value: name });
    } else if (ch === '$') {
      i++;
      let name = '';
      while (i < expr.length && /[a-zA-Z_0-9]/.test(expr[i])) { name += expr[i]; i++; }
      tokens.push({ type: 'name', value: name });
    } else if (ch === '(') {
      tokens.push({ type: 'lparen', value: '(' }); i++;
    } else if (ch === ')') {
      tokens.push({ type: 'rparen', value: ')' }); i++;
    } else if (ch === '?') {
      tokens.push({ type: 'question', value: '?' }); i++;
    } else if (ch === ':') {
      tokens.push({ type: 'colon', value: ':' }); i++;
    } else if (ch === '!' && i + 1 < expr.length && expr[i + 1] === '=') {
      tokens.push({ type: 'op', value: '!=' }); i += 2;
    } else if (ch === '!' ) {
      tokens.push({ type: 'op', value: '!' }); i++;
    } else if (ch === '=' && i + 1 < expr.length && expr[i + 1] === '=') {
      tokens.push({ type: 'op', value: '==' }); i += 2;
    } else if (ch === '=') {
      tokens.push({ type: 'op', value: '=' }); i++;
    } else if (ch === '<' && i + 1 < expr.length && expr[i + 1] === '=') {
      tokens.push({ type: 'op', value: '<=' }); i += 2;
    } else if (ch === '<') {
      tokens.push({ type: 'op', value: '<' }); i++;
    } else if (ch === '>' && i + 1 < expr.length && expr[i + 1] === '=') {
      tokens.push({ type: 'op', value: '>=' }); i += 2;
    } else if (ch === '>') {
      tokens.push({ type: 'op', value: '>' }); i++;
    } else if (ch === '&' && i + 1 < expr.length && expr[i + 1] === '&') {
      tokens.push({ type: 'op', value: '&&' }); i += 2;
    } else if (ch === '|' && i + 1 < expr.length && expr[i + 1] === '|') {
      tokens.push({ type: 'op', value: '||' }); i += 2;
    } else if ('+-*/%'.includes(ch)) {
      // Handle unary minus
      if (ch === '-' && (tokens.length === 0 || tokens[tokens.length - 1].type === 'op' || tokens[tokens.length - 1].type === 'lparen')) {
        i++;
        let num = '';
        if (i < expr.length && /[0-9]/.test(expr[i])) {
          while (i < expr.length && /[0-9]/.test(expr[i])) { num += expr[i]; i++; }
          tokens.push({ type: 'number', value: '-' + num });
        } else if (i < expr.length && /[a-zA-Z_]/.test(expr[i])) {
          // Unary minus on variable: -x
          let name = '';
          while (i < expr.length && /[a-zA-Z_0-9]/.test(expr[i])) { name += expr[i]; i++; }
          const val = env.get(name) ?? '0';
          tokens.push({ type: 'number', value: String(-(parseInt(val) || 0)) });
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

/** Recursive descent arithmetic parser with full operator precedence. */
class ArithParser {
  private tokens: ArithToken[];
  private pos: number;
  private env: Environment;

  constructor(tokens: ArithToken[], env: Environment) {
    this.tokens = tokens;
    this.pos = 0;
    this.env = env;
  }

  parse(): number {
    if (this.tokens.length === 0) return 0;
    const val = this.parseAssignment();
    return val;
  }

  // assignment: name = expr | ternary
  private parseAssignment(): number {
    // Check for name = expr pattern
    if (this.pos < this.tokens.length && this.tokens[this.pos].type === 'name') {
      const nameIdx = this.pos;
      const name = this.tokens[nameIdx].value;
      if (nameIdx + 1 < this.tokens.length && this.tokens[nameIdx + 1].type === 'op' && this.tokens[nameIdx + 1].value === '=') {
        this.pos = nameIdx + 2;
        const val = this.parseAssignment();
        this.env.set(name, String(val));
        return val;
      }
    }
    return this.parseTernary();
  }

  // ternary: logicalOr ? expr : expr
  private parseTernary(): number {
    let val = this.parseLogicalOr();
    if (this.pos < this.tokens.length && this.tokens[this.pos].type === 'question') {
      this.pos++; // skip ?
      const trueVal = this.parseAssignment();
      if (this.pos < this.tokens.length && this.tokens[this.pos].type === 'colon') {
        this.pos++; // skip :
      }
      const falseVal = this.parseAssignment();
      val = val !== 0 ? trueVal : falseVal;
    }
    return val;
  }

  // logicalOr: logicalAnd (|| logicalAnd)*
  private parseLogicalOr(): number {
    let val = this.parseLogicalAnd();
    while (this.matchOp('||')) {
      const right = this.parseLogicalAnd();
      val = (val !== 0 || right !== 0) ? 1 : 0;
    }
    return val;
  }

  // logicalAnd: equality (&& equality)*
  private parseLogicalAnd(): number {
    let val = this.parseEquality();
    while (this.matchOp('&&')) {
      const right = this.parseEquality();
      val = (val !== 0 && right !== 0) ? 1 : 0;
    }
    return val;
  }

  // equality: relational ((== | !=) relational)*
  private parseEquality(): number {
    let val = this.parseRelational();
    while (this.pos < this.tokens.length && this.tokens[this.pos].type === 'op' &&
           (this.tokens[this.pos].value === '==' || this.tokens[this.pos].value === '!=')) {
      const op = this.tokens[this.pos].value;
      this.pos++;
      const right = this.parseRelational();
      val = op === '==' ? (val === right ? 1 : 0) : (val !== right ? 1 : 0);
    }
    return val;
  }

  // relational: additive ((< | > | <= | >=) additive)*
  private parseRelational(): number {
    let val = this.parseAdditive();
    while (this.pos < this.tokens.length && this.tokens[this.pos].type === 'op' &&
           ['<', '>', '<=', '>='].includes(this.tokens[this.pos].value)) {
      const op = this.tokens[this.pos].value;
      this.pos++;
      const right = this.parseAdditive();
      switch (op) {
        case '<': val = val < right ? 1 : 0; break;
        case '>': val = val > right ? 1 : 0; break;
        case '<=': val = val <= right ? 1 : 0; break;
        case '>=': val = val >= right ? 1 : 0; break;
      }
    }
    return val;
  }

  // additive: multiplicative ((+ | -) multiplicative)*
  private parseAdditive(): number {
    let val = this.parseMultiplicative();
    while (this.pos < this.tokens.length && this.tokens[this.pos].type === 'op' &&
           (this.tokens[this.pos].value === '+' || this.tokens[this.pos].value === '-')) {
      const op = this.tokens[this.pos].value;
      this.pos++;
      const right = this.parseMultiplicative();
      val = op === '+' ? val + right : val - right;
    }
    return val;
  }

  // multiplicative: unary ((* | / | %) unary)*
  private parseMultiplicative(): number {
    let val = this.parseUnary();
    while (this.pos < this.tokens.length && this.tokens[this.pos].type === 'op' &&
           '*/%'.includes(this.tokens[this.pos].value)) {
      const op = this.tokens[this.pos].value;
      this.pos++;
      const right = this.parseUnary();
      if ((op === '/' || op === '%') && right === 0) throw new ArithmeticError('division by zero');
      val = op === '*' ? val * right : op === '/' ? Math.trunc(val / right) : val % right;
    }
    return val;
  }

  // unary: ! unary | - unary | primary
  private parseUnary(): number {
    if (this.pos < this.tokens.length && this.tokens[this.pos].type === 'op' && this.tokens[this.pos].value === '!') {
      this.pos++;
      const val = this.parseUnary();
      return val === 0 ? 1 : 0;
    }
    return this.parsePrimary();
  }

  // primary: number | name | ( expr )
  private parsePrimary(): number {
    if (this.pos >= this.tokens.length) return 0;
    const tok = this.tokens[this.pos];

    if (tok.type === 'lparen') {
      this.pos++;
      const val = this.parseAssignment();
      if (this.pos < this.tokens.length && this.tokens[this.pos].type === 'rparen') {
        this.pos++;
      }
      return val;
    }
    if (tok.type === 'number') {
      this.pos++;
      return parseInt(tok.value, 10) || 0;
    }
    if (tok.type === 'name') {
      this.pos++;
      const val = this.env.get(tok.value) ?? '0';
      return parseInt(val) || 0;
    }
    this.pos++;
    return 0;
  }

  private matchOp(op: string): boolean {
    if (this.pos < this.tokens.length && this.tokens[this.pos].type === 'op' && this.tokens[this.pos].value === op) {
      this.pos++;
      return true;
    }
    return false;
  }
}
