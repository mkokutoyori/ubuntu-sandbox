export type AwkTokenType =
  | 'number' | 'string' | 'ere' | 'name' | 'funcname' | 'builtin'
  | 'op' | 'newline' | 'eof';

export interface AwkToken {
  type: AwkTokenType;
  value: string;
  pos: number;
}

export class AwkSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AwkSyntaxError';
  }
}

const KEYWORDS = new Set([
  'BEGIN', 'END', 'function', 'func', 'if', 'else', 'while', 'for', 'do',
  'break', 'continue', 'next', 'nextfile', 'exit', 'return', 'delete',
  'in', 'getline', 'print', 'printf',
]);

export const BUILTIN_FUNCS = new Set([
  'length', 'substr', 'index', 'split', 'sub', 'gsub', 'match', 'sprintf',
  'sin', 'cos', 'atan2', 'exp', 'log', 'sqrt', 'int', 'rand', 'srand',
  'tolower', 'toupper', 'system', 'close', 'fflush', 'gensub',
]);

const THREE = ['**='];
const TWO = [
  '+=', '-=', '*=', '/=', '%=', '^=', '==', '!=', '<=', '>=', '&&', '||',
  '++', '--', '!~', '>>', '**',
];
const ONE = new Set([
  '{', '}', '(', ')', '[', ']', ';', ',', '+', '-', '*', '/', '%', '^',
  '<', '>', '=', '!', '?', ':', '~', '$', '|', '&',
]);

export function tokenizeAwk(src: string): AwkToken[] {
  const toks: AwkToken[] = [];
  let i = 0;
  const n = src.length;

  const prevSignificant = (): AwkToken | undefined => toks[toks.length - 1];

  const regexAllowed = (): boolean => {
    const p = prevSignificant();
    if (!p) return true;
    if (p.type === 'number' || p.type === 'string' || p.type === 'name'
      || p.type === 'ere' || p.type === 'builtin') return false;
    if (p.type === 'op' && (p.value === ')' || p.value === ']' || p.value === '$'
      || p.value === '++' || p.value === '--')) return false;
    return true;
  };

  while (i < n) {
    const c = src[i];

    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '\n') { toks.push({ type: 'newline', value: '\n', pos: i }); i++; continue; }

    if (c === '"') {
      let j = i + 1;
      let val = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') { val += src[j] + (src[j + 1] ?? ''); j += 2; continue; }
        val += src[j];
        j++;
      }
      if (j >= n) throw new AwkSyntaxError('awk: unterminated string');
      toks.push({ type: 'string', value: val, pos: i });
      i = j + 1;
      continue;
    }

    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let val = '';
      let inBracket = false;
      while (j < n) {
        const cj = src[j];
        if (cj === '\\') { val += cj + (src[j + 1] ?? ''); j += 2; continue; }
        if (cj === '[') inBracket = true;
        else if (cj === ']') inBracket = false;
        else if (cj === '/' && !inBracket) break;
        else if (cj === '\n') throw new AwkSyntaxError('awk: newline in regex');
        val += cj;
        j++;
      }
      if (j >= n) throw new AwkSyntaxError('awk: unterminated regex');
      toks.push({ type: 'ere', value: val, pos: i });
      i = j + 1;
      continue;
    }

    if (c >= '0' && c <= '9' || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      if (src[j] === '0' && (src[j + 1] === 'x' || src[j + 1] === 'X')) {
        j += 2;
        while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
      } else {
        while (j < n && /[0-9]/.test(src[j])) j++;
        if (src[j] === '.') { j++; while (j < n && /[0-9]/.test(src[j])) j++; }
        if (src[j] === 'e' || src[j] === 'E') {
          let k = j + 1;
          if (src[k] === '+' || src[k] === '-') k++;
          if (/[0-9]/.test(src[k])) { j = k; while (j < n && /[0-9]/.test(src[j])) j++; }
        }
      }
      toks.push({ type: 'number', value: src.slice(i, j), pos: i });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      if (KEYWORDS.has(word)) {
        toks.push({ type: 'op', value: word === 'func' ? 'function' : word, pos: i });
      } else if (BUILTIN_FUNCS.has(word)) {
        toks.push({ type: 'builtin', value: word, pos: i });
      } else if (src[j] === '(') {
        toks.push({ type: 'funcname', value: word, pos: i });
      } else {
        toks.push({ type: 'name', value: word, pos: i });
      }
      i = j;
      continue;
    }

    let matched = false;
    for (const op of THREE) {
      if (src.startsWith(op, i)) { toks.push({ type: 'op', value: op, pos: i }); i += op.length; matched = true; break; }
    }
    if (matched) continue;
    for (const op of TWO) {
      if (src.startsWith(op, i)) { toks.push({ type: 'op', value: op, pos: i }); i += 2; matched = true; break; }
    }
    if (matched) continue;

    if (ONE.has(c)) { toks.push({ type: 'op', value: c, pos: i }); i++; continue; }

    throw new AwkSyntaxError(`awk: unexpected character '${c}'`);
  }

  toks.push({ type: 'eof', value: '', pos: n });
  return toks;
}
