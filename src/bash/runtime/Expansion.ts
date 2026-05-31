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
/** Strip `\<ch>` → `<ch>` (quote removal for shell-style escapes). */
function stripBackslashEscapes(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { out += s[i + 1]; i++; continue; }
    out += s[i];
  }
  return out;
}

export function expandWord(
  word: Word,
  env: Environment,
  execCmd?: CommandSubstitutionFn,
): string {
  switch (word.type) {
    case 'LiteralWord':
      return stripBackslashEscapes(word.value);
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
/**
 * Glob-expand `pattern` against the live filesystem. The callback owns
 * cwd-resolution; returning `null` means "no glob support" and the
 * interpreter keeps the literal (bash `nullglob`-off semantics).
 */
export type GlobFn = (pattern: string) => string[] | null;

export function expandWords(
  words: Word[],
  env: Environment,
  execCmd?: CommandSubstitutionFn,
  glob?: GlobFn,
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
      continue;
    }
    if (shouldWordSplit(w) && expanded.includes(' ')) {
      // Word splitting: unquoted variable/command expansions are split on IFS (whitespace)
      const parts = expanded.split(/\s+/).filter(Boolean);
      for (const part of parts) result.push(...maybeGlob(part, w, glob));
      continue;
    }
    result.push(...maybeGlob(expanded, w, glob));
  }
  return result;
}

/**
 * Apply glob expansion only when the original word carries at least one
 * UN-escaped, UN-quoted meta-character. Bash semantics: a no-match
 * keeps the literal pattern.
 */
function maybeGlob(value: string, w: Word, glob?: GlobFn): string[] {
  if (!glob) return [value];
  if (!hasUnescapedMeta(w)) return [value];
  const hits = glob(value);
  if (hits === null || hits.length === 0) return [value];
  return hits;
}

/** True when the word contains an unquoted, unescaped `*`/`?`/`[`. */
function hasUnescapedMeta(w: Word): boolean {
  switch (w.type) {
    case 'SingleQuotedWord':
    case 'DoubleQuotedWord':
      return false;
    case 'LiteralWord':
      return literalHasUnescapedMeta(w.value);
    case 'CompoundWord':
      return w.parts.some(hasUnescapedMeta);
    case 'VariableRef':
    case 'CommandSubstitution':
    case 'ArithmeticSubstitution':
      // Expansions undergo word-splitting but not glob in our model
      // (matches bash without `set -f` only for cases without meta).
      return false;
    default:
      return false;
  }
}

function literalHasUnescapedMeta(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '\\') { i++; continue; }
    if (raw[i] === '*' || raw[i] === '?' || raw[i] === '[') return true;
  }
  return false;
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

/**
 * Convert a bash glob pattern (used by parameter-expansion `#`/`%`/`/`
 * operators) into a JS regex source. Supports `*` `?` `[…]` and
 * literal-escapes everything else. Anchored by the caller via `^`/`$`.
 */
function globToRegexSource(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') { out += '.*'; continue; }
    if (c === '?') { out += '.';  continue; }
    if (c === '[') {
      let cls = '[';
      i++;
      if (pattern[i] === '!' || pattern[i] === '^') { cls += '^'; i++; }
      while (i < pattern.length && pattern[i] !== ']') { cls += pattern[i]; i++; }
      cls += ']';
      out += cls;
      continue;
    }
    if (/[.+(){}^$|\\]/.test(c)) out += '\\' + c;
    else out += c;
  }
  return out;
}

/**
 * Bash parameter expansion. Supports the full POSIX/Bash menagerie:
 *
 *   ${name}              plain                ${#name}            length
 *   ${name:-w}  ${name-w}                     use default
 *   ${name:=w}  ${name=w}                     assign default
 *   ${name:+w}  ${name+w}                     use alternative
 *   ${name:?w}  ${name?w}                     error if unset
 *   ${name:n}   ${name:n:m}                   substring (negative ⇒ tail)
 *   ${name#pat} ${name##pat}                  strip prefix (short/long)
 *   ${name%pat} ${name%%pat}                  strip suffix (short/long)
 *   ${name/pat/repl}   ${name//pat/repl}      replace first / all
 *   ${name/#pat/repl}  ${name/%pat/repl}      anchored replace
 *   ${name^}   ${name^^}                      upper-case (first / all)
 *   ${name,}   ${name,,}                      lower-case (first / all)
 */
