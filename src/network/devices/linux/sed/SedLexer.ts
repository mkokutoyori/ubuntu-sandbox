import { SedToken, RawAddress, SedSyntaxError } from './SedAst';

const SIMPLE_OPS = new Set(['p', 'P', 'd', 'D', 'n', 'N', 'g', 'G', 'h', 'H', 'x', '=', 'z', 'l', 'F']);
const TEXT_CMDS = new Set(['a', 'i', 'c']);
const FILE_CMDS = new Set(['r', 'w', 'R', 'W']);
const LABEL_CMDS = new Set(['b', 't', 'T']);

/**
 * Tokenize a sed script. The scan is context-sensitive: after a command
 * letter the remainder of that command's payload (regex/replacement for
 * `s`, transliteration sets for `y`, free text for `a`/`i`/`c`, labels and
 * filenames) is consumed according to the command, because sed payloads
 * are delimiter- and line-oriented rather than freely tokenizable.
 */
export function tokenizeSed(src: string): SedToken[] {
  const toks: SedToken[] = [];
  let i = 0;
  const n = src.length;

  const isBlank = (c: string) => c === ' ' || c === '\t';

  const readNumber = (): number => {
    let s = '';
    while (i < n && src[i] >= '0' && src[i] <= '9') { s += src[i]; i++; }
    return parseInt(s, 10);
  };

  // Read a /regex/ or \cregexc address; returns {src, flags}. Assumes the
  // opening delimiter is at `i`.
  const readRegexAddr = (): { src: string; flags: string } => {
    let delim = src[i];
    if (delim === '\\') { i++; delim = src[i]; }
    i++; // past opening delimiter
    let body = '';
    while (i < n && src[i] !== delim) {
      if (src[i] === '\\') {
        // \delim is a literal delimiter inside the regex; \n etc pass through
        if (src[i + 1] === delim) { body += delim; i += 2; continue; }
        body += src[i] + (src[i + 1] ?? '');
        i += 2;
        continue;
      }
      if (src[i] === '\n') throw new SedSyntaxError('unterminated address regex');
      body += src[i];
      i++;
    }
    if (i >= n) throw new SedSyntaxError('unterminated address regex');
    i++; // past closing delimiter
    let flags = '';
    while (i < n && (src[i] === 'I' || src[i] === 'M')) { flags += src[i]; i++; }
    return { src: body, flags };
  };

  const tryAddress = (): RawAddress | null => {
    const c = src[i];
    if (c >= '0' && c <= '9') {
      const num = readNumber();
      if (src[i] === '~') { i++; const step = readNumber(); return { kind: 'step', first: num, step }; }
      return { kind: 'line', line: num };
    }
    if (c === '$') { i++; return { kind: 'last' }; }
    if (c === '/' || (c === '\\' && src[i + 1] !== undefined)) {
      const { src: body, flags } = readRegexAddr();
      return { kind: 'regex', src: body, flags };
    }
    if (c === '+' && src[i + 1] >= '0' && src[i + 1] <= '9') { i++; return { kind: 'plus', n: readNumber() }; }
    if (c === '~' && src[i + 1] >= '0' && src[i + 1] <= '9') { i++; return { kind: 'tilde', n: readNumber() }; }
    return null;
  };

  // Read a payload delimited by `delim` (for s/y), honouring backslash
  // escapes. Returns the field and leaves `i` just past the closing delim.
  const readDelimited = (delim: string): string => {
    let out = '';
    while (i < n && src[i] !== delim) {
      if (src[i] === '\\') {
        if (src[i + 1] === delim) { out += delim; i += 2; continue; }
        if (src[i + 1] === '\n') { out += '\n'; i += 2; continue; }
        out += src[i] + (src[i + 1] ?? '');
        i += 2;
        continue;
      }
      out += src[i];
      i++;
    }
    return out;
  };

  const readToLineEnd = (): string => {
    let out = '';
    while (i < n && src[i] !== '\n' && src[i] !== ';' && src[i] !== '}') { out += src[i]; i++; }
    return out.trim();
  };

  const readRestOfLine = (): string => {
    let out = '';
    while (i < n && src[i] !== '\n') {
      if (src[i] === '\\' && src[i + 1] === '\n') { out += '\n'; i += 2; continue; }
      out += src[i];
      i++;
    }
    return out;
  };

  // a/i/c text: GNU one-line `a text` or classic `a\<newline>text`.
  const readText = (): string => {
    while (i < n && isBlank(src[i])) i++;
    if (src[i] === '\\') {
      i++;
      if (src[i] === '\n') i++;
      else while (i < n && isBlank(src[i])) i++;
    }
    return readRestOfLine();
  };

  const readCommand = (letter: string): SedToken => {
    if (letter === 's') {
      const delim = src[i]; i++;
      const pattern = readDelimited(delim); i++;
      const replacement = readDelimited(delim); i++;
      let flags = '';
      while (i < n && /[gpiImMew0-9]/.test(src[i])) { flags += src[i]; i++; }
      return { type: 'sub', sub: { delim, pattern, replacement, flags } };
    }
    if (letter === 'y') {
      const delim = src[i]; i++;
      const from = readDelimited(delim); i++;
      const to = readDelimited(delim); i++;
      return { type: 'y', y: { from, to } };
    }
    if (TEXT_CMDS.has(letter)) return { type: 'text', name: letter, text: readText() };
    if (FILE_CMDS.has(letter)) { while (i < n && isBlank(src[i])) i++; return { type: 'text', name: letter, text: readRestOfLine() }; }
    if (LABEL_CMDS.has(letter)) { while (i < n && isBlank(src[i])) i++; return { type: 'text', name: letter, text: readToLineEnd() }; }
    if (letter === ':') { return { type: 'text', name: ':', text: readToLineEnd() }; }
    if (letter === 'q' || letter === 'Q') {
      while (i < n && isBlank(src[i])) i++;
      let code = 0;
      if (src[i] >= '0' && src[i] <= '9') code = readNumber();
      return { type: 'quit', name: letter, code };
    }
    if (SIMPLE_OPS.has(letter)) {
      if (letter === 'l') { while (i < n && isBlank(src[i])) i++; while (src[i] >= '0' && src[i] <= '9') i++; }
      return { type: 'op', name: letter };
    }
    throw new SedSyntaxError(`unknown command: \`${letter}'`);
  };

  while (i < n) {
    const c = src[i];
    if (c === '\n' || c === ';') { toks.push({ type: 'sep' }); i++; continue; }
    if (isBlank(c)) { i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '{') { toks.push({ type: 'lbrace' }); i++; continue; }
    if (c === '}') { toks.push({ type: 'rbrace' }); i++; continue; }
    if (c === ',') { toks.push({ type: 'comma' }); i++; continue; }
    if (c === '!') { toks.push({ type: 'bang' }); i++; continue; }

    const addr = tryAddress();
    if (addr) { toks.push({ type: 'addr', addr }); continue; }

    // Command letter.
    const letter = src[i]; i++;
    toks.push(readCommand(letter));
  }

  toks.push({ type: 'eof' });
  return toks;
}
