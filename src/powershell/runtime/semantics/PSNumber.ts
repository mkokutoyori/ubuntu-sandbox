export type IntegerKind =
  'byte' | 'sbyte' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'int64' | 'uint64' | 'bigint';
export type NumericKind = IntegerKind | 'single' | 'double' | 'decimal';

export interface KindInfo {
  readonly name: string;
  readonly fullName: string;
  readonly min: bigint;
  readonly max: bigint;
}

const INT_INFO: Readonly<Record<IntegerKind, KindInfo>> = {
  byte: { name: 'Byte', fullName: 'System.Byte', min: 0n, max: 255n },
  sbyte: { name: 'SByte', fullName: 'System.SByte', min: -128n, max: 127n },
  int16: { name: 'Int16', fullName: 'System.Int16', min: -32768n, max: 32767n },
  uint16: { name: 'UInt16', fullName: 'System.UInt16', min: 0n, max: 65535n },
  int32: { name: 'Int32', fullName: 'System.Int32', min: -2147483648n, max: 2147483647n },
  uint32: { name: 'UInt32', fullName: 'System.UInt32', min: 0n, max: 4294967295n },
  int64: { name: 'Int64', fullName: 'System.Int64', min: -(2n ** 63n), max: 2n ** 63n - 1n },
  uint64: { name: 'UInt64', fullName: 'System.UInt64', min: 0n, max: 2n ** 64n - 1n },
  bigint: { name: 'BigInteger', fullName: 'System.Numerics.BigInteger', min: 0n, max: 0n },
};

const OTHER_INFO: Readonly<Record<'single' | 'double' | 'decimal', { name: string; fullName: string }>> = {
  single: { name: 'Single', fullName: 'System.Single' },
  double: { name: 'Double', fullName: 'System.Double' },
  decimal: { name: 'Decimal', fullName: 'System.Decimal' },
};

export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;
export const DECIMAL_MAX_DIGITS = 28;

export function isIntegerKind(kind: NumericKind): kind is IntegerKind {
  return kind in INT_INFO;
}

export function kindName(kind: NumericKind): { name: string; fullName: string } {
  return isIntegerKind(kind) ? INT_INFO[kind] : OTHER_INFO[kind];
}

export function integerRange(kind: IntegerKind): { min: bigint; max: bigint } {
  return INT_INFO[kind];
}

export class PSNumber {
  sourceText?: string;

  constructor(
    readonly kind: NumericKind,
    readonly value: number | bigint,
    readonly scale: number = 0,
  ) {}

  withSourceText(text: string): PSNumber {
    const copy = new PSNumber(this.kind, this.value, this.scale);
    copy.sourceText = text;
    return copy;
  }

  toNumber(): number {
    if (this.kind === 'decimal') return decimalToNumber(this.value as bigint, this.scale);
    return Number(this.value);
  }

  valueOf(): number {
    return this.toNumber();
  }

  toString(): string {
    return formatNumeric(this);
  }
}

export class PSChar {
  constructor(readonly code: number) {}

  toString(): string {
    return String.fromCharCode(this.code);
  }
}

export function isPSNumber(value: unknown): value is PSNumber {
  return value instanceof PSNumber;
}

export function isPSChar(value: unknown): value is PSChar {
  return value instanceof PSChar;
}

export function plainKind(value: number): NumericKind {
  if (Number.isInteger(value)) {
    if (value >= INT32_MIN && value <= INT32_MAX) return 'int32';
    if (Math.abs(value) < 2 ** 63) return 'int64';
  }
  return 'double';
}

export function numericKindOf(value: unknown): NumericKind | null {
  if (typeof value === 'number') return plainKind(value);
  if (value instanceof PSNumber) return value.kind;
  return null;
}

function decimalToNumber(unscaled: bigint, scale: number): number {
  return Number(unscaled) / 10 ** scale;
}

export function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

export function makeDecimal(unscaled: bigint, scale: number): PSNumber {
  let value = unscaled;
  let digits = scale;
  const limit = pow10(DECIMAL_MAX_DIGITS) * 10n;
  while (digits > 0 && (value >= limit || value <= -limit)) {
    value = roundDivide(value, 10n);
    digits -= 1;
  }
  return new PSNumber('decimal', value, digits);
}

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  if (twice > absDenominator || (twice === absDenominator && quotient % 2n !== 0n)) {
    return quotient + ((numerator < 0n) !== (denominator < 0n) ? -1n : 1n);
  }
  return quotient;
}

export function decimalFromNumber(value: number): PSNumber {
  if (Number.isInteger(value)) return makeDecimal(BigInt(value), 0);
  const text = value.toPrecision(15);
  return decimalFromText(text) ?? makeDecimal(BigInt(Math.round(value)), 0);
}

export function decimalFromText(text: string): PSNumber | null {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (match === null || (match[2] === '' && (match[3] ?? '') === '')) return null;
  const fraction = (match[3] ?? '').replace(/0+$/, '');
  let unscaled = BigInt((match[2] || '0') + fraction);
  let scale = fraction.length;
  const exponent = match[4] === undefined ? 0 : Number(match[4]);
  scale -= exponent;
  if (scale < 0) {
    unscaled *= pow10(-scale);
    scale = 0;
  }
  if (match[1] === '-') unscaled = -unscaled;
  return makeDecimal(unscaled, scale);
}

