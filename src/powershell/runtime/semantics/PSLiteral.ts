import {
  PSNumber, boxDouble, boxInteger, decimalFromText, fitsKind, makeDecimal, type IntegerKind,
} from './PSNumber';

export interface LiteralOptions {
  readonly core: boolean;
}

type NumberFormat = 'decimal' | 'hex' | 'binary';

const UNSIGNED = 0x1;
const SIGNED_BYTE = 0x2;
const SHORT = 0x4;
const LONG = 0x8;
const DECIMAL = 0x10;
const BIG_INTEGER = 0x20;

export interface NumericScan {
  readonly length: number;
  readonly digits: string;
  readonly format: NumberFormat;
  readonly suffix: number;
  readonly real: boolean;
  readonly multiplier: bigint;
}

const MULTIPLIERS: Readonly<Record<string, bigint>> = {
  k: 1024n, m: 1024n ** 2n, g: 1024n ** 3n, t: 1024n ** 4n, p: 1024n ** 5n,
};

const NEW_TOKEN_AFTER_NUMBER = new Set(['!', '#', '%', '*', '+', '-', '.', '/', '<', '=', '>', ']']);
const NEW_TOKEN = new Set(['&', '(', ')', ',', ';', '{', '|', '}']);

function startsNewToken(char: string | undefined): boolean {
  if (char === undefined || char === '\0') return true;
  return /\s/.test(char) || NEW_TOKEN.has(char) || NEW_TOKEN_AFTER_NUMBER.has(char);
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function isHexDigit(char: string | undefined): boolean {
  return char !== undefined && /^[0-9a-fA-F]$/.test(char);
}

export function scanNumericLiteral(input: string, start: number, options: LiteralOptions): NumericScan | null {
  let index = start;
  let digits = '';
  let notNumber = false;
  let real = false;
  let format: NumberFormat = 'decimal';
  let suffix = 0;
  let multiplier = 1n;
  const peek = (): string | undefined => input[index];
  const digitsInto = (accept: (char: string | undefined) => boolean): number => {
    let count = 0;
    while (accept(peek())) { digits += input[index]; index++; count++; }
    return count;
  };
  const exponent = (): void => {
    if (peek() === '+' || peek() === '-') { digits += input[index]; index++; }
    if (digitsInto(isDigit) === 0) notNumber = true;
  };
  const afterDot = (): void => {
    digitsInto(isDigit);
    if (peek() === 'e' || peek() === 'E') { digits += input[index]; index++; exponent(); }
  };

  let first = peek();
  if (first === '+' || first === '-') {
    digits += first;
    index++;
    first = peek();
  }
  if (first === '.') {
    digits += '.';
    index++;
    afterDot();
    real = true;
  } else if (first === undefined || !isDigit(first)) {
    return null;
  } else {
    const marker = input[index + 1];
    if (first === '0' && (marker === 'x' || marker === 'X' || (options.core && (marker === 'b' || marker === 'B')))) {
      index += 2;
      if (marker === 'x' || marker === 'X') {
        digits += '0';
        digitsInto(isHexDigit);
        format = 'hex';
      } else {
        digitsInto(char => char === '0' || char === '1');
        format = 'binary';
        if (digits.replace(/^[+-]/, '') === '') notNumber = true;
      }
    } else {
      digits += first;
      index++;
      digitsInto(isDigit);
      const c = peek();
      if (c === '.') {
        index++;
        if (peek() === '.') index--;
        else { digits += '.'; real = true; afterDot(); }
      } else if (c === 'e' || c === 'E') {
        index++;
        digits += c;
        real = true;
        exponent();
      }
    }
  }

  const typeSuffix = (char: string | undefined): boolean =>
    char !== undefined && (options.core ? /^[uUsSlLdDyYnN]$/ : /^[lLdD]$/).test(char);
  let c = peek();
  if (typeSuffix(c)) {
    index++;
    switch (c!.toLowerCase()) {
      case 'u': suffix |= UNSIGNED; break;
      case 's': suffix |= SHORT; break;
      case 'l': suffix |= LONG; break;
      case 'd': suffix |= DECIMAL; break;
      case 'y': suffix |= SIGNED_BYTE; break;
      case 'n': suffix |= BIG_INTEGER; break;
      default: notNumber = true;
    }
    c = peek();
    if (typeSuffix(c)) {
      index++;
      if (suffix === UNSIGNED) {
        switch (c!.toLowerCase()) {
          case 'l': suffix |= LONG; break;
          case 's': suffix |= SHORT; break;
          case 'y': suffix |= SIGNED_BYTE; break;
          default: notNumber = true;
        }
      } else notNumber = true;
      c = peek();
    }
  }
  if (c !== undefined && /^[kKmMgGtTpP]$/.test(c)) {
    index++;
    multiplier = MULTIPLIERS[c.toLowerCase()];
    const unit = peek();
    if (unit === 'b' || unit === 'B') { index++; c = peek(); }
    else notNumber = true;
  }
  if (!startsNewToken(c)) notNumber = true;
  if (notNumber) return null;
  return { length: index - start, digits, format, suffix, real, multiplier };
}

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

const RANGES: Readonly<Record<number, IntegerKind>> = {
  [SIGNED_BYTE]: 'sbyte',
  [UNSIGNED | SIGNED_BYTE]: 'byte',
  [SHORT]: 'int16',
  [UNSIGNED | SHORT]: 'uint16',
  [LONG]: 'int64',
  [UNSIGNED | LONG]: 'uint64',
};

function boxBySuffix(value: bigint, suffix: number): number | PSNumber | null {
  if (suffix === BIG_INTEGER) return boxInteger('bigint', value);
  if (suffix === UNSIGNED) {
    if (fitsKind('uint32', value)) return boxInteger('uint32', value);
    return fitsKind('uint64', value) ? boxInteger('uint64', value) : null;
  }
  const kind = RANGES[suffix];
  if (kind === undefined) return null;
  return fitsKind(kind, value) ? boxInteger(kind, value) : null;
}

function twosComplement(value: bigint, bits: number): bigint {
  return value >= 1n << BigInt(bits - 1) ? value - (1n << BigInt(bits)) : value;
}

const DECIMAL_MAX = 79228162514264337593543950335n;

export function numberFromScan(scan: NumericScan): number | PSNumber | null {
  let { digits, suffix, multiplier } = scan;
  if (scan.real) {
    if (suffix === DECIMAL) {
      const parsed = decimalFromText(digits, true);
      if (parsed === null) return null;
      return makeDecimal((parsed.value as bigint) * multiplier, parsed.scale);
    }
    let value = Number(digits);
    if (Number.isNaN(value)) return null;
    if (value === 0 && digits.startsWith('-')) value = -0;
    value *= Number(multiplier);
    if (suffix === 0) return boxDouble(value);
    if (!Number.isFinite(value)) return null;
    return boxBySuffix(BigInt(roundHalfEven(value)), suffix);
  }

  let value: bigint;
  let sign = 1n;
  if (scan.format !== 'decimal' && (digits[0] === '-' || digits[0] === '+')) {
    if (digits[0] === '-') sign = -1n;
    digits = digits.slice(1);
  }
  if (scan.format === 'hex') {
    if ((suffix & UNSIGNED) === 0) {
      const expected = suffix === SIGNED_BYTE ? 2 : suffix === SHORT ? 4 : suffix === LONG ? 16 : digits.length < 16 ? 8 : 16;
      if (digits.length === expected + 1) digits = digits.slice(1);
    }
    if (digits === '') return null;
    value = twosComplement(BigInt(`0x${digits}`), digits.length * 4);
    if (digits.length === 16 && (suffix === 0 || suffix === UNSIGNED)) suffix |= LONG;
  } else if (scan.format === 'binary') {
    if (digits === '') return null;
    const raw = BigInt(`0b${digits}`);
    let unsigned = (suffix & UNSIGNED) !== 0 || digits[0] === '0';
    if (!unsigned && ![8, 16, 32, 64, 96].includes(digits.length) && digits.length < 128) unsigned = true;
    value = !unsigned && digits.length % 8 === 0 ? twosComplement(raw, digits.length) : raw;
    if (digits.length === 64 && (suffix === 0 || suffix === UNSIGNED)) suffix |= LONG;
  } else {
    if (!/^[+-]?\d+$/.test(digits)) return null;
    value = BigInt(digits);
  }
  value *= sign * multiplier;

  if (suffix === DECIMAL) {
    return value >= -DECIMAL_MAX && value <= DECIMAL_MAX ? makeDecimal(value, 0) : null;
  }
  if (suffix !== 0) return boxBySuffix(value, suffix);
  if (fitsKind('int32', value)) return boxInteger('int32', value);
  if (fitsKind('int64', value)) return boxInteger('int64', value);
  if (scan.format === 'decimal') {
    if (value >= -DECIMAL_MAX && value <= DECIMAL_MAX) return makeDecimal(value, 0);
    return boxDouble(Number(value));
  }
  return null;
}

export function parseNumberLiteral(raw: string, options: LiteralOptions = { core: false }): number | PSNumber | null {
  const scan = scanNumericLiteral(raw, 0, options);
  if (scan === null || scan.length !== raw.length) return null;
  return numberFromScan(scan);
}
