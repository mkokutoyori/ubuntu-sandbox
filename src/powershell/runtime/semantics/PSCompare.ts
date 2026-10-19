import { PSEnumValue } from './PSEnum';
import { PSChar, PSNumber, compareNumbers, type NumericKind, numericKindOf } from './PSNumber';
import { castToNumeric, parseNumericString, truthiness, PSConversionError } from './PSConvert';
import { psValueToString } from '../PSExpansion';
import { isTimeSpan } from '../dotnetTimeSpan';
import type { PSValue } from '../PSEnvironment';

export interface CompareContext {
  readonly toDate: (text: string) => Date | null;
}

const collators = new Map<string, Intl.Collator>();

function collator(ignoreCase: boolean): Intl.Collator {
  const key = ignoreCase ? 'i' : 's';
  let cached = collators.get(key);
  if (cached === undefined) {
    cached = new Intl.Collator('en-US', { sensitivity: ignoreCase ? 'accent' : 'variant', caseFirst: 'lower' });
    collators.set(key, cached);
  }
  return cached;
}

export function compareStrings(a: string, b: string, ignoreCase: boolean): number {
  return collator(ignoreCase).compare(a, b);
}

function isNumber(value: PSValue): value is number | PSNumber {
  return typeof value === 'number' || value instanceof PSNumber;
}

function numberOf(value: PSValue): number | PSNumber | null {
  if (isNumber(value)) return value;
  if (value instanceof PSChar) return value.code;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return parseNumericString(value);
  return null;
}

export function languageEquals(
  first: PSValue, second: PSValue, ignoreCase: boolean, context: CompareContext,
): boolean {
  if (first === null || first === undefined) return second === null || second === undefined;
  if (second === null || second === undefined) return false;
  if (first instanceof PSEnumValue && typeof second === 'string') {
    return languageEquals(first, first.definition.parse(second), ignoreCase, context);
  }
  if (typeof first === 'string') {
    const text = typeof second === 'string' ? second : psValueToString(second);
    return ignoreCase ? collator(true).compare(first, text) === 0 : first === text;
  }
  if (isNumber(first)) {
    const other = numberOf(second);
    return other !== null && compareNumbers(first, other) === 0;
  }
  if (first instanceof PSChar) {
    if (second instanceof PSChar || (typeof second === 'string' && second.length === 1)) {
      const code = second instanceof PSChar ? second.code : (second as string).charCodeAt(0);
      if (ignoreCase) return String.fromCharCode(first.code).toUpperCase() === String.fromCharCode(code).toUpperCase();
      return first.code === code;
    }
    const other = numberOf(second);
    return other !== null && compareNumbers(first.code, other) === 0;
  }
  if (typeof first === 'boolean') return first === truthiness(second);
  if (first instanceof Date) {
    const other = second instanceof Date ? second : typeof second === 'string' ? context.toDate(second) : null;
    return other !== null && first.getTime() === other.getTime();
  }
  if (typeof first === 'object' && typeof second === 'object' && isTimeSpan(first as Record<string, PSValue>) && isTimeSpan(second as Record<string, PSValue>)) {
    return (first as Record<string, PSValue>).TotalMilliseconds === (second as Record<string, PSValue>).TotalMilliseconds;
  }
  return first === second;
}

function notComparable(value: PSValue): PSConversionError {
  return new PSConversionError(
    'System.Management.Automation.RuntimeException',
    `Cannot compare "${psValueToString(value)}" because it is not IComparable.`,
  );
}

export function languageCompare(
  first: PSValue, second: PSValue, ignoreCase: boolean, context: CompareContext,
): number {
  if (first === null || first === undefined) {
    if (second === null || second === undefined) return 0;
    return isNumber(second) ? (compareNumbers(second, 0) < 0 ? 1 : -1) : -1;
  }
  if (second === null || second === undefined) {
    return isNumber(first) ? (compareNumbers(first, 0) < 0 ? -1 : 1) : 1;
  }
  if (first instanceof PSEnumValue && typeof second === 'string') {
    return languageCompare(first, first.definition.parse(second), ignoreCase, context);
  }
  if (typeof first === 'string') {
    const text = typeof second === 'string' ? second : psValueToString(second);
    return compareStrings(first, text, ignoreCase);
  }
  if (isNumber(first)) {
    const other = typeof second === 'string' ? castToNumeric('double', second) : numberOf(second);
    if (other === null) throw notComparable(second);
    return compareNumbers(first, typeof second === 'string' ? castToNumeric(numericKindOf(first) as NumericKind, second) : other);
  }
  if (first instanceof PSChar) {
    if (typeof second === 'string' && second.length === 1) return compareStrings(String.fromCharCode(first.code), second, ignoreCase);
    const other = numberOf(second instanceof PSChar ? second.code : second);
    if (other === null) throw notComparable(second);
    return compareNumbers(first.code, other);
  }
  if (typeof first === 'boolean') {
    const other = truthiness(second);
    return first === other ? 0 : first ? 1 : -1;
  }
  if (first instanceof Date) {
    const other = second instanceof Date ? second : typeof second === 'string' ? context.toDate(second) : null;
    if (other === null) throw notComparable(second);
    return first.getTime() < other.getTime() ? -1 : first.getTime() > other.getTime() ? 1 : 0;
  }
  if (typeof first === 'object' && typeof second === 'object'
      && isTimeSpan(first as Record<string, PSValue>) && isTimeSpan(second as Record<string, PSValue>)) {
    const a = (first as Record<string, PSValue>).TotalMilliseconds as number;
    const b = (second as Record<string, PSValue>).TotalMilliseconds as number;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  throw notComparable(first);
}
