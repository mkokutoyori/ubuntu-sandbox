import { globToRegexSource } from '@/network/devices/linux/fs/Glob';
import type { Environment } from './Environment';

export class BashRuntimeError extends Error {}

export interface ParameterHost {
  readonly env: Environment;
  arithmetic(expression: string): string;
  operand(text: string): string;
  pattern(text: string): string;
  option(name: string): boolean;
}

export type ParameterResult =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[]; readonly star: boolean };

interface Reference {
  readonly name: string;
  readonly subscript?: string;
}

type Mode = 'plain' | 'length' | 'indirect' | 'keys' | 'prefix';

interface Parsed {
  readonly mode: Mode;
  readonly reference: Reference;
  readonly operation: string;
  readonly prefixStar?: boolean;
}

interface Fetched {
  readonly items: readonly string[];
  readonly list: boolean;
  readonly star: boolean;
  readonly set: boolean;
  readonly text: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*/;
const SPECIAL_PARAMETERS = '@*#?$!-';

function text(value: string): ParameterResult {
  return { kind: 'text', text: value };
}

function list(items: readonly string[], star: boolean): ParameterResult {
  return { kind: 'list', items, star };
}

function matchingBracket(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '[') depth++;
    else if (source[index] === ']' && --depth === 0) return index;
  }
  return -1;
}

function parseReference(source: string): { reference: Reference; rest: string } | null {
  const identifier = IDENTIFIER.exec(source);
  if (identifier !== null) {
    const name = identifier[0];
    let rest = source.slice(name.length);
    let subscript: string | undefined;
    if (rest[0] === '[') {
      const close = matchingBracket(rest, 0);
      if (close < 0) return null;
      subscript = rest.slice(1, close);
      rest = rest.slice(close + 1);
    }
    return { reference: { name, subscript }, rest };
  }
  const digits = /^[0-9]+/.exec(source);
  if (digits !== null) return { reference: { name: digits[0] }, rest: source.slice(digits[0].length) };
  if (source.length > 0 && SPECIAL_PARAMETERS.includes(source[0])) return { reference: { name: source[0] }, rest: source.slice(1) };
  return null;
}

function parseBody(body: string): Parsed {
  const bad = new BashRuntimeError(`\${${body}}: bad substitution`);
  if (body === '') throw bad;
  if (body[0] === '#' && body.length > 1) {
    const parsed = parseReference(body.slice(1));
    if (parsed !== null && parsed.rest === '') return { mode: 'length', reference: parsed.reference, operation: '' };
  }
  if (body[0] === '!' && body.length > 1) {
    const prefix = /^([A-Za-z_][A-Za-z0-9_]*)([*@])$/.exec(body.slice(1));
    if (prefix !== null) return { mode: 'prefix', reference: { name: prefix[1] }, operation: '', prefixStar: prefix[2] === '*' };
    const parsed = parseReference(body.slice(1));
    if (parsed !== null) {
      const { reference, rest } = parsed;
      if ((reference.subscript === '@' || reference.subscript === '*') && rest === '') return { mode: 'keys', reference, operation: '' };
      return { mode: 'indirect', reference, operation: rest };
    }
  }
  const parsed = parseReference(body);
  if (parsed === null) throw bad;
  return { mode: 'plain', reference: parsed.reference, operation: parsed.rest };
}

export function expandParameter(body: string, host: ParameterHost): ParameterResult {
  const parsed = parseBody(body);
  const { env } = host;
  switch (parsed.mode) {
    case 'prefix': {
      const names = env.namesWithPrefix(parsed.reference.name);
      return list(names, parsed.prefixStar === true);
    }
    case 'keys': {
      const { name } = parsed.reference;
      if (env.isAssoc(name)) return list(env.getAssocKeys(name), parsed.reference.subscript === '*');
      const array = env.getArray(name) ?? [];
      return list(array.map((_, index) => String(index)), parsed.reference.subscript === '*');
    }
    case 'length': {
      const fetched = fetch(parsed.reference, host);
      if (fetched.list) return text(String(fetched.items.length));
      return text(String(Array.from(fetched.text).length));
    }
    case 'indirect': {
      const target = fetch(parsed.reference, host);
      const resolved = parseReference(target.text);
      if (resolved === null || resolved.rest !== '') {
        if (!target.set && !host.option('nounset')) return text('');
        throw new BashRuntimeError(`${target.text}: invalid variable name`);
      }
      return apply(resolved.reference, parsed.operation, host);
    }
    default:
      return apply(parsed.reference, parsed.operation, host);
  }
}