function expandVariable(
  name: string,
  braced: boolean,
  modifier: string | undefined,
  env: Environment,
): string {
  if (!modifier) {
    const v = env.get(name);
    if (v === undefined && isNounsetActive(env)) {
      throw new BashRuntimeError(`${name}: unbound variable`);
    }
    return v ?? '';
  }

  // ${#name} — length
  if (modifier === '#') return String((env.get(name) ?? '').length);

  const val = env.get(name);
  const raw = val ?? '';

  // ── Default / alternative / assign / error ────────────────────────
  // Recognise the multi-char variants BEFORE bare `:` substring form.
  const dm = modifier.match(/^(:[-+=?]|[-+=?])(.*)$/s);
  if (dm) {
    const [, op, word] = dm;
    const isColon = op.startsWith(':');
    const isEmpty = val === undefined || (isColon && val === '');
    switch (op[op.length - 1]) {
      case '-': return isEmpty ? word : raw;
      case '=':
        if (isEmpty) { env.set(name, word); return word; }
        return raw;
      case '+':
        return val !== undefined && (!isColon || val !== '') ? word : '';
      case '?':
        if (isEmpty) throw new BashRuntimeError(word || `${name}: parameter null or not set`);
        return raw;
    }
  }

  // ── Substring: ${name:offset} / ${name:offset:length} ─────────────
  if (modifier.startsWith(':') && /^-?\d/.test(modifier.slice(1))) {
    const parts = modifier.slice(1).split(':');
    const offsetRaw = Number.parseInt(parts[0], 10);
    const lenRaw    = parts.length > 1 ? Number.parseInt(parts[1], 10) : undefined;
    const len = lenRaw;
    let start = offsetRaw < 0 ? Math.max(0, raw.length + offsetRaw) : offsetRaw;
    if (start > raw.length) start = raw.length;
    if (len === undefined) return raw.slice(start);
    if (len < 0) {
      const end = Math.max(start, raw.length + len);
      return raw.slice(start, end);
    }
    return raw.slice(start, start + len);
  }

  // ── Prefix strip: ${name#pat} / ${name##pat} ──────────────────────
  if (modifier.startsWith('#')) {
    const longest = modifier.startsWith('##');
    const pat = modifier.slice(longest ? 2 : 1);
    if (pat === '') return raw;
    const re = new RegExp(longest ? `^(?:${globToRegexSource(pat)})` : `^(?:${globToRegexSource(pat)}?)`);
    return longest ? raw.replace(re, '') : stripShortestPrefix(raw, pat);
  }

  // ── Suffix strip: ${name%pat} / ${name%%pat} ──────────────────────
  if (modifier.startsWith('%')) {
    const longest = modifier.startsWith('%%');
    const pat = modifier.slice(longest ? 2 : 1);
    if (pat === '') return raw;
    return longest ? stripLongestSuffix(raw, pat) : stripShortestSuffix(raw, pat);
  }

  // ── Pattern replacement: ${name/pat/repl}, ${name//pat/repl} ──────
  if (modifier.startsWith('/')) {
    const all  = modifier.startsWith('//');
    const body = modifier.slice(all ? 2 : 1);
    let anchor: '^' | '$' | '' = '';
    let rest = body;
    if (body.startsWith('#')) { anchor = '^'; rest = body.slice(1); }
    else if (body.startsWith('%')) { anchor = '$'; rest = body.slice(1); }
    // Split on the first unescaped '/'.
    let pat = '', repl = '', sawSlash = false;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i];
      if (!sawSlash && c === '\\' && rest[i + 1] === '/') { pat += '/'; i++; continue; }
      if (!sawSlash && c === '/') { sawSlash = true; continue; }
      if (sawSlash) repl += c; else pat += c;
    }
    if (pat === '') return raw;
    const flags = all ? 'g' : '';
    const src = anchor === '^' ? '^' + globToRegexSource(pat)
              : anchor === '$' ? globToRegexSource(pat) + '$'
              : globToRegexSource(pat);
    try { return raw.replace(new RegExp(src, flags), repl); }
    catch { return raw; }
  }

  // ── Case modification: ${name^}, ${name^^}, ${name,}, ${name,,} ───
  if (modifier === '^^') return raw.toUpperCase();
  if (modifier === ',,') return raw.toLowerCase();
  if (modifier === '^')  return raw.length === 0 ? '' : raw[0].toUpperCase() + raw.slice(1);
  if (modifier === ',')  return raw.length === 0 ? '' : raw[0].toLowerCase() + raw.slice(1);
  if (modifier.startsWith('^^')) {
    const pat = modifier.slice(2); if (pat === '') return raw.toUpperCase();
    return raw.replace(new RegExp(globToRegexSource(pat), 'g'), (m) => m.toUpperCase());
  }
  if (modifier.startsWith(',,')) {
    const pat = modifier.slice(2); if (pat === '') return raw.toLowerCase();
    return raw.replace(new RegExp(globToRegexSource(pat), 'g'), (m) => m.toLowerCase());
  }

  return raw;
}

