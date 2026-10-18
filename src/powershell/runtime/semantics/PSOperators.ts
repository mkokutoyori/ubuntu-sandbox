import {
  PSChar, PSNumber, arithmetic, compareNumbers, negate, numericKindOf, ArithmeticFault,
  type ArithmeticOperator,
} from './PSNumber';
import {
  DESKTOP_CONVERSION, PSConversionError, castToNumeric, conversionFailure, parseNumericString,
  type ConversionOptions,
} from './PSConvert';
import { psValueToString } from '../PSExpansion';
import type { PSValue } from '../PSEnvironment';

export { ArithmeticFault, PSConversionError };

type Operand = number | PSNumber;

const OPERATOR_METHOD: Readonly<Record<ArithmeticOperator, string>> = {
  '+': 'op_Addition', '-': 'op_Subtraction', '*': 'op_Multiply', '/': 'op_Division', '%': 'op_Modulus',
};

function typeNameForMethod(value: unknown): string {
  if (Array.isArray(value)) return 'System.Object[]';
  if (typeof value === 'boolean') return 'System.Boolean';
  if (typeof value === 'string') return 'System.String';
  if (value instanceof Date) return 'System.DateTime';
  if (typeof value === 'object' && value !== null) return 'System.Collections.Hashtable';
  return 'System.Object';
}

function missingOperator(op: ArithmeticOperator, value: unknown): PSConversionError {
  return new PSConversionError(
    'System.Management.Automation.RuntimeException',
    `Method invocation failed because [${typeNameForMethod(value)}] does not contain a method named '${OPERATOR_METHOD[op]}'.`,
  );
}

export function arithmeticOperand(
  value: PSValue, options: ConversionOptions = DESKTOP_CONVERSION,
): Operand | null {
  if (typeof value === 'number' || value instanceof PSNumber) return value;
  if (value instanceof PSChar) return value.code;
  if (value === null || value === undefined) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const parsed = parseNumericString(value);
    if (parsed === null) return castToNumeric('int32', value, options);
    return parsed;
  }
  return null;
}

export function isNumericLike(value: PSValue): boolean {
  return typeof value === 'number' || value instanceof PSNumber || value instanceof PSChar;
}

export function numericArithmetic(
  op: ArithmeticOperator, left: PSValue, right: PSValue, options: ConversionOptions = DESKTOP_CONVERSION,
): PSValue {
  if (typeof left === 'boolean' || (typeof left === 'object' && left !== null && !(left instanceof PSNumber) && !(left instanceof PSChar))) {
    throw missingOperator(op, left);
  }
  const a = arithmeticOperand(left, options);
  const b = arithmeticOperand(right, options);
  if (a === null || b === null) {
    throw missingOperator(op, a === null ? left : right);
  }
  return arithmetic(op, a, b) as PSValue;
}

export function negateValue(value: PSValue, options: ConversionOptions = DESKTOP_CONVERSION): PSValue {
  if (typeof value === 'object' && value !== null && !isNumericLike(value)) {
    throw new PSConversionError(
      'System.Management.Automation.RuntimeException',
      `Method invocation failed because [${typeNameForMethod(value)}] does not contain a method named 'op_UnaryNegation'.`,
    );
  }
  const operand = arithmeticOperand(value, options);
  if (operand === null) throw conversionFailure(value, 'System.Int32', 'Input string was not in a correct format.');
  return negate(operand) as PSValue;
}

export function repeatString(text: string, count: number | PSNumber): string {
  const times = Number(typeof count === 'number' ? count : count.toNumber());
  if (times < 0) {
    throw new PSConversionError(
      'System.Management.Automation.RuntimeException',
      `Cannot convert value "${times}" to type "System.UInt32". Error: "Value was either too large or too small for a UInt32."`,
    );
  }
  return text.repeat(Math.trunc(times));
}

export function repeatArray(items: PSValue[], count: number | PSNumber): PSValue[] {
  const times = Math.trunc(Number(typeof count === 'number' ? count : count.toNumber()));
  const out: PSValue[] = [];
  for (let i = 0; i < times; i++) out.push(...items);
  return out;
}

export function multiply(left: PSValue, right: PSValue, options: ConversionOptions = DESKTOP_CONVERSION): PSValue {
  if (typeof left === 'string') {
    const count = arithmeticOperand(right, options);
    if (count === null) throw missingOperator('*', right);
    return repeatString(left, count);
  }
  if (Array.isArray(left)) {
    const count = arithmeticOperand(right, options);
    if (count === null) throw missingOperator('*', right);
    return repeatArray(left, count);
  }
  return numericArithmetic('*', left, right, options);
}

export function describeOperand(value: PSValue): string {
  return psValueToString(value);
}

export { compareNumbers, numericKindOf };

export type BitwiseOperator = '-band' | '-bor' | '-bxor' | '-shl' | '-shr';

function bitwiseOperand(value: PSValue): bigint | null {
  const operand = arithmeticOperand(value);
  if (operand === null) return null;
  if (typeof operand === 'number') return Number.isInteger(operand) ? BigInt(operand) : BigInt(Math.round(operand));
  return operand.kind === 'decimal' || operand.kind === 'double' || operand.kind === 'single'
    ? BigInt(Math.round(operand.toNumber()))
    : BigInt(operand.value);
}

function wideOperand(value: PSValue): boolean {
  const kind = numericKindOf(value);
  return kind === 'int64' || kind === 'uint64' || kind === 'uint32';
}

export function bitwise(op: BitwiseOperator, left: PSValue, right: PSValue): PSValue {
  const a = bitwiseOperand(left);
  const b = bitwiseOperand(right);
  if (a === null || b === null) throw missingOperator('*', a === null ? left : right);
  const wide = wideOperand(left) || wideOperand(right) || a > 2147483647n || a < -2147483648n;
  const bits = wide ? 64n : 32n;
  let result: bigint;
  switch (op) {
    case '-band': result = a & b; break;
    case '-bor': result = a | b; break;
    case '-bxor': result = a ^ b; break;
    case '-shl': result = a << (b & (bits - 1n)); break;
    default: result = a >> (b & (bits - 1n));
  }
  const wrapped = BigInt.asIntN(Number(bits), result);
  if (bits === 32n) return Number(wrapped);
  return arithmetic('+', boxInt64(wrapped), 0) as PSValue;
}

function boxInt64(value: bigint): PSNumber {
  return new PSNumber('int64', value);
}

export function bitwiseNot(value: PSValue): PSValue {
  const a = bitwiseOperand(value);
  if (a === null) throw missingOperator('*', value);
  const wide = wideOperand(value) || a > 2147483647n || a < -2147483648n;
  const result = BigInt.asIntN(wide ? 64 : 32, ~a);
  if (!wide) return Number(result);
  return arithmetic('+', boxInt64(result), 0) as PSValue;
}
