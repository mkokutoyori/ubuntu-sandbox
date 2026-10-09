export const PRINT_CHAR_THRESHOLD = 300;
export const PRINT_LINE_THRESHOLD = 3;
export const JSON_THRESHOLD = 4096;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8');

export const utf8 = (text: string): Uint8Array => encoder.encode(text);
export const text = (bytes: Uint8Array): string => decoder.decode(bytes);

export function concat(...parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function startsWithBytes(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

function expectedLength(first: number): number {
  if ((first & 0x80) === 0) return 1;
  if ((first & 0xe0) === 0xc0) return 2;
  if ((first & 0xf0) === 0xe0) return 3;
  if ((first & 0xf8) === 0xf0) return 4;
  if ((first & 0xfc) === 0xf8) return 5;
  if ((first & 0xfe) === 0xfc) return 6;
  return 0;
}

function unicharIsValid(ch: number): boolean {
  if (ch >= 0x110000) return false;
  if ((ch & 0xfffff800) === 0xd800) return false;
  if (ch >= 0xfdd0 && ch <= 0xfdef) return false;
  if ((ch & 0xfffe) === 0xfffe) return false;
  return true;
}

function decodeChar(bytes: Uint8Array, at: number, available: number): { value: number; length: number } | null {
  const first = bytes[at];
  const length = expectedLength(first);
  if (length === 0 || length > available) return null;
  if (length === 1) return { value: first, length: 1 };
  let value = first & (0xff >> (length + 1));
  for (let i = 1; i < length; i++) {
    if ((bytes[at + i] & 0xc0) !== 0x80) return null;
    value = value * 64 + (bytes[at + i] & 0x3f);
  }
  const minimum = [0, 0, 0x80, 0x800, 0x10000, 0x200000, 0x4000000][length];
  if (value < minimum) return null;
  if (!unicharIsValid(value)) return null;
  return { value, length };
}

export function isPrintableUtf8(bytes: Uint8Array, allowNewline = true): boolean {
  for (let at = 0; at < bytes.length;) {
    const decoded = decodeChar(bytes, at, bytes.length - at);
    if (decoded === null) return false;
    const ch = decoded.value;
    if ((ch < 0x20 && ch !== 9 && ch !== 10) || (ch >= 0x7f && ch <= 0x9f) || (!allowNewline && ch === 10)) return false;
    at += decoded.length;
  }
  return true;
}

export function stripTabAnsi(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let state: 'other' | 'escape' | 'csi' | 'cso' = 'other';
  let begin = 0;
  let carriageReturns = 0;
  const size = input.length;
  for (let i = 0; i < size + 1; i++) {
    const c = i < size ? input[i] : -1;
    switch (state) {
      case 'other':
        if (i >= size) break;
        if (c === 0x0d) {
          carriageReturns++;
          break;
        } else if (c === 0x0a) carriageReturns = 0;
        for (; carriageReturns > 0; carriageReturns--) out.push(0x0d);
        if (c === 0x1b) state = 'escape';
        else if (c === 0x09) out.push(...utf8('        '));
        else out.push(c);
        break;
      case 'escape':
        if (i >= size) {
          out.push(0x1b);
          break;
        } else if (c === 0x5b) {
          state = 'csi';
          begin = i + 1;
        } else if (c === 0x5d) {
          state = 'cso';
          begin = i + 1;
        } else {
          out.push(0x1b, c);
          state = 'other';
        }
        break;
      case 'csi':
        if (i >= size || !'01234567890;m'.includes(String.fromCharCode(c))) {
          out.push(0x1b, 0x5b);
          state = 'other';
          i = begin - 1;
        } else if (c === 0x6d) state = 'other';
        break;
      case 'cso':
        if (i >= size || (c !== 0x07 && c < 32) || c > 126) {
          out.push(0x1b, 0x5d);
          state = 'other';
          i = begin - 1;
        } else if (c === 0x07) state = 'other';
        break;
    }
  }
  return Uint8Array.from(out);
}

export function formatBytes(size: number): string {
  const table: ReadonlyArray<readonly [string, number]> = [
    ['E', 1024 ** 6], ['P', 1024 ** 5], ['T', 1024 ** 4], ['G', 1024 ** 3], ['M', 1024 ** 2], ['K', 1024],
  ];
  for (let i = 0; i < table.length; i++) {
    const [suffix, factor] = table[i];
    if (size >= factor) {
      const below = i !== table.length - 1
        ? Math.floor(Math.floor(size / table[i + 1][1]) * 10 / table[table.length - 1][1]) % 10
        : Math.floor(size * 10 / factor) % 10;
      return `${Math.floor(size / factor)}.${below}${suffix}`;
    }
  }
  return `${size}B`;
}

function ansiSequenceLength(s: Uint8Array, at: number, end: number): number {
  const len = end - at;
  if (len < 2) return 0;
  if (s[at] !== 0x1b) return 0;
  if (s[at + 1] === 0x5b) {
    let i = 2;
    if (i === len) return 0;
    while (s[at + i] >= 0x30 && s[at + i] <= 0x3f) if (++i === len) return 0;
    while (s[at + i] >= 0x20 && s[at + i] <= 0x2f) if (++i === len) return 0;
    if (s[at + i] >= 0x40 && s[at + i] <= 0x7e) return i + 1;
    return 0;
  } else if (s[at + 1] >= 0x40 && s[at + 1] <= 0x5f) return 2;
  return 0;
}

function hasAnsiSequence(s: Uint8Array): boolean {
  for (let i = 0; i < s.length; i++) if (s[i] === 0x1b && ansiSequenceLength(s, i, s.length) > 0) return true;
  return false;
}

function previousAnsiSequence(s: Uint8Array, length: number): { where: number; length: number } | null {
  for (let i = length - 2; i > 0; i--) {
    const slen = ansiSequenceLength(s, i - 1, length);
    if (slen > 0) return { where: i - 1, length: slen };
  }
  return null;
}

function isWide(ch: number): boolean {
  return (ch >= 0x1100 && ch <= 0x115f) || (ch >= 0x2e80 && ch <= 0x303e) || (ch >= 0x3041 && ch <= 0x33ff) || (ch >= 0x3400 && ch <= 0x4dbf)
    || (ch >= 0x4e00 && ch <= 0x9fff) || (ch >= 0xa000 && ch <= 0xa4cf) || (ch >= 0xac00 && ch <= 0xd7a3) || (ch >= 0xf900 && ch <= 0xfaff)
    || (ch >= 0xfe30 && ch <= 0xfe6f) || (ch >= 0xff00 && ch <= 0xff60) || (ch >= 0xffe0 && ch <= 0xffe6) || (ch >= 0x1f300 && ch <= 0x1f64f)
    || (ch >= 0x1f900 && ch <= 0x1f9ff) || (ch >= 0x20000 && ch <= 0x3fffd);
}

function decodeAt(s: Uint8Array, at: number): { value: number; length: number } | null {
  const first = s[at];
  const length = expectedLength(first);
  if (length === 0) return null;
  if (length === 1) return { value: first >= 0x80 ? first - 256 : first, length: 1 };
  let value = first & (0xff >> (length + 1));
  for (let i = 1; i < length; i++) {
    if (at + i >= s.length || (s[at + i] & 0xc0) !== 0x80) return null;
    value = value * 64 + (s[at + i] & 0x3f);
  }
  return { value, length };
}

function previousCharStart(s: Uint8Array, at: number): number {
  let p = at - 1;
  while (p > 0 && (s[p] & 0xc0) === 0x80) p--;
  return p;
}

const ELLIPSIS = Uint8Array.from([0xe2, 0x80, 0xa6]);

export function ellipsizeMem(s: Uint8Array, newLength: number, percent: number, utf8Locale: boolean): Uint8Array | null {
  const oldLength = s.length;
  if (newLength === 0) return new Uint8Array(0);
  const hasAnsi = hasAnsiSequence(s);
  const ascii = !s.some(b => b >= 0x80 || b === 0);
  if (!hasAnsi && ascii) return asciiEllipsize(s, newLength, percent, utf8Locale);
  const x = Math.floor((newLength - 1) * percent / 100);
  let k = 0;
  let i = 0;
  while (i < oldLength) {
    const slen = hasAnsi ? ansiSequenceLength(s, i, oldLength) : 0;
    if (slen > 0) {
      i += slen;
      continue;
    }
    const decoded = decodeAt(s, i);
    if (decoded === null) return null;
    const w = isWide(decoded.value) ? 2 : 1;
    if (k + w > x) break;
    k += w;
    i += decoded.length;
  }
  let j = oldLength;
  let ansiStart = oldLength;
  let ansiLen = 0;
  for (let t = oldLength; t > i && k < newLength;) {
    if (hasAnsi && ansiStart >= t) {
      const previous = previousAnsiSequence(s, t);
      if (previous === null) {
        ansiStart = -1;
        ansiLen = 0;
      } else {
        ansiStart = previous.where;
        ansiLen = previous.length;
      }
    }
    if (hasAnsi && ansiLen > 0 && ansiStart + ansiLen === t) {
      t = ansiStart;
      continue;
    }
    const tt = previousCharStart(s, t);
    const decoded = decodeAt(s, tt);
    if (decoded === null) return null;
    const w = isWide(decoded.value) ? 2 : 1;
    if (k + w > newLength) break;
    k += w;
    j = t = tt;
  }
  if (i >= j) return s.slice();
  if (k >= newLength) {
    if (j < oldLength) j += expectedLength(s[j]) || 1;
    else if (i > 0) i = previousCharStart(s, i);
  }
  const head = s.slice(0, i);
  const parts: Uint8Array[] = [head, ELLIPSIS];
  if (hasAnsi) {
    for (let p = i; p < j;) {
      const slen = ansiSequenceLength(s, p, j);
      if (slen > 0) {
        parts.push(s.slice(p, p + slen));
        p += slen;
      } else p += expectedLength(s[p]) || 1;
    }
  }
  parts.push(s.slice(j));
  return concat(...parts);
}

function asciiEllipsize(s: Uint8Array, newLength: number, percent: number, utf8Locale: boolean): Uint8Array {
  if (s.length <= newLength) return s.slice();
  if (newLength === 1) return utf8(utf8Locale ? '…' : '.');
  if (newLength === 2 && !utf8Locale) return utf8('..');
  const needSpace = utf8Locale ? 1 : 3;
  const x = Math.floor(((newLength - needSpace) * percent + 50) / 100);
  const suffixLength = newLength - x - needSpace;
  return concat(s.slice(0, x), utf8Locale ? ELLIPSIS : utf8('...'), s.slice(s.length - suffixLength));
}
