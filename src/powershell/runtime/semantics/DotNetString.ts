import type { PSValue } from '../PSEnvironment';
import { PSChar } from './PSNumber';
import { PSEnumValue } from './PSEnum';
import { tagArray } from './PSTypes';
import { PSRuntimeError } from '../PSRuntimeError';

const METHOD_INVOCATION = 'System.Management.Automation.MethodInvocationException';

const IGNORE_CASE = new Set([1, 3, 5]);

function comparisonIgnoresCase(argument: PSValue | undefined): boolean {
  if (argument === undefined || argument === null) return false;
  if (typeof argument === 'boolean') return argument;
  if (argument instanceof PSEnumValue) return IGNORE_CASE.has(argument.numeric);
  if (typeof argument === 'string') return /ignorecase/i.test(argument);
  return IGNORE_CASE.has(Number(argument));
}

function textOf(value: PSValue): string {
  if (value instanceof PSChar) return value.toString();
  return value === null || value === undefined ? '' : String(value);
}

function fold(text: string, ignoreCase: boolean): string {
  return ignoreCase ? text.toLowerCase() : text;
}

function charSet(argument: PSValue): Set<string> {
  const items = Array.isArray(argument) ? argument : [argument];
  return new Set(items.map(textOf).join('').split(''));
}

function failing(method: string, argumentCount: number, message: string): never {
  throw new PSRuntimeError(`Exception calling "${method}" with "${argumentCount}" argument(s): "${message}"`, METHOD_INVOCATION);
}

function checked(method: string, args: readonly PSValue[], body: () => PSValue): PSValue {
  try {
    return body();
  } catch (error) {
    if (error instanceof RangeError) return failing(method, args.length, error.message);
    throw error;
  }
}

function trimWith(text: string, set: Set<string> | null, start: boolean, end: boolean): string {
  const trims = (ch: string): boolean => (set === null ? /\s/.test(ch) : set.has(ch));
  let from = 0;
  let to = text.length;
  if (start) while (from < to && trims(text[from])) from++;
  if (end) while (to > from && trims(text[to - 1])) to--;
  return text.slice(from, to);
}

function indexOfWith(text: string, needle: string, start: number, count: number, ignoreCase: boolean): number {
  const window = text.slice(start, start + count);
  const at = fold(window, ignoreCase).indexOf(fold(needle, ignoreCase));
  return at < 0 ? -1 : at + start;
}