function isPositionalList(reference: Reference): boolean {
  return reference.subscript === undefined && (reference.name === '@' || reference.name === '*');
}

function fetch(reference: Reference, host: ParameterHost): Fetched {
  const { env } = host;
  const { name, subscript } = reference;
  if (isPositionalList(reference)) {
    const items = env.getPositionalArgs();
    return { items, list: true, star: name === '*', set: items.length > 0, text: items.join(' ') };
  }
  if (subscript === '@' || subscript === '*') {
    const items = env.isAssoc(name) ? env.getAssocValues(name) : env.getArray(name) ?? scalarAsList(env, name);
    return { items, list: true, star: subscript === '*', set: items.length > 0, text: items.join(' ') };
  }
  if (subscript !== undefined) {
    const element = element$(reference, host);
    return { items: element === undefined ? [] : [element], list: false, star: false, set: element !== undefined, text: element ?? '' };
  }
  const array = env.getArray(name);
  const value = array !== undefined ? array[0] : env.get(name);
  return { items: value === undefined ? [] : [value], list: false, star: false, set: value !== undefined, text: value ?? '' };
}

function scalarAsList(env: Environment, name: string): string[] {
  const value = env.get(name);
  return value === undefined ? [] : [value];
}

function element$(reference: Reference, host: ParameterHost): string | undefined {
  const { env } = host;
  const { name } = reference;
  const subscript = reference.subscript as string;
  if (env.isAssoc(name)) return env.getAssocElement(name, host.operand(subscript));
  const index = Number(host.arithmetic(subscript));
  const array = env.getArray(name);
  if (array === undefined) return index === 0 ? env.get(name) : undefined;
  return array[index < 0 ? array.length + index : index];
}

function display(reference: Reference): string {
  return reference.subscript === undefined ? reference.name : `${reference.name}[${reference.subscript}]`;
}

function apply(reference: Reference, operation: string, host: ParameterHost): ParameterResult {
  const fetched = fetch(reference, host);
  if (operation === '') {
    if (!fetched.set && host.option('nounset') && !fetched.list && reference.name !== '?' && reference.name !== '$') {
      throw new BashRuntimeError(`${display(reference)}: unbound variable`);
    }
    return fetched.list ? list(fetched.items, fetched.star) : text(fetched.text);
  }
  const colon = operation[0] === ':';
  const head = colon ? operation[1] : operation[0];
  if ('-=?+'.includes(head ?? '') && head !== undefined && (!colon || operation.length > 1)) {
    return defaulting(reference, fetched, colon, head, operation.slice(colon ? 2 : 1), host);
  }
  if (!fetched.set && host.option('nounset') && !fetched.list) throw new BashRuntimeError(`${display(reference)}: unbound variable`);
  if (colon) return substring(reference, fetched, operation.slice(1), host);
  return transform(fetched, operation, host);
}

function defaulting(
  reference: Reference, fetched: Fetched, colon: boolean, kind: string, word: string, host: ParameterHost,
): ParameterResult {
  const missing = !fetched.set || (colon && fetched.items.join(' ') === '');
  const present = fetched.list ? list(fetched.items, fetched.star) : text(fetched.text);
  switch (kind) {
    case '-': return missing ? text(host.operand(word)) : present;
    case '+': return missing ? text('') : text(host.operand(word));
    case '=': {
      if (!missing) return present;
      if (fetched.list || !/^[A-Za-z_]/.test(reference.name)) throw new BashRuntimeError(`${display(reference)}: cannot assign in this way`);
      const value = host.operand(word);
      assign(reference, value, host);
      return text(value);
    }
    default:
      if (!missing) return present;
      throw new BashRuntimeError(`${display(reference)}: ${word === '' ? 'parameter null or not set' : host.operand(word)}`);
  }
}