/** Bash runtime error thrown by `${var:?msg}` and similar guards. */
export class BashRuntimeError extends Error {}

/** True when `set -u` (nounset) is active for the given environment. */
function isNounsetActive(env: Environment): boolean {
  const so = env.get('SHELLOPTS');
  return !!so && so.split(':').includes('nounset');
}

function stripShortestPrefix(s: string, pattern: string): string {
  const src = globToRegexSource(pattern);
  for (let len = 0; len <= s.length; len++) {
    if (new RegExp(`^(?:${src})$`).test(s.slice(0, len))) return s.slice(len);
  }
  return s;
}
function stripShortestSuffix(s: string, pattern: string): string {
  const src = globToRegexSource(pattern);
  for (let len = 0; len <= s.length; len++) {
    if (new RegExp(`^(?:${src})$`).test(s.slice(s.length - len))) return s.slice(0, s.length - len);
  }
  return s;
}
function stripLongestSuffix(s: string, pattern: string): string {
  const src = globToRegexSource(pattern);
  for (let len = s.length; len >= 0; len--) {
    if (new RegExp(`^(?:${src})$`).test(s.slice(s.length - len))) return s.slice(0, s.length - len);
  }
  return s;
}

// ─── Double-Quoted Expansion ────────────────────────────────────

function expandDoubleQuotedParts(
  parts: WordPart[],
  env: Environment,
  execCmd?: CommandSubstitutionFn,
): string {
  return parts.map(part => {
    switch (part.type) {
      case 'text': return expandInlineVars(part.value, env, execCmd);
      case 'variable': return expandVariable(part.name, part.braced, part.modifier, env);
      case 'special': return env.get(part.name) ?? '';
      case 'command': return execCmd ? execCmd(part.command).trimEnd() : '';
      case 'arithmetic': return evaluateArithmetic(part.expression, env);
      default: return '';
    }
  }).join('');
}