export function decimalParts(value: PSNumber): { unscaled: bigint; scale: number } {
  return { unscaled: value.value as bigint, scale: value.scale };
}

function alignDecimals(a: PSNumber, b: PSNumber): { x: bigint; y: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    x: (a.value as bigint) * pow10(scale - a.scale),
    y: (b.value as bigint) * pow10(scale - b.scale),
    scale,
  };
}

export function formatDecimal(value: PSNumber): string {
  const unscaled = value.value as bigint;
  const negative = unscaled < 0n;
  let digits = (negative ? -unscaled : unscaled).toString();
  if (value.scale > 0) {
    digits = digits.padStart(value.scale + 1, '0');
    digits = `${digits.slice(0, digits.length - value.scale)}.${digits.slice(digits.length - value.scale)}`;
  }
  return negative ? `-${digits}` : digits;
}

function formatSingle(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value < 0 ? '-Infinity' : 'Infinity';
  if (value === 0) return '0';
  const text = Number.parseFloat(Math.fround(value).toPrecision(7)).toString();
  return text.includes('e') ? expandExponent(text) : text;
}

function expandExponent(text: string): string {
  const [mantissa, exponent] = text.split('e');
  const sign = exponent.startsWith('-') ? '-' : '+';
  const digits = exponent.replace(/^[+-]/, '').padStart(2, '0');
  return `${mantissa}E${sign}${digits}`;
}

export function formatNumeric(value: PSNumber): string {
  switch (value.kind) {
    case 'decimal': return formatDecimal(value);
    case 'single': return formatSingle(value.value as number);
    case 'double': return formatDoubleText(value.value as number);
    default: return String(value.value);
  }
}

let doubleFormatter: (value: number) => string = (value) => String(value);

export function installDoubleFormatter(formatter: (value: number) => string): void {
  doubleFormatter = formatter;
}

export function formatDoubleText(value: number): string {
  return doubleFormatter(value);
}

export function integerValueOf(value: PSNumber | number): bigint {
  if (typeof value === 'number') return BigInt(value);
  if (value.kind === 'decimal') {
    const { unscaled, scale } = decimalParts(value);
    return roundDivide(unscaled, pow10(scale));
  }
  if (typeof value.value === 'bigint') return value.value;
  return BigInt(Math.trunc(value.value));
}

export function fitsKind(kind: IntegerKind, value: bigint): boolean {
  if (kind === 'bigint') return true;
  const range = INT_INFO[kind];
  return value >= range.min && value <= range.max;
}