function assign(reference: Reference, value: string, host: ParameterHost): void {
  const { env } = host;
  const { name, subscript } = reference;
  if (subscript === undefined) {
    env.set(name, value);
    return;
  }
  if (env.isAssoc(name)) {
    env.setAssocElement(name, host.operand(subscript), value);
    return;
  }
  const index = Number(host.arithmetic(subscript));
  const array = [...(env.getArray(name) ?? [])];
  while (array.length < index) array.push('');
  array[index] = value;
  env.setArray(name, array);
}

function splitSliceSpec(spec: string): { offset: string; length?: string } {
  let depth = 0;
  for (let index = 0; index < spec.length; index++) {
    const character = spec[index];
    if (character === '(' || character === '{') depth++;
    else if (character === ')' || character === '}') depth--;
    else if (character === ':' && depth === 0) return { offset: spec.slice(0, index), length: spec.slice(index + 1) };
  }
  return { offset: spec };
}

function substring(reference: Reference, fetched: Fetched, spec: string, host: ParameterHost): ParameterResult {
  const { offset: offsetText, length: lengthText } = splitSliceSpec(spec);
  const offset = Number(host.arithmetic(offsetText));
  const length = lengthText === undefined ? undefined : Number(host.arithmetic(lengthText));
  const positional = isPositionalList(reference);
  const source: readonly string[] = fetched.list
    ? (positional ? [host.env.get('0') ?? 'bash', ...fetched.items] : fetched.items)
    : Array.from(fetched.text);
  let start = offset < 0 ? source.length + offset : offset;
  if (positional && offset < 0) start = source.length + offset;
  if (start < 0 || start > source.length) return fetched.list ? list([], fetched.star) : text('');
  let end = source.length;
  if (length !== undefined) {
    end = length < 0 ? source.length + length : Math.min(source.length, start + length);
    if (end < start) throw new BashRuntimeError(`${length}: substring expression < 0`);
  }
  const slice = source.slice(start, end);
  return fetched.list ? list(slice, fetched.star) : text(slice.join(''));
}

function compile(pattern: string): RegExp {
  return new RegExp(`^(?:${globToRegexSource(pattern, true)})$`, 's');
}

function eachItem(fetched: Fetched, map: (value: string) => string): ParameterResult {
  return fetched.list ? list(fetched.items.map(map), fetched.star) : text(map(fetched.text));
}

function transform(fetched: Fetched, operation: string, host: ParameterHost): ParameterResult {
  const first = operation[0];
  if (first === '#' || first === '%') return strip(fetched, operation, host);
  if (first === '/') return replace(fetched, operation.slice(1), host);
  if (first === '^' || first === ',') return changeCase(fetched, operation, host);
  if (first === '@') return transformation(fetched, operation.slice(1), host);
  throw new BashRuntimeError(`\${${operation}}: bad substitution`);
}

function strip(fetched: Fetched, operation: string, host: ParameterHost): ParameterResult {
  const prefix = operation[0] === '#';
  const longest = operation[1] === operation[0];
  const pattern = host.pattern(operation.slice(longest ? 2 : 1));
  if (pattern === '') return eachItem(fetched, (value) => value);
  const matcher = compile(pattern);
  return eachItem(fetched, (value) => {
    const characters = Array.from(value);
    const order = [...characters.keys(), characters.length];
    const lengths = longest ? order.reverse() : order;
    for (const length of lengths) {
      const part = prefix ? characters.slice(0, length) : characters.slice(characters.length - length);
      if (matcher.test(part.join(''))) return (prefix ? characters.slice(length) : characters.slice(0, characters.length - length)).join('');
    }
    return value;
  });
}

function splitReplacement(body: string): { pattern: string; replacement: string } {
  for (let index = 0; index < body.length; index++) {
    if (body[index] === '\\') index++;
    else if (body[index] === '/') return { pattern: body.slice(0, index), replacement: body.slice(index + 1) };
  }
  return { pattern: body, replacement: '' };
}

