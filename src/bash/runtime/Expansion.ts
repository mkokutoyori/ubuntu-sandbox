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
export type HomeForFn = (user: string) => string | null;

/**
 * Expand a Word AST node into its final string value.
 */
/**
 * Bash tilde expansion. Applied to LiteralWord values that start with
 * `~`, before any other expansion. Forms:
 *   `~`             → $HOME
 *   `~/path`        → $HOME + '/path'
 *   `~user`         → that user's $HOME (via `homeFor`)
 *   `~user/path`    → user's home + '/path'
 *   `~+` / `~-`     → $PWD / $OLDPWD
 * When no expansion applies (unknown user, no homeFor, `~` mid-word)
 * the literal is returned unchanged.
 */
function expandTilde(s: string, env: Environment, homeFor?: HomeForFn): string {
  if (!s.startsWith('~')) return s;
  // End of the tilde-prefix is the first `/` or `:` (PATH-style) or EOS.
  const slash = s.indexOf('/');
  const head = slash < 0 ? s : s.slice(0, slash);
  const tail = slash < 0 ? '' : s.slice(slash);
  const userPart = head.slice(1);
  if (userPart === '') {
    const home = env.get('HOME');
    if (home === undefined) return s;
    return home + tail;
  }
  if (userPart === '+') {
    const pwd = env.get('PWD');
    return pwd === undefined ? s : pwd + tail;
  }
  if (userPart === '-') {
    const oldpwd = env.get('OLDPWD');
    return oldpwd === undefined ? s : oldpwd + tail;
  }
  if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(userPart)) return s;
  const home = homeFor?.(userPart);
  if (home == null) return s;
  return home + tail;
}

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
  homeFor?: HomeForFn,
): string {
  switch (word.type) {
    case 'LiteralWord':
      return expandTilde(stripBackslashEscapes(word.value), env, homeFor);
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
      return word.parts.map((p, i) =>
        // Tilde expansion only applies to the LEADING literal of a
        // compound word (matches bash: `foo~bar` keeps the literal).
        i === 0 ? expandWord(p, env, execCmd, homeFor)
                : expandWord(p, env, execCmd)
      ).join('');
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
  homeFor?: HomeForFn,
): string[] {
  const result: string[] = [];
  for (const w of words) {
    const expanded = expandWord(w, env, execCmd, homeFor);
    // ── Brace expansion ──────────────────────────────────────────
    // Runs BEFORE word splitting / globbing per bash precedence.
    // Covers numeric ranges (`{1..5}`, `{0..10..2}`), comma lists
    // (`{a,b,c}`), prefix/suffix concatenation (`pre{x,y}post`), and
    // nested forms (`{a,b}{1,2}` → `a1 a2 b1 b2`).
    if (isWordFullyUnquoted(w)) {
      const exp = expandBraces(expanded);
      if (exp.length > 1 || (exp.length === 1 && exp[0] !== expanded)) {
        for (const e of exp) result.push(...maybeGlob(e, w, glob));
        continue;
      }
    }
    if (shouldWordSplit(w) && expanded.includes(' ')) {
      // Word splitting: unquoted variable/command expansions are split on IFS (whitespace)
      const parts = expanded.split(/\s+/).filter(Boolean);
      for (const part of parts) result.push(...maybeGlob(part, w, glob));
      continue;
    }
    // Quoted array splatter: `"${arr[@]}"` injects U+0001 between
    // elements so we can produce one word per element here WITHOUT
    // triggering IFS splitting on whitespace inside elements. The
    // sentinel is stripped before the values reach the caller.
    if (expanded.includes(ARRAY_SEP)) {
      for (const piece of expanded.split(ARRAY_SEP)) {
        result.push(...maybeGlob(piece, w, glob));
      }
      continue;
    }
    result.push(...maybeGlob(expanded, w, glob));
  }
  return result;
}

/** Control char that joins array elements during expansion. */
export const ARRAY_SEP = '';

/**
 * Bash brace expansion. Order of recognition (per bash):
 *   1. `{N..M}` / `{N..M..STEP}`   numeric range
 *   2. `{a..z}`                    char range
 *   3. `{a,b,c}`                   comma list, recursive
 * Concatenation with prefix and suffix is automatic: `pre{x,y}post`
 * → `prexpost preypost`. Multiple groups multiply across the word:
 * `{a,b}{1,2}` → `a1 a2 b1 b2`. A `{single}` group without a comma
 * or `..` is preserved literally — that matches real bash.
 */
function expandBraces(input: string): string[] {
  const open = findBraceStart(input);
  if (open < 0) return [input];
  const close = findMatchingBrace(input, open);
  if (close < 0) return [input];

  const prefix = input.slice(0, open);
  const body = input.slice(open + 1, close);
  const suffix = input.slice(close + 1);

  const expanded = expandBraceBody(body);
  if (!expanded) {
    const tails = expandBraces(suffix);
    return tails.map(t => prefix + '{' + body + '}' + t);
  }
  const out: string[] = [];
  for (const e of expanded) {
    for (const tail of expandBraces(suffix)) {
      out.push(prefix + e + tail);
    }
  }
  return out;
}

function findBraceStart(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '{') return i;
  }
  return -1;
}