export function boxInteger(kind: IntegerKind, value: bigint): number | PSNumber {
  if (kind === 'int32') return Number(value);
  if (kind === 'int64' && value >= BigInt(INT32_MIN) && value <= BigInt(INT32_MAX)) return new PSNumber('int64', value);
  if (kind === 'int64' && value > BigInt(INT32_MAX) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (kind === 'int64' && value < BigInt(INT32_MIN) && value >= -BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (kind === 'int64' || kind === 'uint64' || kind === 'bigint') return new PSNumber(kind, value);
  return new PSNumber(kind, Number(value));
}

export function boxDouble(value: number): number | PSNumber {
  if (Number.isInteger(value) || !Number.isFinite(value)) return new PSNumber('double', value);
  return value;
}

export function boxSingle(value: number): PSNumber {
  return new PSNumber('single', Math.fround(value));
}

export function boxAs(kind: NumericKind, value: number | PSNumber): number | PSNumber {
  if (kind === 'decimal') return toDecimal(value);
  if (kind === 'double') return boxDouble(toDouble(value));
  if (kind === 'single') return boxSingle(toDouble(value));
  return boxInteger(kind, integerValueOf(value));
}

export function toDouble(value: number | PSNumber): number {
  return typeof value === 'number' ? value : value.toNumber();
}

export function toDecimal(value: number | PSNumber): PSNumber {
  if (typeof value !== 'number' && value.kind === 'decimal') return value;
  if (typeof value !== 'number' && isIntegerKind(value.kind)) return makeDecimal(BigInt(value.value), 0);
  return decimalFromNumber(toDouble(value));
}

export class ArithmeticFault extends Error {
  constructor(readonly exceptionType: string, message: string) {
    super(message);
    this.name = 'ArithmeticFault';
  }
}

export type ArithmeticOperator = '+' | '-' | '*' | '/' | '%';

type Operand = number | PSNumber;

type OperationKind = 'int32' | 'uint32' | 'int64' | 'uint64' | 'bigint';

function integerResult(kind: OperationKind, result: bigint): number | PSNumber {
  if (fitsKind(kind, result)) return boxInteger(kind, result);
  return boxDouble(Number(result));
}

function divideByZero(): never {
  throw new ArithmeticFault('System.DivideByZeroException', 'Attempted to divide by zero.');
}

function decimalOperation(op: ArithmeticOperator, a: PSNumber, b: PSNumber): PSNumber {
  if (op === '+' || op === '-') {
    const { x, y, scale } = alignDecimals(a, b);
    return makeDecimal(op === '+' ? x + y : x - y, scale);
  }
  if (op === '*') return makeDecimal((a.value as bigint) * (b.value as bigint), a.scale + b.scale);
  if ((b.value as bigint) === 0n) divideByZero();
  if (op === '%') {
    const { x, y, scale } = alignDecimals(a, b);
    return makeDecimal(x % y, scale);
  }
  const extra = DECIMAL_MAX_DIGITS + 1 + b.scale;
  const numerator = (a.value as bigint) * pow10(extra);
  const quotient = roundDivide(numerator, b.value as bigint);
  return trimDecimal(makeDecimal(quotient, a.scale + extra - b.scale));
}

function trimDecimal(value: PSNumber): PSNumber {
  let unscaled = value.value as bigint;
  let scale = value.scale;
  while (scale > 0 && unscaled % 10n === 0n) {
    unscaled /= 10n;
    scale -= 1;
  }
  return new PSNumber('decimal', unscaled, scale);
}

const OPERATION_RANK: Readonly<Record<NumericKind, number>> = {
  byte: 1, sbyte: 1, int16: 1, uint16: 1, int32: 1, uint32: 2, int64: 3, uint64: 4, bigint: 4.5,
  single: 5, double: 6, decimal: 7,
};

function operationKind(left: Operand, right: Operand, lk: NumericKind, rk: NumericKind): OperationKind {
  const rank = Math.max(OPERATION_RANK[lk], OPERATION_RANK[rk]);
  if (rank === 4.5) return 'bigint';
  if (rank === 1) return 'int32';
  if (rank === 3) return 'int64';
  const negative = (isNegativeSigned(left, lk) || isNegativeSigned(right, rk));
  if (rank === 2) return negative ? 'int64' : 'uint32';
  return 'uint64';
}

function isNegativeSigned(value: Operand, kind: NumericKind): boolean {
  if (kind === 'uint32' || kind === 'uint64' || kind === 'byte' || kind === 'uint16') return false;
  return integerValueOf(value) < 0n;
}

function integerOperation(op: ArithmeticOperator, kind: OperationKind, a: bigint, b: bigint): Operand {
  switch (op) {
    case '+': return integerResult(kind, a + b);
    case '-': return integerResult(kind, a - b);
    case '*': return integerResult(kind, a * b);
    case '%':
      if (b === 0n) divideByZero();
      return integerResult(kind, a % b);
    default:
      if (b === 0n) divideByZero();
      if (kind === 'bigint') return integerResult(kind, a / b);
      if (a % b === 0n) return integerResult(kind, a / b);
      return boxDouble(Number(a) / Number(b));
  }
}

export function arithmetic(op: ArithmeticOperator, left: Operand, right: Operand): Operand {
  const lk = numericKindOf(left) as NumericKind;
  const rk = numericKindOf(right) as NumericKind;
  const rank = Math.max(OPERATION_RANK[lk], OPERATION_RANK[rk]);
  if (rank === 7) return decimalOperation(op, toDecimal(left), toDecimal(right));
  if (rank >= 5) return boxDouble(floatOperation(op, toDouble(left), toDouble(right)));
  const kind = operationKind(left, right, lk, rk);
  if (kind === 'uint64' && (isNegativeSigned(left, lk) || isNegativeSigned(right, rk))) {
    return boxDouble(floatOperation(op, Number(integerValueOf(left)), Number(integerValueOf(right))));
  }
  return integerOperation(op, kind, integerValueOf(left), integerValueOf(right));
}

function floatOperation(op: ArithmeticOperator, a: number, b: number): number {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    default: return a % b;
  }
}

export function negate(value: Operand): Operand {
  const kind = numericKindOf(value) as NumericKind;
  if (kind === 'decimal') {
    const { unscaled, scale } = decimalParts(value as PSNumber);
    return new PSNumber('decimal', -unscaled, scale);
  }
  if (kind === 'double' || kind === 'single') return boxDouble(-toDouble(value));
  const wide: OperationKind = kind === 'bigint' ? 'bigint' : kind === 'int64' || kind === 'uint64' ? 'int64' : 'int32';
  return integerResult(wide, -integerValueOf(value));
}

export function compareNumbers(left: Operand, right: Operand): number {
  const lk = numericKindOf(left) as NumericKind;
  const rk = numericKindOf(right) as NumericKind;
  if (lk === 'decimal' || rk === 'decimal') {
    const { x, y } = alignDecimals(toDecimal(left), toDecimal(right));
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (lk === 'double' || rk === 'double' || lk === 'single' || rk === 'single') {
    const a = toDouble(left);
    const b = toDouble(right);
    return a < b ? -1 : a > b ? 1 : a === b ? 0 : Number.NaN;
  }
  const a = integerValueOf(left);
  const b = integerValueOf(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
