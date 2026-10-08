const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
const I64_MIN = -(1n << 63n);

interface Scanned {
  negative: boolean;
  magnitude: bigint;
  consumed: number;
  digits: number;
}

function scan(text: string, baseIn: number): Scanned {
  let i = 0;
  while (i < text.length && /[ \t\n\v\f\r]/.test(text[i])) i++;
  let negative = false;
  if (text[i] === '+' || text[i] === '-') {
    negative = text[i] === '-';
    i++;
  }
  let base = baseIn;
  const isHex = (ch: string | undefined): boolean => ch !== undefined && /[0-9a-fA-F]/.test(ch);
  if ((base === 0 || base === 16) && text[i] === '0' && (text[i + 1] === 'x' || text[i + 1] === 'X') && isHex(text[i + 2])) {
    i += 2;
    base = 16;
  } else if (base === 0) base = text[i] === '0' ? 8 : 10;
  const start = i;
  let value = 0n;
  const radix = BigInt(base);
  for (; i < text.length; i++) {
    const digit = parseInt(text[i], 36);
    if (Number.isNaN(digit) || digit >= base) break;
    value = value * radix + BigInt(digit);
  }
  return { negative, magnitude: value, consumed: i, digits: i - start };
}

export function strtoulBig(text: string, base: number): bigint {
  const s = scan(text, base);
  if (s.digits === 0) return 0n;
  if (s.magnitude > U64_MAX) return U64_MAX;
  return s.negative ? (-s.magnitude) & U64_MAX : s.magnitude;
}

export function strtolBig(text: string, base: number): bigint {
  const s = scan(text, base);
  if (s.digits === 0) return 0n;
  if (s.negative) {
    const value = -s.magnitude;
    return value < I64_MIN ? I64_MIN : value;
  }
  return s.magnitude > I64_MAX ? I64_MAX : s.magnitude;
}

export const toU32 = (value: bigint): number => Number(BigInt.asUintN(32, value));
export const toI32 = (value: bigint): number => Number(BigInt.asIntN(32, value));
