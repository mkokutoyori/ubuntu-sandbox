import {
  PSNumber, boxDouble, boxInteger, decimalFromText, fitsKind, makeDecimal, type IntegerKind,
} from './PSNumber';

const MULTIPLIERS: Readonly<Record<string, bigint>> = {
  kb: 1024n, mb: 1024n ** 2n, gb: 1024n ** 3n, tb: 1024n ** 4n, pb: 1024n ** 5n,
};

const SUFFIX_KINDS: Readonly<Record<string, IntegerKind | 'decimal' | 'bigint'>> = {
  l: 'int64', s: 'int16', y: 'sbyte', uy: 'byte', us: 'uint16', u: 'uint32', ul: 'uint64', d: 'decimal', n: 'bigint',
};

export interface LiteralOptions {
  readonly core: boolean;
}

export function parseNumberLiteral(raw: string, options: LiteralOptions = { core: false }): number | PSNumber {
  let text = raw;
  let multiplier = 1n;
  const multiplierMatch = /(kb|mb|gb|tb|pb)$/i.exec(text);
  if (multiplierMatch !== null) {
    multiplier = MULTIPLIERS[multiplierMatch[1].toLowerCase()];
    text = text.slice(0, -2);
  }
  const hex = /^0x/i.test(text);
  const binary = /^0b/i.test(text);
  let suffix = '';
  if (!hex) {
    const suffixMatch = options.core
      ? /(ul|uy|us|[lsyudn])$/i.exec(text)
      : /([ld])$/i.exec(text);
    if (suffixMatch !== null && !/[eE][+-]?\d*$/.test(text)) {
      suffix = suffixMatch[1].toLowerCase();
      text = text.slice(0, -suffix.length);
    }
  } else {
    const hexSuffix = options.core ? /(ul|uy|us|[lsyun])$/i.exec(text) : /(l)$/i.exec(text);
    if (hexSuffix !== null) {
      suffix = hexSuffix[1].toLowerCase();
      text = text.slice(0, -suffix.length);
    }
  }
  const real = !hex && !binary && /[.eE]/.test(text);
  if (real) return realLiteral(text, suffix, multiplier);
  return integerLiteral(text, suffix, multiplier, hex ? 'hex' : binary ? 'binary' : 'decimal');
}

function realLiteral(text: string, suffix: string, multiplier: bigint): number | PSNumber {
  if (suffix === 'd') {
    const parsed = decimalFromText(text);
    if (parsed === null) return boxDouble(Number(text) * Number(multiplier));
    return makeDecimal((parsed.value as bigint) * multiplier, parsed.scale);
  }
  const value = Number(text) * Number(multiplier);
  const kind = SUFFIX_KINDS[suffix];
  if (kind !== undefined && kind !== 'decimal' && kind !== 'bigint') {
    const integer = BigInt(Math.trunc(value));
    return fitsKind(kind, integer) ? boxInteger(kind, integer) : boxDouble(value);
  }
  return boxDouble(value);
}

function integerLiteral(
  text: string, suffix: string, multiplier: bigint, format: 'hex' | 'binary' | 'decimal',
): number | PSNumber {
  let value: bigint;
  if (format === 'decimal') value = BigInt(text.replace(/^\+/, ''));
  else {
    const digits = text.slice(2);
    value = BigInt(format === 'hex' ? `0x${digits}` : `0b${digits}`);
    value = signedFromBits(value, digits.length, format, suffix);
  }
  value *= multiplier;
  const kind = SUFFIX_KINDS[suffix];
  if (kind === 'decimal') return makeDecimal(value, 0);
  if (kind === 'bigint') return boxInteger('bigint', value);
  if (kind !== undefined) {
    if (fitsKind(kind, value)) return boxInteger(kind, value);
    return boxDouble(Number(value));
  }
  if (fitsKind('int32', value)) return Number(value);
  if (fitsKind('int64', value)) return boxInteger('int64', value);
  if (format === 'decimal') {
    if (value <= 79228162514264337593543950335n) return makeDecimal(value, 0);
    return boxDouble(Number(value));
  }
  return boxDouble(Number(value));
}

function signedFromBits(value: bigint, digitCount: number, format: 'hex' | 'binary', suffix: string): bigint {
  const bitsPerDigit = format === 'hex' ? 4 : 1;
  const bits = digitCount * bitsPerDigit;
  const unsigned = suffix.startsWith('u');
  if (unsigned) return value;
  let width = 0;
  if (suffix === 'y') width = 8;
  else if (suffix === 's') width = 16;
  else if (suffix === 'l') width = 64;
  else if (bits === (format === 'hex' ? 32 : 32) || bits === 64) width = bits;
  if (width === 0 || bits !== width) return value;
  const sign = 1n << BigInt(width - 1);
  return value >= sign ? value - (1n << BigInt(width)) : value;
}