function splitText(text: string, separators: PSValue, count: number | null, options: number): string[] {
  const list = separators === undefined || separators === null || (Array.isArray(separators) && separators.length === 0)
    ? null
    : (Array.isArray(separators) ? separators : [separators]).map(textOf);
  let pieces: string[];
  if (list === null) {
    pieces = text.split(/\s/);
  } else {
    const escaped = list.filter(item => item !== '').map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    pieces = escaped.length === 0 ? [text] : text.split(new RegExp(escaped.join('|')));
  }
  if (count !== null && count > 0 && pieces.length > count) {
    const separatorPattern = list === null ? /\s/ : new RegExp(list.filter(item => item !== '').map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
    const head: string[] = [];
    let rest = text;
    while (head.length < count - 1) {
      const match = separatorPattern.exec(rest);
      if (match === null) break;
      head.push(rest.slice(0, match.index));
      rest = rest.slice(match.index + match[0].length);
    }
    pieces = [...head, rest];
  }
  if ((options & 2) !== 0) pieces = pieces.map(piece => piece.trim());
  if ((options & 1) !== 0) pieces = pieces.filter(piece => piece !== '');
  return pieces;
}

function numberArg(value: PSValue | undefined, fallback: number): number {
  return value === undefined || value === null ? fallback : Number(value);
}

export function stringMember(s: string, member: string): PSValue | undefined {
  switch (member) {
    case 'length': return s.length;
    case 'toupper': case 'toupperinvariant': return () => s.toUpperCase();
    case 'tolower': case 'tolowerinvariant': return () => s.toLowerCase();
    case 'trim': return (chars?: PSValue) => trimWith(s, chars === undefined ? null : charSet(chars), true, true);
    case 'trimstart': return (chars?: PSValue) => trimWith(s, chars === undefined ? null : charSet(chars), true, false);
    case 'trimend': return (chars?: PSValue) => trimWith(s, chars === undefined ? null : charSet(chars), false, true);
    case 'contains': return (needle: PSValue, comparison?: PSValue) =>
      fold(s, comparisonIgnoresCase(comparison)).includes(fold(textOf(needle), comparisonIgnoresCase(comparison)));
    case 'startswith': return (prefix: PSValue, comparison?: PSValue) =>
      fold(s, comparisonIgnoresCase(comparison)).startsWith(fold(textOf(prefix), comparisonIgnoresCase(comparison)));
    case 'endswith': return (suffix: PSValue, comparison?: PSValue) =>
      fold(s, comparisonIgnoresCase(comparison)).endsWith(fold(textOf(suffix), comparisonIgnoresCase(comparison)));
    case 'replace': return (oldValue: PSValue, newValue?: PSValue, comparison?: PSValue) => {
      const needle = textOf(oldValue);
      if (needle === '') return failing('Replace', 2, 'String cannot be of zero length.\nParameter name: oldValue');
      const ignoreCase = comparisonIgnoresCase(comparison);
      const replacement = textOf(newValue);
      if (!ignoreCase) return s.split(needle).join(replacement);
      return s.replace(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), () => replacement);
    };
    case 'indexof': return (needle: PSValue, a?: PSValue, b?: PSValue, c?: PSValue) => {
      const ignoreCase = comparisonIgnoresCase([a, b, c].find(item => item instanceof PSEnumValue));
      const numbers = [a, b].filter(item => typeof item === 'number');
      const start = numberArg(numbers[0], 0);
      const count = numberArg(numbers[1], s.length - start);
      return checked('IndexOf', [needle], () => indexOfWith(s, textOf(needle), start, count, ignoreCase));
    };
    case 'lastindexof': return (needle: PSValue, comparison?: PSValue) => {
      const ignoreCase = comparisonIgnoresCase(comparison);
      return fold(s, ignoreCase).lastIndexOf(fold(textOf(needle), ignoreCase));
    };
    case 'indexofany': return (chars: PSValue) => {
      const set = charSet(chars);
      return [...s].findIndex(ch => set.has(ch));
    };
    case 'substring': return (start: PSValue, length?: PSValue) => {
      const from = Number(start);
      const args = length === undefined ? [start] : [start, length];
      if (from < 0 || from > s.length) return failing('Substring', args.length, 'startIndex cannot be larger than length of string.\nParameter name: startIndex');
      if (length !== undefined && (Number(length) < 0 || from + Number(length) > s.length)) {
        return failing('Substring', args.length, 'Index and length must refer to a location within the string.\nParameter name: length');
      }
      return length === undefined ? s.slice(from) : s.slice(from, from + Number(length));
    };
    case 'padleft': return (width: PSValue, pad?: PSValue) => s.padStart(Number(width), pad === undefined ? ' ' : textOf(pad));
    case 'padright': return (width: PSValue, pad?: PSValue) => s.padEnd(Number(width), pad === undefined ? ' ' : textOf(pad));
    case 'insert': return (index: PSValue, value: PSValue) => {
      const at = Number(index);
      if (at < 0 || at > s.length) return failing('Insert', 2, 'Index was out of range. Must be non-negative and less than or equal to the size of the collection.\nParameter name: startIndex');
      return s.slice(0, at) + textOf(value) + s.slice(at);
    };
    case 'remove': return (start: PSValue, length?: PSValue) => {
      const from = Number(start);
      if (from < 0 || from >= s.length) return failing('Remove', length === undefined ? 1 : 2, 'startIndex must be less than length of string.\nParameter name: startIndex');
      return length === undefined ? s.slice(0, from) : s.slice(0, from) + s.slice(from + Number(length));
    };
    case 'split': return (separators?: PSValue, a?: PSValue, b?: PSValue) => {
      const count = typeof a === 'number' ? a : null;
      const options = a instanceof PSEnumValue ? a.numeric : b instanceof PSEnumValue ? b.numeric : 0;
      return splitText(s, separators as PSValue, count, options);
    };
    case 'equals': return (other: PSValue, comparison?: PSValue) =>
      typeof other === 'string' && fold(s, comparisonIgnoresCase(comparison)) === fold(other, comparisonIgnoresCase(comparison));
    case 'compareto': return (other: PSValue) => {
      const text = textOf(other);
      return s === text ? 0 : new Intl.Collator('en-US', { sensitivity: 'variant', caseFirst: 'lower' }).compare(s, text);
    };
    case 'gethashcode': return () => {
      let hash = 5381;
      for (const ch of s) hash = ((hash << 5) + hash + ch.charCodeAt(0)) | 0;
      return hash;
    };
    case 'tochararray': return () => tagArray([...s].map(ch => new PSChar(ch.charCodeAt(0)) as PSValue), { kind: 'char' });
    case 'chars': return (index: PSValue) => {
      const at = Number(index);
      if (at < 0 || at >= s.length) return failing('Chars', 1, 'Index was outside the bounds of the array.');
      return new PSChar(s.charCodeAt(at));
    };
    case 'getenumerator': return Array.from(s);
    case 'tostring': return () => s;
    case 'normalize': return () => s.normalize();
    case 'isnormalized': return () => s === s.normalize();
    default: return undefined;
  }
}
