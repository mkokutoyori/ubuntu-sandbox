export function strstr(text: string, from: number, needle: string): number {
  if (from < 0) return -1;
  return text.indexOf(needle, from);
}

export function strchr(text: string, from: number, ch: string): number {
  if (from < 0) return -1;
  return text.indexOf(ch, from);
}

export function isHexDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && /[0-9a-fA-F]/.test(ch);
}

export function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && ch >= '0' && ch <= '9';
}

export function isAlpha(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && /[A-Za-z]/.test(ch);
}

export function strtoul(text: string, base = 10): number {
  const match = (base === 16 ? /^\s*(?:0[xX])?([0-9a-fA-F]+)/ : /^\s*([+-]?)(\d+)/).exec(text);
  if (!match) return 0;
  if (base === 16) return Number(BigInt('0x' + match[1]) & 0xffffffffffffffffn);
  const magnitude = Number(match[2]);
  return match[1] === '-' ? Number((-BigInt(match[2])) & 0xffffffffffffffffn) : magnitude;
}

export function toUint32(value: number): number {
  return value >>> 0;
}

export function toInt32(value: number): number {
  return value | 0;
}

export function unescapeBytes(text: string, from: number): number[] | null {
  let ptr = from;
  if (text[ptr] === '(') {
    const close = text.indexOf(')', ptr);
    if (close < 0) return null;
    return [...new TextEncoder().encode(text.slice(from, close + 1))];
  }
  while (isHexDigit(text[ptr])) ptr++;
  const digits = text.slice(from, ptr);
  if (digits.length < 2) return null;
  const bytes: number[] = [];
  for (let i = 0; i < digits.length; i += 2) {
    const hi = parseInt(digits[i], 16);
    const lo = i + 1 < digits.length ? parseInt(digits[i + 1], 16) : 0;
    bytes.push(((Number.isNaN(hi) ? 0 : hi) << 4) | (Number.isNaN(lo) ? 0 : lo));
  }
  return bytes;
}

export function bytesToCString(bytes: readonly number[]): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(Uint8Array.from(end >= 0 ? bytes.slice(0, end) : bytes));
}

export function unescapeHex(text: string, from: number): string | null {
  const bytes = unescapeBytes(text, from);
  return bytes === null ? null : bytesToCString(bytes);
}

function parseInteger(text: string): bigint {
  const match = /^\s*([+-]?)(\d+)/.exec(text);
  if (!match) return 0n;
  const magnitude = BigInt(match[2]);
  return match[1] === '-' ? -magnitude : magnitude;
}

export function strtoulUint32(text: string): number {
  return Number(BigInt.asUintN(32, parseInteger(text)));
}

export function strtollNumber(text: string): number {
  return Number(BigInt.asIntN(64, parseInteger(text)));
}
