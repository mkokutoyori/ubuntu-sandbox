import { PSRuntimeError } from './PSRuntimeError';
import type { PSValue } from './PSEnvironment';

const INT32_MAX = 2_147_483_647;
const INT32_MIN = -2_147_483_648;
const INT64_LIMIT = 2 ** 63;
const SIGNIFICANT_DIGITS = 15;

interface Decimal {
  readonly digits: string;
  readonly exponent: number;
}

function decimalOf(abs: number): Decimal {
  if (abs === 0) return { digits: '0', exponent: 1 };
  const [mantissa, exp] = abs.toExponential(SIGNIFICANT_DIGITS - 1).split('e');
  const digits = mantissa.replace('.', '').replace(/0+$/, '') || '0';
  return { digits, exponent: Number(exp) + 1 };
}

function roundedAt(decimal: Decimal, decimals: number): { integer: string; fraction: string } {
  const { digits, exponent } = decimal;
  const integerDigits = exponent > 0 ? digits.slice(0, exponent).padEnd(exponent, '0') : '';
  const fractionDigits = exponent > 0 ? digits.slice(exponent) : '0'.repeat(-exponent) + digits;
  const kept = BigInt((integerDigits + fractionDigits.slice(0, decimals).padEnd(decimals, '0')) || '0');
  const roundUp = fractionDigits.length > decimals && fractionDigits[decimals] >= '5';
  const text = (roundUp ? kept + 1n : kept).toString().padStart(decimals + 1, '0');
  return { integer: text.slice(0, text.length - decimals), fraction: text.slice(text.length - decimals) };
}

function fixedParts(abs: number, decimals: number): { integer: string; fraction: string } {
  if (Number.isInteger(abs) && abs < 1e21) return { integer: BigInt(abs).toString(), fraction: '0'.repeat(decimals) };
  return roundedAt(decimalOf(abs), decimals);
}

