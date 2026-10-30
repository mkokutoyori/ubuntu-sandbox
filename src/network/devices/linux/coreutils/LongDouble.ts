const MANTISSA_BITS = 64;
const EXPONENT_BIAS = 16383;
const MAX_EXPONENT = 0x7fff;
const DIGITS_PRECISION_START = 18;
const DIGITS_PRECISION_END = 21;

interface Extended {
  readonly negative: boolean;
  readonly mantissa: bigint;
  readonly exponent: number;
}

function ratioRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const twice = (numerator - quotient * denominator) * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) return quotient + 1n;
  return quotient;
}

function decimalDigits(extended: Extended, precision: number): { digits: string; exponent: number } {
  const power = extended.exponent;
  let estimate = Math.floor((Number(extended.mantissa.toString().length) - 1 + power * Math.log10(2)));
  for (let attempt = 0; attempt < 4; attempt++) {
    const shift = precision - 1 - estimate;
    let numerator = extended.mantissa;
    let denominator = 1n;
    if (power >= 0) numerator <<= BigInt(power); else denominator <<= BigInt(-power);
    if (shift >= 0) numerator *= 10n ** BigInt(shift); else denominator *= 10n ** BigInt(-shift);
    const scaled = ratioRoundHalfEven(numerator, denominator);
    const text = scaled.toString();
    if (text.length === precision) return { digits: text, exponent: estimate };
    estimate += text.length > precision ? 1 : -1;
  }
  throw new Error('long double digits did not converge');
}

function powerOfTwo(power: number): { numerator: bigint; denominator: bigint } {
  return power >= 0 ? { numerator: 1n << BigInt(power), denominator: 1n } : { numerator: 1n, denominator: 1n << BigInt(-power) };
}

function roundTrips(extended: Extended, digits: string, decimalExponent: number): boolean {
  const scale = decimalExponent - digits.length + 1;
  const decimalNumerator = scale >= 0 ? BigInt(digits) * 10n ** BigInt(scale) : BigInt(digits);
  const decimalDenominator = scale >= 0 ? 1n : 10n ** BigInt(-scale);
  const actual = powerOfTwo(extended.exponent);
  const actualNumerator = extended.mantissa * actual.numerator;
  const actualDenominator = actual.denominator;
  const left = decimalNumerator * actualDenominator;
  const right = actualNumerator * decimalDenominator;
  const difference = left > right ? left - right : right - left;
  const lowerBoundary = extended.mantissa === 1n << BigInt(MANTISSA_BITS - 1) && left < right;
  const half = powerOfTwo(extended.exponent - (lowerBoundary ? 2 : 1));
  const scaledDifference = difference * half.denominator;
  const scaledHalf = half.numerator * decimalDenominator * actualDenominator;
  return scaledDifference < scaledHalf || (scaledDifference === scaledHalf && extended.mantissa % 2n === 0n);
}

function generalFormat(digits: string, exponent: number, precision: number): string {
  const trimmed = digits.replace(/0+$/, '') || '0';
  if (exponent < -4 || exponent >= precision) {
    const mantissa = trimmed.length > 1 ? `${trimmed[0]}.${trimmed.slice(1)}` : trimmed;
    return `${mantissa}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  if (exponent >= 0) {
    const integer = trimmed.padEnd(exponent + 1, '0').slice(0, exponent + 1);
    const fraction = trimmed.slice(exponent + 1);
    return fraction === '' ? integer : `${integer}.${fraction}`;
  }
  return `0.${'0'.repeat(-exponent - 1)}${trimmed}`;
}

export function formatLongDouble(bytes: readonly number[]): string {
  let mantissa = 0n;
  for (let index = 7; index >= 0; index--) mantissa = (mantissa << 8n) | BigInt(bytes[index] ?? 0);
  const high = ((bytes[9] ?? 0) << 8) | (bytes[8] ?? 0);
  const negative = (high & 0x8000) !== 0;
  const biased = high & MAX_EXPONENT;
  const sign = negative ? '-' : '';
  const integerBit = (mantissa >> BigInt(MANTISSA_BITS - 1)) & 1n;
  if (biased === MAX_EXPONENT) {
    return (mantissa << 1n & ((1n << 64n) - 1n)) === 0n && integerBit === 1n ? `${sign}inf` : `${sign}nan`;
  }
  if (biased !== 0 && integerBit === 0n) return `${sign}nan`;
  if (mantissa === 0n) return negative ? '-0' : '0';
  const extended: Extended = {
    negative,
    mantissa,
    exponent: (biased === 0 ? 1 : biased) - EXPONENT_BIAS - (MANTISSA_BITS - 1),
  };
  const start = biased === 0 ? 1 : DIGITS_PRECISION_START;
  for (let precision = start; precision <= DIGITS_PRECISION_END; precision++) {
    const { digits, exponent } = decimalDigits(extended, precision);
    if (roundTrips(extended, digits, exponent)) return `${sign}${generalFormat(digits, exponent, precision)}`;
  }
  const { digits, exponent } = decimalDigits(extended, DIGITS_PRECISION_END);
  return `${sign}${generalFormat(digits, exponent, DIGITS_PRECISION_END)}`;
}
