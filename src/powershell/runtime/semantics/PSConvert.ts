import {
  PSChar, PSNumber, boxAs, boxInteger, decimalFromText, fitsKind, integerValueOf, isIntegerKind,
  kindName, numericKindOf, toDouble, type IntegerKind, type NumericKind,
} from './PSNumber';

export class PSConversionError extends Error {
  constructor(readonly exceptionType: string, message: string) {
    super(message);
    this.name = 'PSConversionError';
  }
}

export interface ConversionOptions {
  readonly core: boolean;
}

export const DESKTOP_CONVERSION: ConversionOptions = { core: false };

const HEX = /^[+-]?0[xX][0-9a-fA-F]+$/;
const DECIMAL_INTEGER = /^[+-]?\d+$/;
const FLOAT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

export function parseNumericString(text: string): number | PSNumber | null {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  if (trimmed === 'Infinity' || trimmed === '+Infinity') return new PSNumber('double', Infinity);
  if (trimmed === '-Infinity') return new PSNumber('double', -Infinity);
  if (trimmed === 'NaN') return new PSNumber('double', NaN);
  if (HEX.test(trimmed)) {
    const negative = trimmed.startsWith('-');
    const digits = BigInt(trimmed.replace(/^[+-]/, ''));
    return integerLiteral(negative ? -digits : digits);
  }
  if (DECIMAL_INTEGER.test(trimmed)) return integerLiteral(BigInt(trimmed));
  if (FLOAT.test(trimmed)) return doubleResult(Number(trimmed));
  return null;
}

function integerLiteral(value: bigint): number | PSNumber {
  if (value >= -2147483648n && value <= 2147483647n) return Number(value);
  if (fitsKind('int64', value)) return boxInteger('int64', value);
  return new PSNumber('double', Number(value));
}

function doubleResult(value: number): number | PSNumber {
  return Number.isInteger(value) ? new PSNumber('double', value) : value;
}

function typeLabel(kind: NumericKind): string {
  return kindName(kind).fullName;
}

function overflowText(kind: NumericKind): string {
  const name = kindName(kind).name;
  return `Value was either too large or too small for ${/^[AEIOU]/i.test(name) ? 'an' : 'a'} ${name}.`;
}

export function formatValueForError(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value instanceof PSNumber || value instanceof PSChar) return value.toString();
  if (Array.isArray(value)) return value.map(formatValueForError).join(' ');
  return String(value);
}

export function conversionFailure(value: unknown, fullName: string, detail: string): PSConversionError {
  return new PSConversionError(
    'System.Management.Automation.PSInvalidCastException',
    `Cannot convert value "${formatValueForError(value)}" to type "${fullName}". Error: "${detail}"`,
  );
}

function badFormat(value: string, kind: NumericKind, options: ConversionOptions): PSConversionError {
  const detail = options.core
    ? `The input string '${value}' was not in a correct format.`
    : 'Input string was not in a correct format.';
  return conversionFailure(value, typeLabel(kind), detail);
}

export function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function numericSource(value: unknown): number | PSNumber | null {
  if (typeof value === 'number' || value instanceof PSNumber) return value;
  if (value instanceof PSChar) return value.code;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === null || value === undefined) return 0;
  return null;
}

export function castToNumeric(
  kind: NumericKind, value: unknown, options: ConversionOptions = DESKTOP_CONVERSION,
): number | PSNumber {
  if (kind === 'bigint' && typeof value === 'string' && DECIMAL_INTEGER.test(value.trim())) {
    return boxInteger('bigint', BigInt(value.trim()));
  }
  let source = numericSource(value);
  if (source === null && typeof value === 'string') {
    source = parseNumericString(value);
    if (source === null) throw badFormat(value, kind, options);
  }
  if (source === null) {
    throw conversionFailure(value, typeLabel(kind), `Cannot convert the "${formatValueForError(value)}" value of type "${describeType(value)}" to type "${typeLabel(kind)}".`);
  }
  if (isIntegerKind(kind)) return castToInteger(kind, source, value);
  if (kind === 'decimal') return castToDecimal(source, value);
  return boxAs(kind, source);
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return 'System.Object[]';
  if (value instanceof Date) return 'System.DateTime';
  if (typeof value === 'object' && value !== null) return 'System.Management.Automation.PSCustomObject';
  return typeof value === 'string' ? 'System.String' : 'System.Object';
}

function castToInteger(kind: IntegerKind, source: number | PSNumber, original: unknown): number | PSNumber {
  const sourceKind = numericKindOf(source) as NumericKind;
  let integer: bigint;
  if (sourceKind === 'double' || sourceKind === 'single') {
    const real = toDouble(source);
    if (!Number.isFinite(real)) throw overflowFailure(kind, original);
    integer = BigInt(roundHalfEven(real));
  } else {
    integer = integerValueOf(source);
  }
  if (!fitsKind(kind, integer)) throw overflowFailure(kind, original);
  return boxInteger(kind, integer);
}

function overflowFailure(kind: IntegerKind, original: unknown): PSConversionError {
  return conversionFailure(original, typeLabel(kind), overflowText(kind));
}

function castToDecimal(source: number | PSNumber, original: unknown): number | PSNumber {
  const kind = numericKindOf(source) as NumericKind;
  if ((kind === 'double' || kind === 'single') && !Number.isFinite(toDouble(source))) {
    throw conversionFailure(original, 'System.Decimal', overflowText('decimal'));
  }
  if (typeof original === 'string') {
    const parsed = decimalFromText(original.trim() === '' ? '0' : original);
    if (parsed !== null) return parsed;
  }
  return boxAs('decimal', source);
}

export function castToChar(value: unknown, options: ConversionOptions = DESKTOP_CONVERSION): PSChar {
  if (value instanceof PSChar) return value;
  if (value === null || value === undefined) return new PSChar(0);
  if (typeof value === 'string') {
    if (value.length !== 1) {
      throw conversionFailure(value, 'System.Char', options.core
        ? 'String must be exactly one character long.'
        : 'String must be exactly one character long.');
    }
    return new PSChar(value.charCodeAt(0));
  }
  if (typeof value === 'boolean') throw conversionFailure(value ? 'True' : 'False', 'System.Char', 'Unable to cast object of type \'System.Boolean\' to type \'System.IConvertible\'.');
  const numeric = numericSource(value);
  if (numeric === null) throw conversionFailure(value, 'System.Char', `Cannot convert the "${formatValueForError(value)}" value of type "${describeType(value)}" to type "System.Char".`);
  const kind = numericKindOf(numeric) as NumericKind;
  if (kind === 'double' || kind === 'single' || kind === 'decimal') {
    throw conversionFailure(formatValueForError(numeric), 'System.Char', `Cannot convert value "${formatValueForError(numeric)}" to type "System.Char".`);
  }
  const code = integerValueOf(numeric);
  if (code < 0n || code > 65535n) {
    throw conversionFailure(formatValueForError(numeric), 'System.Char', 'Value was either too large or too small for a character.');
  }
  return new PSChar(Number(code));
}

export function truthiness(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (value instanceof PSNumber) return value.kind === 'decimal' ? (value.value as bigint) !== 0n : Number(value.value) !== 0;
  if (value instanceof PSChar) return value.code !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) {
    if (value.length === 0) return false;
    if (value.length === 1) return Array.isArray(value[0]) ? value[0].length >= 1 : truthiness(value[0]);
    return true;
  }
  return true;
}
