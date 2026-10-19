import {
  PSNumber, arithmetic, boxDouble, compareNumbers, decimalParts, makeDecimal, numericKindOf, pow10, toDouble,
  type NumericKind,
} from './PSNumber';
import { arithmeticOperand } from './PSOperators';
import { castToNumeric, roundHalfEven } from './PSConvert';
import type { PSValue } from '../PSEnvironment';

type Operand = number | PSNumber;

function operand(value: PSValue): Operand {
  const converted = arithmeticOperand(value);
  if (converted === null) return castToNumeric('double', value);
  return converted;
}

function real(value: PSValue): number {
  return toDouble(operand(value));
}

function kindOf(value: Operand): NumericKind {
  return numericKindOf(value) as NumericKind;
}

function isFloating(kind: NumericKind): boolean {
  return kind === 'double' || kind === 'single';
}

function roundDecimal(value: PSNumber, digits: number, mode: string): PSNumber {
  const { unscaled, scale } = decimalParts(value);
  if (scale <= digits) return value;
  const drop = scale - digits;
  const divisor = pow10(drop);
  const quotient = unscaled / divisor;
  const remainder = unscaled % divisor;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  let result = quotient;
  const away = unscaled < 0n ? -1n : 1n;
  if (mode === 'awayfromzero') {
    if (twice >= divisor) result = quotient + away;
  } else if (twice > divisor || (twice === divisor && quotient % 2n !== 0n)) {
    result = quotient + away;
  }
  return makeDecimal(result, digits);
}

function roundDouble(value: number, digits: number, mode: string): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  if (mode === 'awayfromzero') return (scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)) / factor;
  if (mode === 'tozero') return Math.trunc(scaled) / factor;
  if (mode === 'toneginf') return Math.floor(scaled) / factor;
  if (mode === 'topositiveinfinity') return Math.ceil(scaled) / factor;
  return roundHalfEven(scaled) / factor;
}

function modeName(value: PSValue | undefined): string {
  if (value === undefined || value === null) return 'toeven';
  const text = String(value).toLowerCase();
  if (text === '1') return 'awayfromzero';
  if (text === '2') return 'tozero';
  if (text === '3') return 'toneginf';
  if (text === '4') return 'topositiveinfinity';
  return text;
}

function rounder(kindFallback: 'round' | 'floor' | 'ceiling' | 'truncate') {
  return (x: PSValue, a?: PSValue, b?: PSValue): PSValue => {
    const value = operand(x);
    const kind = kindOf(value);
    if (kind === 'decimal') {
      const digits = a === undefined || typeof a === 'string' ? 0 : Number(a);
      const mode = kindFallback === 'round' ? modeName(typeof a === 'string' ? a : b) : kindFallback === 'floor' ? 'toneginf' : kindFallback === 'ceiling' ? 'topositiveinfinity' : 'tozero';
      return roundDecimal(value as PSNumber, digits, mode);
    }
    if (!isFloating(kind)) return value;
    const number = toDouble(value);
    const digits = kindFallback === 'round' && a !== undefined && typeof a !== 'string' ? Number(a) : 0;
    switch (kindFallback) {
      case 'floor': return boxDouble(Math.floor(number));
      case 'ceiling': return boxDouble(Math.ceil(number));
      case 'truncate': return boxDouble(Math.trunc(number));
      default: return boxDouble(roundDouble(number, digits, modeName(typeof a === 'string' ? a : b)));
    }
  };
}

function extreme(pick: 'min' | 'max') {
  return (a: PSValue, b: PSValue): PSValue => {
    const x = operand(a);
    const y = operand(b);
    const order = compareNumbers(x, y);
    if (Number.isNaN(order)) return boxDouble(Number.NaN);
    const left = pick === 'min' ? order <= 0 : order >= 0;
    const chosen = left ? x : y;
    return arithmetic('+', chosen, arithmetic('-', x, x)) as PSValue;
  };
}

function unary(fn: (x: number) => number) {
  return (x: PSValue): PSValue => boxDouble(fn(real(x)));
}

export function mathStatics(): Record<string, PSValue> {
  return {
    pi: boxDouble(Math.PI),
    e: boxDouble(Math.E),
    tau: boxDouble(Math.PI * 2),
    abs: (x: PSValue) => {
      const value = operand(x);
      return compareNumbers(value, 0) < 0 ? arithmetic('-', 0, value) as PSValue : value;
    },
    sign: (x: PSValue) => {
      const value = operand(x);
      const order = compareNumbers(value, 0);
      return Number.isNaN(order) ? boxDouble(Number.NaN) : order;
    },
    ceiling: rounder('ceiling'),
    floor: rounder('floor'),
    round: rounder('round'),
    truncate: rounder('truncate'),
    sqrt: unary(Math.sqrt),
    cbrt: unary(Math.cbrt),
    exp: unary(Math.exp),
    sin: unary(Math.sin), cos: unary(Math.cos), tan: unary(Math.tan),
    asin: unary(Math.asin), acos: unary(Math.acos), atan: unary(Math.atan),
    sinh: unary(Math.sinh), cosh: unary(Math.cosh), tanh: unary(Math.tanh),
    log10: unary(Math.log10),
    log2: unary(Math.log2),
    log: (x: PSValue, base?: PSValue) => boxDouble(base === undefined ? Math.log(real(x)) : Math.log(real(x)) / Math.log(real(base))),
    atan2: (y: PSValue, x: PSValue) => boxDouble(Math.atan2(real(y), real(x))),
    pow: (b: PSValue, e: PSValue) => boxDouble(Math.pow(real(b), real(e))),
    min: extreme('min'),
    max: extreme('max'),
    clamp: (value: PSValue, low: PSValue, high: PSValue) => {
      const x = operand(value);
      if (compareNumbers(x, operand(low)) < 0) return operand(low);
      if (compareNumbers(x, operand(high)) > 0) return operand(high);
      return x;
    },
    divrem: (a: PSValue, b: PSValue) => {
      const quotient = arithmetic('/', operand(a), operand(b));
      return [Math.trunc(toDouble(quotient)), arithmetic('%', operand(a), operand(b))] as PSValue;
    },
    ieeeremainder: (a: PSValue, b: PSValue) => {
      const x = real(a);
      const y = real(b);
      return boxDouble(x - y * roundHalfEven(x / y));
    },
  };
}
