import { SedToken, SedTokenBody, RawAddress, SedSyntaxError } from './SedAst';

const SIMPLE_OPS = new Set(['p', 'P', 'd', 'D', 'n', 'N', 'g', 'G', 'h', 'H', 'x', '=', 'z', 'F']);
const TEXT_CMDS = new Set(['a', 'i', 'c']);
const FILE_CMDS = new Set(['r', 'w', 'R', 'W']);
const LABEL_CMDS = new Set(['b', 't', 'T']);

const SANDBOX_REFUSAL = 'e/r/w commands disabled in sandbox mode';
const MISSING_FILENAME = 'missing filename in r/R/w/W commands';

export interface SedLexOptions {
  sandbox?: boolean;
}

export function tokenizeSed(src: string, options: SedLexOptions = {}): SedToken[] {
  const toks: SedToken[] = [];
  let i = 0;
  const n = src.length;
  let addressCount = 0;
  let start = 0;

  const isBlank = (c: string) => c === ' ' || c === '\t';
  const fail = (message: string, position = Math.min(i, n)): never => {
    throw new SedSyntaxError(message, position);
  };
  const push = (body: SedTokenBody) => { toks.push({ ...body, pos: Math.min(i, n), start } as SedToken); };

  const skipBlanks = () => { while (i < n && isBlank(src[i])) i++; };

  const readNumber = (): number => {
    let s = '';
    while (i < n && src[i] >= '0' && src[i] <= '9') { s += src[i]; i++; }
    return parseInt(s, 10);
  };

  const readBracket = (): string => {
    let out = src[i]; i++;
    if (src[i] === '^') { out += '^'; i++; }
    if (src[i] === ']') { out += ']'; i++; }
    while (i < n && src[i] !== ']') {
      if (src[i] === '[' && (src[i + 1] === ':' || src[i + 1] === '.' || src[i + 1] === '=')) {
        const close = src.indexOf(`${src[i + 1]}]`, i + 2);
        if (close >= 0) { out += src.slice(i, close + 2); i = close + 2; continue; }
      }
      out += src[i];
      i++;
    }
    if (i >= n) return out;
    out += ']'; i++;
    return out;
  };

  const readRegexBody = (delim: string, unterminated: string, newlineEnds: boolean): string => {
    let body = '';
    while (i < n && src[i] !== delim) {
      if (src[i] === '\\') {
        if (i + 1 >= n) { i = n; break; }
        if (src[i + 1] === delim) { body += delim; i += 2; continue; }
        if (src[i + 1] === '\n') { body += '\n'; i += 2; continue; }
        body += src[i] + src[i + 1];
        i += 2;
        continue;
      }
      if (src[i] === '[') {
        body += readBracket();
        continue;
      }
      if (src[i] === '\n' && newlineEnds) fail(unterminated);
      body += src[i];
      i++;
    }
    if (i >= n) fail(unterminated, n);
    i++;
    return body;
  };

  const readRegexAddr = (): { src: string; flags: string } => {
    let delim = src[i];
    if (delim === '\\') { i++; delim = src[i]; }
    i++;
    const body = readRegexBody(delim, 'unterminated address regex', true);
    let flags = '';
    while (i < n && (src[i] === 'I' || src[i] === 'M')) { flags += src[i]; i++; }
    return { src: body, flags };
  };

  const tryAddress = (): RawAddress | null => {
    const c = src[i];
    if (c >= '0' && c <= '9') {
      const num = readNumber();
      if (src[i] === '~') { i++; const step = readNumber(); return { kind: 'step', first: num, step: Number.isNaN(step) ? 0 : step }; }
      return { kind: 'line', line: num };
    }
    if (c === '$') { i++; return { kind: 'last' }; }
    if (c === '/' || (c === '\\' && src[i + 1] !== undefined)) {
      const { src: body, flags } = readRegexAddr();
      return { kind: 'regex', src: body, flags };
    }
    if (c === '+' || c === '~') { i++; const amount = readNumber(); return { kind: c === '+' ? 'plus' : 'tilde', n: Number.isNaN(amount) ? 0 : amount }; }
    return null;
  };

  const readDelimited = (delim: string, unterminated: string): string => {
    let out = '';
    while (i < n && src[i] !== delim) {
      if (src[i] === '\\') {
        if (i + 1 >= n) { i = n; break; }
        if (src[i + 1] === delim) { out += delim === '&' || delim === '\n' ? `\\${delim}` : delim; i += 2; continue; }
        if (src[i + 1] === '\n') { out += '\n'; i += 2; continue; }
        out += src[i] + src[i + 1];
        i += 2;
        continue;
      }
      if (src[i] === '\n') fail(unterminated);
      out += src[i];
      i++;
    }
    if (i >= n) fail(unterminated, n);
    i++;
    return out;
  };

  const endOfCommand = () => {
    skipBlanks();
    if (i >= n) return;
    const c = src[i];
    if (c === '}' || c === '#' || c === '\n' || c === ';') return;
    i++;
    fail('extra characters after command');
  };

  const readFileName = (): string => {
    skipBlanks();
    let out = '';
    while (i < n && src[i] !== '\n') { out += src[i]; i++; }
    if (out === '') fail(MISSING_FILENAME);
    return out;
  };

  const readLabel = (closers: string): string => {
    skipBlanks();
    let out = '';
    while (i < n && !isBlank(src[i]) && src[i] !== '\n' && src[i] !== ';' && !closers.includes(src[i])) { out += src[i]; i++; }
    return out;
  };

  const readText = (): string | null => {
    skipBlanks();
    if (i >= n) fail('expected \\ after `a\', `c\' or `i\'');
    if (src[i] === '\\') {
      i++;
      if (i >= n) return null;
      if (src[i] === '\n') i++;
      else { const save = i; skipBlanks(); if (src[i] === '\n') i++; else i = save; }
    }
    let out = '';
    while (i < n && src[i] !== '\n') {
      if (src[i] === '\\') {
        const next = src[i + 1];
        if (next === undefined) { i++; break; }
        if (next === '\n') { out += '\n'; i += 2; continue; }
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next === 'f' ? '\f' : next === 'v' ? '\v' : next === 'a' ? '\u0007' : next;
        i += 2;
        continue;
      }
      out += src[i];
      i++;
    }
    return out;
  };

  const readSubstitute = (): SedTokenBody => {
    if (i >= n || src[i] === '\n' || src[i] === '\\') { i = Math.min(i + 1, n); fail("unterminated `s' command"); }
    const delim = src[i]; i++;
    const pattern = readRegexBody(delim, "unterminated `s' command", false);
    const replacement = readSubstituteReplacement(delim);
    let flags = '';
    let seenG = false;
    let seenP = false;
    let seenNumber = false;
    let writeFile: string | undefined;
    for (;;) {
      if (i >= n) break;
      const c = src[i];
      if (c === 'g') { i++; if (seenG) fail("multiple `g' options to `s' command"); seenG = true; flags += c; continue; }
      if (c === 'p') { i++; if (seenP) fail("multiple `p' options to `s' command"); seenP = true; flags += c; continue; }
      if (c === 'e') { i++; if (options.sandbox) fail(SANDBOX_REFUSAL); fail("unknown option to `s'"); }
      if (c === 'i' || c === 'I' || c === 'm' || c === 'M') { i++; flags += c; continue; }
      if (c >= '0' && c <= '9') {
        i++;
        if (seenNumber) fail("multiple number options to `s' command");
        i--;
        const value = readNumber();
        if (value === 0) fail("number option to `s' command may not be zero");
        seenNumber = true;
        flags += String(value);
        continue;
      }
      if (c === 'w') { i++; if (options.sandbox) fail(SANDBOX_REFUSAL); writeFile = readFileName(); break; }
      if (c === '}' || c === '#') break;
      if (c === '\n' || c === ';') break;
      if (isBlank(c)) { i++; continue; }
      i++;
      fail("unknown option to `s'");
    }
    return { type: 'sub', sub: { delim, pattern, replacement, flags, writeFile } };
  };

  const readSubstituteReplacement = (delim: string): string => {
    let out = '';
    while (i < n && src[i] !== delim) {
      if (src[i] === '\\') {
        if (i + 1 >= n) { i = n; break; }
        if (src[i + 1] === delim && delim !== '&') { out += delim; i += 2; continue; }
        if (src[i + 1] === '\n') { out += '\n'; i += 2; continue; }
        out += src[i] + src[i + 1];
        i += 2;
        continue;
      }
      if (src[i] === '\n') fail("unterminated `s' command");
      out += src[i];
      i++;
    }
    if (i >= n) fail("unterminated `s' command", n);
    i++;
    return out;
  };

  const readCommand = (letter: string): SedTokenBody => {
    if (options.sandbox && (FILE_CMDS.has(letter) || letter === 'e')) fail(SANDBOX_REFUSAL);
    if (letter === 's') return readSubstitute();
    if (letter === 'y') {
      if (i >= n || src[i] === '\n' || src[i] === '\\') { i = Math.min(i + 1, n); fail("unterminated `y' command"); }
      const delim = src[i]; i++;
      const from = readDelimited(delim, "unterminated `y' command");
      const to = readDelimited(delim, "unterminated `y' command");
      endOfCommand();
      return { type: 'y', y: { from, to } };
    }
    if (TEXT_CMDS.has(letter)) {
      const text = readText();
      return text === null ? { type: 'text', name: letter, text: '', textless: true } : { type: 'text', name: letter, text };
    }
    if (FILE_CMDS.has(letter)) return { type: 'text', name: letter, text: readFileName() };
    if (LABEL_CMDS.has(letter)) return { type: 'text', name: letter, text: readLabel('}') };
    if (letter === ':') {
      const label = readLabel('');
      if (label === '') fail('":" lacks a label');
      return { type: 'text', name: ':', text: label };
    }
    if (letter === 'q' || letter === 'Q') {
      skipBlanks();
      let code = 0;
      if (src[i] >= '0' && src[i] <= '9') code = readNumber();
      endOfCommand();
      return { type: 'quit', name: letter, code };
    }
    if (letter === 'l') {
      skipBlanks();
      let width: number | undefined;
      if (src[i] >= '0' && src[i] <= '9') width = readNumber();
      endOfCommand();
      return { type: 'op', name: 'l', width };
    }
    if (letter === 'v') {
      skipBlanks();
      let version = '';
      while (i < n && src[i] !== '\n' && src[i] !== ';' && src[i] !== '}' && !isBlank(src[i])) { version += src[i]; i++; }
      if (version !== '' && !versionAtMost(version, '4.8')) fail('expected newer version of sed');
      endOfCommand();
      return { type: 'op', name: 'v' };
    }
    if (SIMPLE_OPS.has(letter)) {
      endOfCommand();
      return { type: 'op', name: letter };
    }
    return fail(`unknown command: \`${letter}'`);
  };

  while (i < n) {
    const c = src[i];
    start = i;
    if (c === '\n' || c === ';') { i++; push({ type: 'sep', char: c }); addressCount = 0; continue; }
    if (isBlank(c)) { i++; continue; }
    if (c === '#') {
      if (addressCount > 0) { i++; fail("comments don't accept any addresses"); }
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '{') { i++; push({ type: 'lbrace' }); addressCount = 0; continue; }
    if (c === '}') {
      i++;
      push({ type: 'rbrace' });
      endOfCommand();
      addressCount = 0;
      continue;
    }
    if (c === ',') {
      i++;
      push({ type: 'comma' });
      skipBlanks();
      continue;
    }
    if (c === '!') {
      i++;
      push({ type: 'bang' });
      skipBlanks();
      if (i < n && src[i] === '!') { i++; fail("multiple `!'s"); }
      continue;
    }

    const before = i;
    const addr = tryAddress();
    if (addr) { addressCount++; push({ type: 'addr', addr }); skipBlanks(); continue; }
    i = before;

    const letter = src[i]; i++;
    const body = readCommand(letter);
    push(body);
    addressCount = 0;
  }

  start = n;
  push({ type: 'eof' });
  return toks;
}

function versionAtMost(requested: string, current: string): boolean {
  const a = requested.split('.').map((part) => parseInt(part, 10) || 0);
  const b = current.split('.').map((part) => parseInt(part, 10) || 0);
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    if (x !== y) return x < y;
  }
  return true;
}
