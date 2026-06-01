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
 * JavaScript's RegExp engine is ERE-like, so ERE is mostly pass-through
 * (we still translate POSIX bracket classes like `[[:alpha:]]` and the
 * GNU word boundaries `\< \> \b`), while BRE requires swapping which
 * metacharacters are escaped. Bracket expressions `[...]` are scanned as
 * a unit so their contents are never mis-translated.
 */

export interface PosixRegexOptions {
  extended?: boolean;     // ERE when true, BRE when false
  fixed?: boolean;        // -F: treat the pattern as a literal string
  ignoreCase?: boolean;   // -i / I flag
  multiline?: boolean;    // ^/$ match line boundaries (m flag)
  global?: boolean;       // g flag
  wholeWord?: boolean;    // -w
  wholeLine?: boolean;    // -x
}

const POSIX_CLASSES: Record<string, string> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: 'A-Za-z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: '\\s',
  blank: ' \\t',
  punct: '!-/:-@\\[-`{-~',
  print: ' -~',
  graph: '!-~',
  cntrl: '\\x00-\\x1f\\x7f',
  xdigit: '0-9A-Fa-f',
};

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Consume a bracket expression starting at `[`, translating POSIX classes. */
function readBracket(src: string, start: number): { text: string; next: number } {
  let i = start + 1;
  let out = '[';
  if (src[i] === '^') { out += '^'; i++; }
  if (src[i] === ']') { out += '\\]'; i++; }
  while (i < src.length && src[i] !== ']') {
    if (src[i] === '[' && (src[i + 1] === ':' || src[i + 1] === '.' || src[i + 1] === '=')) {
      const kind = src[i + 1];
      const close = src.indexOf(kind + ']', i + 2);
      if (close >= 0) {
        const name = src.slice(i + 2, close);
        if (kind === ':') out += POSIX_CLASSES[name] ?? '';
        else out += escapeLiteral(name); // [.coll.] / [=equiv=] → literal chars
        i = close + 2;
        continue;
      }
    }
    if (src[i] === '\\') { out += '\\' + (src[i + 1] ?? ''); i += 2; continue; }
    out += src[i];
    i++;
  }
  out += ']';
  return { text: out, next: i + 1 };
}

function translateEre(pattern: string): string {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '[') {
      const b = readBracket(pattern, i);
      out += b.text;
      i = b.next;
      continue;
    }
    if (c === '\\') {
      const n = pattern[i + 1];
      if (n === '<' || n === '>') { out += '\\b'; i += 2; continue; }
      out += '\\' + (n ?? '');
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function translateBre(pattern: string): string {
  let out = '';
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i];
    if (c === '[') {
      const b = readBracket(pattern, i);
      out += b.text;
      i = b.next;
      continue;
    }
    if (c === '\\') {
      const nx = pattern[i + 1];
      switch (nx) {
        case '(': out += '('; break;
        case ')': out += ')'; break;
        case '{': out += '{'; break;
        case '}': out += '}'; break;
        case '+': out += '+'; break;
        case '?': out += '?'; break;
        case '|': out += '|'; break;
        case '<': case '>': out += '\\b'; break;
        case undefined: out += '\\\\'; break;
        default: out += '\\' + nx; break;
      }
      i += 2;
      continue;
    }
    // Bare ERE metacharacters are literal in BRE.
    if (c === '(' || c === ')' || c === '{' || c === '}' || c === '+' || c === '?' || c === '|') {
      out += '\\' + c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Build the JS source string (without anchors/flags) for a POSIX pattern. */
export function posixToJsSource(pattern: string, opts: PosixRegexOptions): string {
  if (opts.fixed) return escapeLiteral(pattern);
  return opts.extended ? translateEre(pattern) : translateBre(pattern);
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
  if (opts.multiline) flags += 'm';
  try {
    return new RegExp(body, flags);
  } catch {
    return new RegExp(escapeLiteral(pattern), flags);
  }
}
