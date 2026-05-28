export class StrNum {
  constructor(readonly raw: string) {}
}

export type Cell = number | string | StrNum;

export const UNINIT = new StrNum('');

const NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const HEX_RE = /^[+-]?0[xX][0-9a-fA-F]+$/;

export function looksNumeric(s: string): boolean {
  const t = s.trim();
  if (t === '') return false;
  return NUMERIC_RE.test(t) || HEX_RE.test(t)
    || t === 'inf' || t === '-inf' || t === '+inf' || t === 'nan';
}

export function parseNumberPrefix(s: string): number {
  const t = s.trim();
  if (HEX_RE.test(t)) return parseInt(t, 16);
  const m = t.match(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
  if (!m) return 0;
  const n = parseFloat(m[0]);
  return isNaN(n) ? 0 : n;
}

export function toNum(c: Cell): number {
  if (typeof c === 'number') return c;
  if (c instanceof StrNum) return parseNumberPrefix(c.raw);
  return parseNumberPrefix(c);
}

export function formatNumber(n: number, convfmt: string): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n);
  if (!isFinite(n)) return n > 0 ? 'inf' : (n < 0 ? '-inf' : 'nan');
  if (Number.isNaN(n)) return 'nan';
  return applyFormat(convfmt, [n]);
}

export function toStr(c: Cell, convfmt: string): string {
  if (typeof c === 'number') return formatNumber(c, convfmt);
  if (c instanceof StrNum) return c.raw;
  return c;
}

export function isNumericCell(c: Cell): boolean {
  if (typeof c === 'number') return true;
  if (c instanceof StrNum) return looksNumeric(c.raw);
  return false;
}

export function makeFieldCell(raw: string): Cell {
  return new StrNum(raw);
}

export function truthy(c: Cell): boolean {
  if (typeof c === 'number') return c !== 0;
  if (c instanceof StrNum) return looksNumeric(c.raw) ? parseNumberPrefix(c.raw) !== 0 : c.raw !== '';
  return c !== '';
}

export function compareCells(a: Cell, b: Cell, convfmt: string): number {
  if (isNumericCell(a) && isNumericCell(b)) {
    const x = toNum(a);
    const y = toNum(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const sa = toStr(a, convfmt);
  const sb = toStr(b, convfmt);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

interface FormatSpec {
  flags: string;
  width: number | null;
  precision: number | null;
  conv: string;
}

export function applyFormat(format: string, args: Cell[]): string {
  let out = '';
  let argi = 0;
  let i = 0;
  const next = (): Cell => (argi < args.length ? args[argi++] : UNINIT);

  while (i < format.length) {
    const ch = format[i];
    if (ch !== '%') {
      if (ch === '\\') {
        const esc = format[i + 1];
        out += decodeEscape(esc);
        i += 2;
        continue;
      }
      out += ch;
      i++;
      continue;
    }
    if (format[i + 1] === '%') { out += '%'; i += 2; continue; }

    const m = /^%([-+ 0#]*)(\*|\d+)?(?:\.(\*|\d+))?([diouxXeEfgGaAcs])/.exec(format.slice(i));
    if (!m) { out += ch; i++; continue; }

    const spec: FormatSpec = {
      flags: m[1],
      width: m[2] === '*' ? Math.trunc(toNum(next())) : (m[2] ? parseInt(m[2], 10) : null),
      precision: m[3] === '*' ? Math.trunc(toNum(next())) : (m[3] !== undefined ? parseInt(m[3] || '0', 10) : null),
      conv: m[4],
    };
    out += formatOne(spec, next());
    i += m[0].length;
  }
  return out;
}

function decodeEscape(esc: string): string {
  switch (esc) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case '\\': return '\\';
    case 'a': return '\x07';
    case 'b': return '\b';
    case 'f': return '\f';
    case 'v': return '\v';
    default: return '\\' + (esc ?? '');
  }
}

function formatOne(spec: FormatSpec, value: Cell): string {
  const { flags, width, precision, conv } = spec;
  let body: string;

  if (conv === 's') {
    body = toStr(value, '%.6g');
    if (precision !== null) body = body.slice(0, precision);
    return pad(body, width, flags, false);
  }
  if (conv === 'c') {
    if (typeof value === 'number') body = String.fromCharCode(Math.trunc(value) & 0xff);
    else { const s = toStr(value, '%.6g'); body = s.length ? s[0] : ''; }
    return pad(body, width, flags, false);
  }

  const n = toNum(value);
  switch (conv) {
    case 'd': case 'i': body = formatInt(Math.trunc(n), 10, false, precision); break;
    case 'o': body = formatInt(Math.trunc(n), 8, false, precision); break;
    case 'u': body = formatInt(Math.trunc(n) >>> 0, 10, false, precision); break;
    case 'x': body = formatInt(Math.trunc(n) >>> 0, 16, false, precision); break;
    case 'X': body = formatInt(Math.trunc(n) >>> 0, 16, true, precision); break;
    case 'e': case 'E': body = applyExp(n, precision ?? 6, conv === 'E'); break;
    case 'f': body = n.toFixed(precision ?? 6); break;
    case 'g': case 'G': body = applyGeneral(n, precision ?? 6, conv === 'G'); break;
    case 'a': case 'A': body = n.toString(); break;
    default: body = String(n);
  }

  if ((conv !== 's' && conv !== 'c')) {
    if (n >= 0) {
      if (flags.includes('+')) body = '+' + body;
      else if (flags.includes(' ')) body = ' ' + body;
    }
  }
  return pad(body, width, flags, true);
}

function formatInt(n: number, radix: number, upper: boolean, precision: number | null): string {
  const neg = n < 0;
  let s = Math.abs(n).toString(radix);
  if (upper) s = s.toUpperCase();
  if (precision !== null) s = s.padStart(precision, '0');
  return neg ? '-' + s : s;
}

function applyExp(n: number, precision: number, upper: boolean): string {
  let s = n.toExponential(precision);
  s = s.replace(/e([+-])(\d)$/, 'e$10$2');
  return upper ? s.toUpperCase() : s;
}

function applyGeneral(n: number, precision: number, upper: boolean): string {
  const p = precision === 0 ? 1 : precision;
  let s = n.toPrecision(p);
  if (s.indexOf('.') >= 0 && s.indexOf('e') < 0) s = s.replace(/\.?0+$/, '');
  else if (s.indexOf('e') >= 0) {
    s = s.replace(/\.?0+e/, 'e').replace(/e([+-])(\d)$/, 'e$10$2');
  }
  return upper ? s.toUpperCase() : s;
}

function pad(body: string, width: number | null, flags: string, numeric: boolean): string {
  if (width === null) return body;
  const w = Math.abs(width);
  const left = flags.includes('-') || width < 0;
  if (body.length >= w) return body;
  if (left) return body + ' '.repeat(w - body.length);
  if (numeric && flags.includes('0')) {
    const sign = /^[+\- ]/.test(body) ? body[0] : '';
    const rest = sign ? body.slice(1) : body;
    return sign + '0'.repeat(w - body.length) + rest;
  }
  return ' '.repeat(w - body.length) + body;
}
