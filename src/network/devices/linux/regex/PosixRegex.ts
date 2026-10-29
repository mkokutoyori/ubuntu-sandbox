/**
 * PosixRegex — translate POSIX regular expressions to JavaScript RegExp.
 *
 * GNU `grep` / `sed` accept three flavours:
 *   - BRE (Basic, the default): `\( \) \{ \} \+ \? \|` are the operators;
 *     the bare `( ) { } + ? |` are literal characters.
 *   - ERE (Extended, `-E` / `-r`): `( ) { } + ? |` are operators; their
 *     backslashed forms are literal.
 *   - Fixed (`-F`): the pattern is a literal string, no metacharacters.
 *
 * Both flavours are parsed by PosixEre (glibc grammar and error texts): a BRE
 * is first rewritten into ERE form (operators swapped, a leading `*` and a
 * `^` or `$` away from the ends made literal). Bracket expressions `[...]`
 * are copied as a unit so their contents are never mis-translated.
 */

import { ereToJsSource, MESSAGES, PosixRegexError } from './PosixEre';

export interface PosixRegexOptions {
  extended?: boolean;     // ERE when true, BRE when false
  fixed?: boolean;        // -F: treat the pattern as a literal string
  ignoreCase?: boolean;   // -i / I flag
  multiline?: boolean;    // ^/$ match line boundaries (m flag)
  global?: boolean;       // g flag
  wholeWord?: boolean;    // -w
  wholeLine?: boolean;    // -x
  rightParenIsError?: boolean;
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bracketEnd(src: string, start: number): number {
  let i = start + 1;
  if (src[i] === '^') i++;
  if (src[i] === ']') i++;
  while (i < src.length && src[i] !== ']') {
    if (src[i] === '[' && (src[i + 1] === ':' || src[i + 1] === '.' || src[i + 1] === '=')) {
      const close = src.indexOf(`${src[i + 1]}]`, i + 2);
      if (close >= 0) { i = close + 2; continue; }
    }
    i++;
  }
  return i + 1;
}

const BRE_CONTROL_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', a: '\x07' };
const BRE_SWAPPED_OPERATORS = new Set(['(', ')', '{', '}', '+', '?', '|']);

function breToEre(pattern: string): string {
  let out = '';
  let i = 0;
  let atStart = true;
  const n = pattern.length;
  let afterRepeat = false;
  while (i < n) {
    const c = pattern[i];
    const followsRepeat = afterRepeat;
    afterRepeat = false;
    if (c === '[') {
      const end = bracketEnd(pattern, i);
      out += pattern.slice(i, Math.min(end, n));
      i = end;
      atStart = false;
      continue;
    }
    if (c === '\\') {
      const next = pattern[i + 1];
      i += 2;
      if (next === undefined) { out += '\\'; continue; }
      if (next === '{' && followsRepeat) throw new PosixRegexError(MESSAGES.repeat);
      if (BRE_SWAPPED_OPERATORS.has(next)) {
        out += next;
        atStart = next === '(' || next === '|';
        continue;
      }
      if (next in BRE_CONTROL_ESCAPES) { out += BRE_CONTROL_ESCAPES[next]; atStart = false; continue; }
      out += `\\${next}`;
      atStart = false;
      continue;
    }
    if (BRE_SWAPPED_OPERATORS.has(c)) { out += `\\${c}`; i++; atStart = false; continue; }
    if (c === '*' && atStart) { out += '\\*'; i++; atStart = false; continue; }
    if (c === '*') {
      if (followsRepeat) throw new PosixRegexError(MESSAGES.repeat);
      out += c; i++; afterRepeat = true;
      continue;
    }
    if (c === '^') {
      if (atStart) { out += '^'; i++; continue; }
      out += '\\^'; i++; continue;
    }
    if (c === '$') {
      const rest = pattern.slice(i + 1);
      const anchored = rest === '' || rest.startsWith('\\)') || rest.startsWith('\\|');
      out += anchored ? '$' : '\\$';
      i++;
      continue;
    }
    out += c;
    i++;
    atStart = false;
  }
  return out;
}

/** Build the JS source string (without anchors/flags) for a POSIX pattern. */
export function posixToJsSource(pattern: string, opts: PosixRegexOptions): string {
  if (opts.fixed) return escapeLiteral(pattern);
  return ereToJsSource(opts.extended ? pattern : breToEre(pattern), opts.ignoreCase === true, !opts.extended || opts.rightParenIsError === true);
}

/**
 * Compile a POSIX pattern into a JS RegExp. Falls back to a literal match
 * if the translated source is not a valid JS regex, mirroring how grep
 * tolerates patterns the engine cannot honour rather than crashing.
 */
export function compilePosix(pattern: string, opts: PosixRegexOptions): RegExp {
  let body = posixToJsSource(pattern, opts);
  if (opts.wholeWord) body = `\\b(?:${body})\\b`;
  if (opts.wholeLine) body = `^(?:${body})$`;
  let flags = '';
  if (opts.global) flags += 'g';
  if (opts.ignoreCase) flags += 'i';
  if (!opts.fixed) flags += 'u';
  if (opts.multiline) flags += 'm';
  try {
    return new RegExp(body, flags);
  } catch {
    return new RegExp(escapeLiteral(pattern), flags);
  }
}