function findMatchingBrace(s: string, open: number): number {
  let depth = 1;
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function expandBraceBody(body: string): string[] | null {
  const range = body.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/);
  if (range) {
    const start = Number.parseInt(range[1], 10);
    const end = Number.parseInt(range[2], 10);
    const step = Math.abs(Number.parseInt(range[3] ?? '1', 10)) || 1;
    const dir = start <= end ? 1 : -1;
    const out: string[] = [];
    for (let i = start; dir > 0 ? i <= end : i >= end; i += dir * step) out.push(String(i));
    return out;
  }
  const charRange = body.match(/^([A-Za-z])\.\.([A-Za-z])$/);
  if (charRange) {
    const a = charRange[1].charCodeAt(0);
    const b = charRange[2].charCodeAt(0);
    const dir = a <= b ? 1 : -1;
    const out: string[] = [];
    for (let i = a; dir > 0 ? i <= b : i >= b; i += dir) out.push(String.fromCharCode(i));
    return out;
  }
  const segments = splitTopLevelCommas(body);
  if (segments.length <= 1) return null;
  const out: string[] = [];
  for (const seg of segments) out.push(...expandBraces(seg));
  return out;
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { buf += c + s[++i]; continue; }
    if (c === '{') { depth++; buf += c; continue; }
    if (c === '}') { depth--; buf += c; continue; }
    if (c === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
    buf += c;
  }
  out.push(buf);
  return out;
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
/** True when no part of the word came from quotes (used for brace expansion). */
function isWordFullyUnquoted(w: Word): boolean {
  switch (w.type) {
    case 'SingleQuotedWord':
    case 'DoubleQuotedWord':
      return false;
    case 'CompoundWord':
      return w.parts.every(isWordFullyUnquoted);
    default:
      return true;
  }
}

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
  // ── Indexed-array access: `${arr[expr]}` ──────────────────────────
  // The name carries the subscript through the parser as part of the
  // modifier (e.g. `[0]`), with optional further modifiers chained
  // after (`[0]:offset`, `[@]/pat/repl`, …). We resolve the subscript
  // first, then either return the element string directly or feed the
  // sliced value back through the regular modifier pipeline.
  if (modifier && modifier.startsWith('[')) {
    const close = matchingBracket(modifier);
    if (close > 0) {
      const subscript = modifier.slice(1, close);
      const restMod = modifier.slice(close + 1) || undefined;
      return expandArrayAccess(name, subscript, restMod, env);
    }
  }

  if (!modifier) {
    // Bare `$arr` reads element 0 when an array exists, mirroring bash.
    const arr = env.getArray(name);
    if (arr !== undefined) return arr[0] ?? '';
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

/**
 * Position of the matching `]` for the opening `[` at index 0 of
 * `modifier`. Supports nested `[…]` (rare in practice, but legal).
 * Returns -1 when no match.
 */
function matchingBracket(modifier: string): number {
  let depth = 0;
  for (let i = 0; i < modifier.length; i++) {
    if (modifier[i] === '[') depth++;
    else if (modifier[i] === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Resolve `${arr[subscript]}` (with optional trailing modifier).
 * Subscripts:
 *   N        numeric, possibly negative
 *   @ or *   every element (space-joined for the unquoted path)
 * Length form `${#arr[@]}` is handled separately by the brace parser
 * which strips the leading `#` and supplies a modifier directly.
 */
function expandArrayAccess(
  name: string,
  subscript: string,
  trailing: string | undefined,
  env: Environment,
): string {
  const assoc = env.isAssoc(name);
  const arr = env.getArray(name);
  if (subscript === '@' || subscript === '*') {
    if (assoc) {
      const values = env.getAssocValues(name);
      const joined = subscript === '@' ? values.join(ARRAY_SEP) : values.join(' ');
      return trailing ? applyTrailingModifier(joined, trailing, env, name) : joined;
    }
    if (!arr) {
      const scalar = env.get(name);
      const value = scalar === undefined ? '' : scalar;
      return trailing ? applyTrailingModifier(value, trailing, env, name) : value;
    }
    // `[@]` produces one word per element when expanded; `[*]` joins on
    // IFS's first char (defaulting to space). For `[@]` we use the
    // ARRAY_SEP sentinel so expandWords can split element-wise without
    // re-triggering IFS splitting on whitespace inside an element.
    const joined = subscript === '@' ? arr.join(ARRAY_SEP) : arr.join(' ');
    return trailing ? applyTrailingModifier(joined, trailing, env, name) : joined;
  }
  if (assoc) {
    // Substitute simple `$name` references in the key before lookup.
    const key = subscript.replace(/\$\{?([A-Za-z_][A-Za-z_0-9]*)\}?/g, (_, n) => env.get(n) ?? '');
    const elem = env.getAssocElement(name, key);
    // Route through the trailing modifier even when the element is
    // missing so `${m[k]:-default}` falls back as bash does.
    const value = elem ?? '';
    if (trailing) return applyTrailingModifier(value, trailing, env, name, elem === undefined);
    return value;
  }
  const idx = Number.parseInt(subscript, 10);
  if (!Number.isFinite(idx)) return '';
  const elem = env.getArrayElement(name, idx);
  if (elem === undefined) {
    if (arr === undefined && env.get(name) === undefined && isNounsetActive(env)) {
      throw new BashRuntimeError(`${name}[${subscript}]: unbound variable`);
    }
    return '';
  }
  return trailing ? applyTrailingModifier(elem, trailing, env, name) : elem;
}

/**
 * Apply a tail modifier (`:n:m`, `#pat`, `/pat/repl`, …) to an
 * already-resolved string. We synthesise a one-shot environment entry
 * under a fresh key so we can reuse the full modifier engine without
 * mutating the live env. The synthetic name carries no `local` flag,
 * so cleanup happens automatically when the scope unwinds.
 */
function applyTrailingModifier(
  value: string,
  modifier: string,
  env: Environment,
  hintName: string,
  treatAsUnset = false,
): string {
  const tmpName = `__bashtmp_${hintName}_${Math.random().toString(36).slice(2, 9)}`;
  env.declareLocal(tmpName);
  // When the upstream lookup found nothing (`treatAsUnset`), leave the
  // slot truly unset so default-value modifiers (`:-`, `-`) fire.
  if (!treatAsUnset) env.set(tmpName, value);
  try { return expandVariable(tmpName, true, modifier, env); }
  finally { env.unset(tmpName); }
}

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
        // ${#NAME} — scalar length OR ${#arr[@]} — array element count.
        if (content.startsWith('#')) {
          const lenMatch = content.slice(1).match(/^([A-Za-z_][A-Za-z_0-9]*)(\[([^\]]+)\])?$/);
          if (lenMatch) {
            const lname = lenMatch[1];
            const sub = lenMatch[3];
            if (sub === '@' || sub === '*') {
              if (env.isAssoc(lname)) { result += String(env.getAssocSize(lname)); continue; }
              result += String(env.getArrayLength(lname));
              continue;
            }
            if (sub !== undefined) {
              if (env.isAssoc(lname)) {
                const v = env.getAssocElement(lname, sub) ?? '';
                result += String(v.length);
                continue;
              }
              const elem = env.getArrayElement(lname, Number.parseInt(sub, 10)) ?? '';
              result += String(elem.length);
              continue;
            }
            // Scalar length — but report array length when the bare
            // name refers to an array (POSIX says element 0's length;
            // bash reports element 0's length too).
            result += expandVariable(lname, true, '#', env);
            continue;
          }
        }
        // ${!NAME[@]} — list of keys / indices.
        if (content.startsWith('!')) {
          const keyMatch = content.slice(1).match(/^([A-Za-z_][A-Za-z_0-9]*)\[([@*])\]$/);
          if (keyMatch) {
            const lname = keyMatch[1];
            if (env.isAssoc(lname)) {
              result += env.getAssocKeys(lname).join(ARRAY_SEP);
            } else {
              const arr = env.getArray(lname);
              if (arr) result += arr.map((_, i) => String(i)).join(ARRAY_SEP);
            }
            continue;
          }
          // ${!NAME} — indirect expansion.
          const indMatch = content.slice(1).match(/^([A-Za-z_][A-Za-z_0-9]*)$/);
          if (indMatch) {
            const target = env.get(indMatch[1]);
            result += target !== undefined ? (env.get(target) ?? '') : '';
            continue;
          }
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
    } else if (ch === '+' && i + 1 < expr.length && expr[i + 1] === '+') {
      tokens.push({ type: 'op', value: '++' }); i += 2;
    } else if (ch === '-' && i + 1 < expr.length && expr[i + 1] === '-') {
      tokens.push({ type: 'op', value: '--' }); i += 2;
    } else if ((ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '%')
               && i + 1 < expr.length && expr[i + 1] === '=') {
      tokens.push({ type: 'op', value: ch + '=' }); i += 2;
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

  // assignment: name (= | += | -= | *= | /= | %=) expr | ternary
  private parseAssignment(): number {
    if (this.pos < this.tokens.length && this.tokens[this.pos].type === 'name') {
      const nameIdx = this.pos;
      const name = this.tokens[nameIdx].value;
      const next = this.tokens[nameIdx + 1];
      if (next && next.type === 'op'
          && (next.value === '=' || next.value === '+=' || next.value === '-='
              || next.value === '*=' || next.value === '/=' || next.value === '%=')) {
        const op = next.value;
        this.pos = nameIdx + 2;
        const rhs = this.parseAssignment();
        const current = Number.parseInt(this.env.get(name) ?? '0', 10) || 0;
        let next$: number;
        switch (op) {
          case '=':  next$ = rhs;             break;
          case '+=': next$ = current + rhs;   break;
          case '-=': next$ = current - rhs;   break;
          case '*=': next$ = current * rhs;   break;
          case '/=': next$ = rhs === 0 ? 0 : Math.trunc(current / rhs); break;
          case '%=': next$ = rhs === 0 ? 0 : current - Math.trunc(current / rhs) * rhs; break;
          default:   next$ = rhs;
        }
        this.env.set(name, String(next$));
        return next$;
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

  // unary: ! unary | - unary | ++name | --name | postfix
  private parseUnary(): number {
    const tok = this.tokens[this.pos];
    if (tok && tok.type === 'op' && tok.value === '!') {
      this.pos++;
      const val = this.parseUnary();
      return val === 0 ? 1 : 0;
    }
    if (tok && tok.type === 'op' && (tok.value === '++' || tok.value === '--')) {
      this.pos++;
      const nameTok = this.tokens[this.pos];
      if (nameTok && nameTok.type === 'name') {
        this.pos++;
        const current = Number.parseInt(this.env.get(nameTok.value) ?? '0', 10) || 0;
        const next = tok.value === '++' ? current + 1 : current - 1;
        this.env.set(nameTok.value, String(next));
        return next;
      }
      return 0;
    }
    return this.parsePostfix();
  }

  // postfix: primary (++ | --)?
  private parsePostfix(): number {
    const val = this.parsePrimary();
    // Track the most recently consumed name so postfix can write back.
    const tok = this.tokens[this.pos];
    if (tok && tok.type === 'op' && (tok.value === '++' || tok.value === '--')) {
      this.pos++;
      // The previous primary must have been a `name` for the post-op
      // to be meaningful; walk back to recover it.
      const prior = this.tokens[this.pos - 2];
      if (prior && prior.type === 'name') {
        const current = Number.parseInt(this.env.get(prior.value) ?? '0', 10) || 0;
        const next = tok.value === '++' ? current + 1 : current - 1;
        this.env.set(prior.value, String(next));
        // Postfix returns the value BEFORE the update.
        return current;
      }
    }
    return val;
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