function replace(fetched: Fetched, body: string, host: ParameterHost): ParameterResult {
  const all = body[0] === '/';
  const anchor = body[all ? 1 : 0] === '#' ? 'start' : body[all ? 1 : 0] === '%' ? 'end' : 'none';
  const rest = body.slice((all ? 1 : 0) + (anchor === 'none' ? 0 : 1));
  const { pattern: patternText, replacement: replacementText } = splitReplacement(rest);
  const pattern = host.pattern(patternText);
  if (pattern === '') return eachItem(fetched, (value) => value);
  const replacement = host.operand(replacementText);
  const ampersand = /(^|[^\\])&/.test(replacementText);
  const matcher = compile(pattern);
  const substitute = (matched: string): string => (ampersand ? replacement.replace(/&/g, matched) : replacement);
  return eachItem(fetched, (value) => {
    const characters = Array.from(value);
    let out = '';
    let index = 0;
    let replaced = false;
    while (index <= characters.length) {
      let matchedLength = -1;
      if (!(replaced && !all)) {
        for (let end = characters.length; end >= index; end--) {
          if (anchor === 'start' && index !== 0) break;
          if (anchor === 'end' && end !== characters.length) continue;
          if (end === index && anchor === 'none') continue;
          if (matcher.test(characters.slice(index, end).join(''))) { matchedLength = end - index; break; }
        }
      }
      if (matchedLength >= 0 && !(matchedLength === 0 && index === characters.length && anchor !== 'end')) {
        out += substitute(characters.slice(index, index + matchedLength).join(''));
        replaced = true;
        if (matchedLength === 0) {
          if (index < characters.length) out += characters[index];
          index++;
        } else {
          index += matchedLength;
        }
        if (!all) {
          out += characters.slice(index).join('');
          return out;
        }
        continue;
      }
      if (index < characters.length) out += characters[index];
      index++;
    }
    return out;
  });
}

function changeCase(fetched: Fetched, operation: string, host: ParameterHost): ParameterResult {
  const upper = operation[0] === '^';
  const everything = operation[1] === operation[0];
  const patternText = operation.slice(everything ? 2 : 1);
  const matcher = patternText === '' ? null : compile(host.pattern(patternText));
  const convert = (character: string): string => (matcher === null || matcher.test(character)
    ? (upper ? character.toUpperCase() : character.toLowerCase())
    : character);
  return eachItem(fetched, (value) => {
    const characters = Array.from(value);
    return everything ? characters.map(convert).join('') : (characters.length === 0 ? '' : convert(characters[0]) + characters.slice(1).join(''));
  });
}

function shellQuote(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    const escaped = value.replace(/[\\']/g, (c) => `\\${c}`).replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r')
      .replace(/[\x00-\x1f\x7f]/g, (c) => `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`);
    return `$'${escaped}'`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function unescape(value: string): string {
  return value.replace(/\\(n|t|r|\\|'|"|a|b|e|f|v|x[0-9a-fA-F]{1,2}|[0-7]{1,3})/g, (_, code: string) => {
    switch (code[0]) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case 'a': return '\x07';
      case 'b': return '\b';
      case 'e': return '\x1b';
      case 'f': return '\f';
      case 'v': return '\v';
      case 'x': return String.fromCharCode(parseInt(code.slice(1), 16));
      default: return /[0-7]/.test(code[0]) ? String.fromCharCode(parseInt(code, 8)) : code;
    }
  });
}

function transformation(fetched: Fetched, code: string, host: ParameterHost): ParameterResult {
  switch (code) {
    case 'Q': return eachItem(fetched, shellQuote);
    case 'E': return eachItem(fetched, unescape);
    case 'U': return eachItem(fetched, (value) => value.toUpperCase());
    case 'L': return eachItem(fetched, (value) => value.toLowerCase());
    case 'u': return eachItem(fetched, (value) => value.charAt(0).toUpperCase() + value.slice(1));
    case 'K':
    case 'k':
      return eachItem(fetched, shellQuote);
    case 'P':
    case 'a':
    case 'A':
      return eachItem(fetched, (value) => value);
    default:
      throw new BashRuntimeError(`\${@${code}}: bad substitution`);
  }
}
