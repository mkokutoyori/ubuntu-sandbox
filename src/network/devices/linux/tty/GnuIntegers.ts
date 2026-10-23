const UINTMAX_MAX = (1n << 64n) - 1n;
const SCALE_CEILING = 1073741823n;

export type UnsignedParse =
  | { readonly kind: 'ok'; readonly value: bigint }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'overflow' };

function isSpace(char: string): boolean {
  return char === ' ' || (char >= '\t' && char <= '\r');
}

function digitValue(char: string): number {
  const code = char.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 122) return code - 87;
  if (code >= 65 && code <= 90) return code - 55;
  return 99;
}

interface Scan {
  readonly value: bigint;
  readonly end: number;
  readonly overflow: boolean;
}

function scanUnsigned(text: string): Scan {
  let index = 0;
  while (index < text.length && isSpace(text[index])) index++;
  if (text[index] === '+') index++;
  let base = 10;
  const next = text[index + 1];
  if (text[index] === '0' && next !== undefined && 'xX'.includes(next) && digitValue(text[index + 2] ?? ' ') < 16) {
    base = 16;
    index += 2;
  } else if (text[index] === '0' && next !== undefined && 'bB'.includes(next) && digitValue(text[index + 2] ?? ' ') < 2) {
    base = 2;
    index += 2;
  } else if (text[index] === '0') {
    base = 8;
  }
  const start = index;
  let value = 0n;
  while (index < text.length && digitValue(text[index]) < base) {
    value = value * BigInt(base) + BigInt(digitValue(text[index]));
    index++;
  }
  if (index === start) return { value: 0n, end: 0, overflow: false };
  return { value: value > UINTMAX_MAX ? UINTMAX_MAX : value, end: index, overflow: value > UINTMAX_MAX };
}

function suffixFactor(char: string): bigint {
  return char === 'b' ? 512n : 1024n;
}

export function parseUnsigned(text: string, suffixes: string): UnsignedParse {
  let probe = 0;
  while (probe < text.length && isSpace(text[probe])) probe++;
  if (text[probe] === '-') return { kind: 'invalid' };
  const scan = scanUnsigned(text);
  let value = scan.value;
  let overflow = scan.overflow;
  let end = scan.end;
  if (scan.end === 0) {
    if (text.length > 0 && suffixes.includes(text[0])) value = 1n;
    else return { kind: 'invalid' };
    end = 0;
  }
  if (end < text.length) {
    if (!suffixes.includes(text[end])) return { kind: 'invalid' };
    value *= suffixFactor(text[end]);
    if (value > UINTMAX_MAX) {
      value = UINTMAX_MAX;
      overflow = true;
    }
    end++;
    if (end < text.length) return { kind: 'invalid' };
  }
  return overflow ? { kind: 'overflow' } : { kind: 'ok', value };
}

export type IntegerArgument =
  | { readonly kind: 'ok'; readonly value: bigint }
  | { readonly kind: 'invalid'; readonly reason: string };

export function integerArgument(text: string, maximum: bigint): IntegerArgument {
  const parsed = parseUnsigned(text, 'bB');
  if (parsed.kind === 'invalid') return { kind: 'invalid', reason: '' };
  if (parsed.kind === 'overflow') return { kind: 'invalid', reason: 'Value too large for defined data type' };
  if (parsed.value > maximum) {
    const reason = parsed.value > SCALE_CEILING ? 'Value too large for defined data type' : 'Numerical result out of range';
    return { kind: 'invalid', reason };
  }
  return { kind: 'ok', value: parsed.value };
}