/** Expand $VAR, ${VAR}, $(cmd), $((expr)), and `cmd` inline within a text string. */
function expandInlineVars(
  text: string,
  env: Environment,
  execCmd?: CommandSubstitutionFn,
): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    // Escaped characters
    if (text[i] === '\\' && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === '$') { result += '$'; i += 2; continue; }
      if (next === '"') { result += '"'; i += 2; continue; }
      if (next === 'n') { result += '\n'; i += 2; continue; }
      if (next === 't') { result += '\t'; i += 2; continue; }
      if (next === '\\') { result += '\\'; i += 2; continue; }
      result += text[i]; i++; continue;
    }

    // Backtick command substitution
    if (text[i] === '`') {
      i++;
      let cmd = '';
      while (i < text.length && text[i] !== '`') { cmd += text[i]; i++; }
      if (i < text.length) i++; // skip closing `
      result += execCmd ? execCmd(cmd).trimEnd() : '';
      continue;
    }

    // Dollar expansions
    if (text[i] === '$' && i + 1 < text.length) {
      const next = text[i + 1];

      // $((expr)) — arithmetic
      if (next === '(' && i + 2 < text.length && text[i + 2] === '(') {
        i += 3;
        let depth = 1;
        let expr = '';
        while (i < text.length && depth > 0) {
          if (text[i] === '(' && text[i + 1] === '(') { depth++; expr += '(('; i += 2; }
          else if (text[i] === ')' && i + 1 < text.length && text[i + 1] === ')') {
            depth--;
            if (depth > 0) { expr += '))'; i += 2; }
          }
          else { expr += text[i]; i++; }
        }
        if (depth === 0) i += 2; // skip ))
        result += evaluateArithmetic(expr, env);
        continue;
      }

      // $(cmd) — command substitution
      if (next === '(') {
        i += 2;
        let depth = 1;
        let cmd = '';
        while (i < text.length && depth > 0) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')') { depth--; if (depth === 0) break; }
          cmd += text[i]; i++;
        }
        if (i < text.length) i++; // skip closing )
        result += execCmd ? execCmd(cmd).trimEnd() : '';
        continue;
      }

      // ${VAR...} — braced variable. Brace nesting is honoured so
      // patterns containing `}` (rare, but legal inside replacement
      // bodies) survive.
      if (next === '{') {
        i += 2;
        let content = '';
        let depth = 1;
        while (i < text.length && depth > 0) {
          const ch = text[i];
          if (ch === '{') { depth++; content += ch; i++; continue; }
          if (ch === '}') { depth--; if (depth === 0) { i++; break; } content += ch; i++; continue; }
          content += ch; i++;
        }
        // ${#NAME} — length
        if (content.startsWith('#') && /^#[A-Za-z_][A-Za-z_0-9]*$/.test(content)) {
          result += expandVariable(content.slice(1), true, '#', env);
          continue;
        }
        // Split the head (name) from the modifier suffix.
        const head = content.match(/^([A-Za-z_][A-Za-z_0-9]*|[0-9]+|[?@*#$!])/);
        if (head) {
          const name = head[1];
          const modifier = content.slice(name.length);
          result += expandVariable(name, true, modifier || undefined, env);
        } else {
          result += env.get(content) ?? '';
        }
        continue;
      }

      // $VAR or $? $# etc — simple variable
      if (/[A-Za-z_]/.test(next)) {
        i++;
        let name = '';
        while (i < text.length && /[A-Za-z_0-9]/.test(text[i])) { name += text[i]; i++; }
        const v = env.get(name);
        if (v === undefined && isNounsetActive(env)) {
          throw new BashRuntimeError(`${name}: unbound variable`);
        }
        result += v ?? '';
        continue;
      }
      if (/[?#@*$!\d]/.test(next)) {
        const val = env.get(next);
        // Positional parameter that's undefined at this scope: leave
        // literal so a double-quoted heredoc carrying a function body
        // (e.g. "fn() { echo \$1; }") survives the write to the
        // destination file. Once a function is called the child scope
        // will have $1 set and the substitution happens normally.
        if (/\d/.test(next) && val === undefined) {
          result += `$${next}`;
        } else {
          result += val ?? '';
        }
        i += 2;
        continue;
      }
    }

    result += text[i]; i++;
  }
  return result;
}

/** Strip surrounding quotes from a string (for ${VAR:-"default"} patterns). */
function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
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