function grouped(integer: string): string {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function scientific(abs: number, precision: number, letter: string, minimumExponentDigits: number): string {
  const [mantissa, exp] = abs.toExponential(precision).split('e');
  const exponent = Number(exp);
  const sign = exponent < 0 ? '-' : '+';
  return `${mantissa}${letter}${sign}${String(Math.abs(exponent)).padStart(minimumExponentDigits, '0')}`;
}

export function formatDouble(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value < 0 ? '-Infinity' : 'Infinity';
  if (Number.isInteger(value) && Math.abs(value) < INT64_LIMIT && Math.abs(value) >= 1e15) return BigInt(value).toString();
  return generalFormat(value, SIGNIFICANT_DIGITS);
}

function generalFormat(value: number, precision: number): string {
  if (value === 0) return '0';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const decimal = decimalOfPrecision(abs, precision);
  const exponent = decimal.exponent - 1;
  if (exponent >= precision || exponent < -4) {
    const mantissa = decimal.digits.length > 1 ? `${decimal.digits[0]}.${decimal.digits.slice(1)}` : decimal.digits;
    return `${sign}${mantissa}E${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  const { integer, fraction } = exponent >= 0
    ? { integer: decimal.digits.slice(0, exponent + 1).padEnd(exponent + 1, '0'), fraction: decimal.digits.slice(exponent + 1) }
    : { integer: '0', fraction: '0'.repeat(-exponent - 1) + decimal.digits };
  return `${sign}${integer}${fraction === '' ? '' : `.${fraction}`}`;
}

function decimalOfPrecision(abs: number, precision: number): Decimal {
  const [mantissa, exp] = abs.toExponential(Math.min(Math.max(precision, 1), 100) - 1).split('e');
  return { digits: mantissa.replace('.', '').replace(/0+$/, '') || '0', exponent: Number(exp) + 1 };
}

function invalidFormat(): never {
  throw new PSRuntimeError('Exception calling "ToString" with "1" argument(s): "Format specifier was invalid."');
}

function standardFormat(value: number, letter: string, precisionText: string): string {
  const upper = letter.toUpperCase();
  const precision = precisionText === '' ? undefined : Number(precisionText);
  const negative = value < 0;
  const abs = Math.abs(value);
  const sign = negative ? '-' : '';
  switch (upper) {
    case 'F': {
      const { integer, fraction } = fixedParts(abs, precision ?? 2);
      const body = fraction === '' ? integer : `${integer}.${fraction}`;
      return /^[0.]*$/.test(body) ? body : `${sign}${body}`;
    }
    case 'N': {
      const { integer, fraction } = fixedParts(abs, precision ?? 2);
      const body = `${grouped(integer)}${fraction === '' ? '' : `.${fraction}`}`;
      return /^[0.,]*$/.test(body) ? body : `${sign}${body}`;
    }
    case 'C': {
      const { integer, fraction } = fixedParts(abs, precision ?? 2);
      const body = `$${grouped(integer)}${fraction === '' ? '' : `.${fraction}`}`;
      return negative && !/^[$0.,]*$/.test(body) ? `(${body})` : body;
    }
    case 'P': {
      const { integer, fraction } = fixedParts(abs * 100, precision ?? 2);
      const body = `${grouped(integer)}${fraction === '' ? '' : `.${fraction}`}%`;
      return /^[0.,%]*$/.test(body) ? body : `${sign}${body}`;
    }
    case 'D': {
      if (!Number.isInteger(value)) invalidFormat();
      return `${sign}${BigInt(abs).toString().padStart(precision ?? 0, '0')}`;
    }
    case 'X': {
      if (!Number.isInteger(value)) invalidFormat();
      const unsigned = value < 0
        ? (value >= INT32_MIN ? BigInt(value) + (1n << 32n) : BigInt(value) + (1n << 64n))
        : BigInt(value);
      const text = unsigned.toString(16).padStart(precision ?? 0, '0');
      return letter === 'X' ? text.toUpperCase() : text;
    }
    case 'E': return `${sign}${scientific(abs, precision ?? 6, letter, 3)}`;
    case 'G': return precision === undefined || precision === 0 ? formatDouble(value) : generalFormat(value, precision);
    case 'R': return formatDouble(value);
    default: return invalidFormat();
  }
}

function splitSections(format: string): string[] {
  const sections: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (quote !== null) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === '\'' || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === '\\' && i + 1 < format.length) { current += ch + format[++i]; continue; }
    if (ch === ';') { sections.push(current); current = ''; continue; }
    current += ch;
  }
  sections.push(current);
  return sections;
}

function customFormat(value: number, format: string): string {
  const sections = splitSections(format);
  const negative = value < 0;
  let section = sections[0];
  let useSign = negative;
  if (value === 0 && sections.length >= 3) section = sections[2];
  else if (negative && sections.length >= 2) { section = sections[1]; useSign = false; }
  let abs = Math.abs(value);

  const tokens: Array<{ kind: 'lit' | 'digit'; text: string }> = [];
  let percent = 0;
  let quote: string | null = null;
  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    if (quote !== null) { if (ch === quote) quote = null; else tokens.push({ kind: 'lit', text: ch }); continue; }
    if (ch === '\'' || ch === '"') { quote = ch; continue; }
    if (ch === '\\' && i + 1 < section.length) { tokens.push({ kind: 'lit', text: section[++i] }); continue; }
    if (ch === '%') { percent++; tokens.push({ kind: 'lit', text: '%' }); continue; }
    if (ch === '0' || ch === '#' || ch === '.' || ch === ',') tokens.push({ kind: 'digit', text: ch });
    else tokens.push({ kind: 'lit', text: ch });
  }
  abs *= 100 ** percent;

  const pointIndex = tokens.findIndex((t) => t.kind === 'digit' && t.text === '.');
  const integerTokens = (pointIndex < 0 ? tokens : tokens.slice(0, pointIndex)).filter((t) => t.kind === 'digit');
  const fractionTokens = pointIndex < 0 ? [] : tokens.slice(pointIndex + 1).filter((t) => t.kind === 'digit' && t.text !== ',');
  const hasGrouping = integerTokens.some((t) => t.text === ',');
  const integerPlaces = integerTokens.filter((t) => t.text !== ',');
  const minimumInteger = integerPlaces.filter((t) => t.text === '0').length;
  const minimumFraction = fractionTokens.filter((t) => t.text === '0').length;

  const { integer, fraction } = fixedParts(abs, fractionTokens.length);
  const integerDigits = integer === '0' && minimumInteger === 0 ? '' : integer.padStart(minimumInteger, '0');
  const trimmedFraction = fraction.replace(/0+$/, '').padEnd(minimumFraction, '0');
  const integerText = hasGrouping ? grouped(integerDigits) : integerDigits;

  let out = '';
  let placed = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'lit') { out += token.text; continue; }
    if (token.text === ',') continue;
    if (token.text === '.') { if (trimmedFraction !== '') out += `.${trimmedFraction}`; continue; }
    const beforePoint = pointIndex < 0 || i < pointIndex;
    if (beforePoint && !placed) { out += integerText; placed = true; }
  }
  const body = integerText === '' && trimmedFraction === '' && placed === false ? '' : out;
  return useSign && !/^[^0-9]*$/.test(body) ? `-${body}` : body;
}

export function formatNumber(value: number, format: string | undefined): string {
  if (format === undefined || format === '') return formatDouble(value);
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value < 0 ? '-Infinity' : 'Infinity';
  const standard = /^([A-Za-z])(\d{0,2})$/.exec(format);
  if (standard !== null) return standardFormat(value, standard[1], standard[2]);
  return customFormat(value, format);
}

function typeOf(value: number): { name: string; fullName: string } {
  if (Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX) return { name: 'Int32', fullName: 'System.Int32' };
  if (Number.isInteger(value) && Math.abs(value) < INT64_LIMIT) return { name: 'Int64', fullName: 'System.Int64' };
  return { name: 'Double', fullName: 'System.Double' };
}

function typeObject(name: string, fullName: string): PSValue {
  const base = fullName === 'System.Boolean' || name === 'Double' || name === 'Int32' || name === 'Int64' ? 'System.ValueType' : 'System.Object';
  return {
    Name: name, FullName: fullName, Namespace: 'System', BaseType: base, IsPrimitive: true, IsValueType: true,
    toString: () => fullName,
  } as unknown as PSValue;
}

export function numberMember(value: number, member: string): PSValue {
  switch (member) {
    case 'tostring': return (format?: PSValue) => formatNumber(value, format === undefined || format === null ? undefined : String(format));
    case 'compareto': return (other: PSValue) => {
      const target = Number(other);
      return value < target ? -1 : value > target ? 1 : 0;
    };
    case 'equals': return (other: PSValue) => typeof other === 'number' && other === value;
    case 'gettype': return () => { const t = typeOf(value); return typeObject(t.name, t.fullName); };
    case 'gethashcode': return () => (Number.isInteger(value) ? value | 0 : Math.trunc(value * 1000003) | 0);
    default: return null;
  }
}

export function booleanMember(value: boolean, member: string): PSValue {
  switch (member) {
    case 'tostring': return () => (value ? 'True' : 'False');
    case 'equals': return (other: PSValue) => other === value;
    case 'compareto': return (other: PSValue) => (value === other ? 0 : value ? 1 : -1);
    case 'gettype': return () => typeObject('Boolean', 'System.Boolean');
    default: return null;
  }
}
