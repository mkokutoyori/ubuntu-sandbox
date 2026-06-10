export type PlsqlTokenType = 'number' | 'string' | 'ident' | 'op' | 'eof';

export interface PlsqlToken {
  type: PlsqlTokenType;
  value: string;
  upper: string;
  pos: number;
  line: number;
}

const MULTI_OPS = [':=', '..', '||', '<>', '!=', '<=', '>=', '=>', '**', '<<', '>>'];
const SINGLE_OPS = new Set(['+', '-', '*', '/', '=', '<', '>', '(', ')', ',', ';', '.', '%', '@', ':']);

export class PlsqlLexParseError extends Error {
  readonly line: number;

  constructor(message: string, line = 0) {
    super(message);
    this.name = 'PlsqlLexParseError';
    this.line = line;
  }
}

export function tokenizePlsql(source: string): PlsqlToken[] {
  const tokens: PlsqlToken[] = [];
  let i = 0;
  let line = 1;
  const n = source.length;

  const push = (type: PlsqlTokenType, value: string, pos: number) => {
    tokens.push({ type, value, upper: value.toUpperCase(), pos, line });
  };

  while (i < n) {
    const c = source[i];

    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') { i++; continue; }

    if (c === '-' && source[i + 1] === '-') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }

    if ((c === 'q' || c === 'Q') && source[i + 1] === "'") {
      const open = source[i + 2];
      const closeMap: Record<string, string> = { '[': ']', '(': ')', '{': '}', '<': '>' };
      const close = closeMap[open] ?? open;
      let j = i + 3;
      let val = '';
      while (j < n && !(source[j] === close && source[j + 1] === "'")) {
        if (source[j] === '\n') line++;
        val += source[j];
        j++;
      }
      push('string', val, i);
      i = j + 2;
      continue;
    }

    if (c === "'") {
      let j = i + 1;
      let val = '';
      while (j < n) {
        if (source[j] === "'") {
          if (source[j + 1] === "'") { val += "'"; j += 2; continue; }
          break;
        }
        if (source[j] === '\n') line++;
        val += source[j];
        j++;
      }
      if (j >= n) throw new PlsqlLexParseError('PLS-00103: unterminated string literal');
      push('string', val, i);
      i = j + 1;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let val = '';
      while (j < n && source[j] !== '"') { val += source[j]; j++; }
      if (j >= n) throw new PlsqlLexParseError('PLS-00103: unterminated quoted identifier');
      tokens.push({ type: 'ident', value: val, upper: val, pos: i, line });
      i = j + 1;
      continue;
    }

    if (c >= '0' && c <= '9') {
      let j = i;
      let val = '';
      while (j < n && source[j] >= '0' && source[j] <= '9') { val += source[j]; j++; }
      if (source[j] === '.' && source[j + 1] !== '.') {
        val += '.'; j++;
        while (j < n && source[j] >= '0' && source[j] <= '9') { val += source[j]; j++; }
      }
      if (source[j] === 'e' || source[j] === 'E') {
        let k = j + 1;
        let exp = source[j];
        if (source[k] === '+' || source[k] === '-') { exp += source[k]; k++; }
        if (source[k] >= '0' && source[k] <= '9') {
          while (k < n && source[k] >= '0' && source[k] <= '9') { exp += source[k]; k++; }
          val += exp; j = k;
        }
      }
      push('number', val, i);
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      let val = '';
      while (j < n && /[A-Za-z0-9_$#]/.test(source[j])) { val += source[j]; j++; }
      push('ident', val, i);
      i = j;
      continue;
    }

    let matched = false;
    for (const op of MULTI_OPS) {
      if (source.startsWith(op, i)) {
        push('op', op, i);
        i += op.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    if (SINGLE_OPS.has(c)) {
      push('op', c, i);
      i++;
      continue;
    }

    throw new PlsqlLexParseError(`PLS-00103: unexpected character '${c}'`);
  }

  tokens.push({ type: 'eof', value: '', upper: '', pos: n, line });
  return tokens;
}
