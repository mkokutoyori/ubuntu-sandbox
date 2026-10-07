import type { LdapFilter } from './LdapFilter';

function isSpace(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n';
}

function isAlpha(c: string | undefined): boolean {
  return c !== undefined && /^[A-Za-z]$/.test(c);
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && /^[0-9]$/.test(c);
}

function isLdh(c: string | undefined): boolean {
  return isAlpha(c) || isDigit(c) || c === '-';
}

function isHex(c: string | undefined): boolean {
  return c !== undefined && /^[0-9A-Fa-f]$/.test(c);
}

function hexValue(c: string | undefined): number {
  if (c === undefined) return -1;
  if (c >= '0' && c <= '9') return c.charCodeAt(0) - 48;
  if (c >= 'A' && c <= 'F') return c.charCodeAt(0) - 55;
  if (c >= 'a' && c <= 'f') return c.charCodeAt(0) - 87;
  return -1;
}

function isOid(text: string): boolean {
  if (isAlpha(text[0])) {
    for (let i = 1; i < text.length; i++) if (!isLdh(text[i])) return false;
    return true;
  }
  if (isDigit(text[0])) {
    let dot = 0;
    for (let i = 1; i < text.length; i++) {
      if (isDigit(text[i])) dot = 0;
      else if (text[i] === '.') {
        if (++dot > 1) return false;
      } else return false;
    }
    return dot === 0;
  }
  return false;
}

function optionsAreValid(text: string): boolean {
  let rest = text;
  for (;;) {
    if (!isLdh(rest[0])) return false;
    let i = 1;
    for (; i < rest.length; i++) {
      if (rest[i] === ';') break;
      if (!isLdh(rest[i])) return false;
    }
    if (i >= rest.length) return true;
    rest = rest.slice(i + 1);
  }
}

function isDesc(text: string): boolean {
  if (isAlpha(text[0])) {
    for (let i = 1; i < text.length; i++) {
      if (text[i] === ';') return optionsAreValid(text.slice(i + 1));
      if (!isLdh(text[i])) return false;
    }
    return true;
  }
  if (isDigit(text[0])) {
    let dot = 0;
    for (let i = 1; i < text.length; i++) {
      if (text[i] === ';') {
        if (dot !== 0) return false;
        return optionsAreValid(text.slice(i + 1));
      }
      if (isDigit(text[i])) dot = 0;
      else if (text[i] === '.') {
        if (++dot > 1) return false;
      } else return false;
    }
    return dot === 0;
  }
  return false;
}

function findRightParen(text: string, from: number): number {
  let balance = 1;
  let escape = false;
  let i = from;
  while (i < text.length && balance > 0) {
    if (!escape) {
      if (text[i] === '(') balance++;
      else if (text[i] === ')') balance--;
    }
    escape = text[i] === '\\' && !escape;
    if (balance > 0) i++;
  }
  return i < text.length ? i : -1;
}

function findWildcard(text: string, from: number): number | null {
  let i = from;
  for (; i < text.length; i++) {
    switch (text[i]) {
      case '*':
        return i;
      case '(':
      case ')':
        return null;
      case '\\':
        if (i + 1 >= text.length) return null;
        if (isHex(text[i + 1]) && isHex(text[i + 2])) {
          i += 2;
        } else {
          switch (text[i + 1]) {
            case '*':
            case '(':
            case ')':
            case '\\':
              i++;
              break;
            default:
              return null;
          }
        }
        break;
    }
  }
  return i;
}

function unescapeValue(text: string): string | null {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let v = 0; v < text.length; v++) {
    const c = text[v];
    if (c === '(' || c === ')' || c === '*') return null;
    if (c !== '\\') {
      const point = text.codePointAt(v)!;
      const width = point > 0xffff ? 2 : 1;
      for (const byte of encoder.encode(text.slice(v, v + width))) bytes.push(byte);
      v += width - 1;
      continue;
    }
    v++;
    if (v >= text.length) return null;
    const first = hexValue(text[v]);
    if (first >= 0) {
      const second = hexValue(text[v + 1]);
      if (second < 0) return null;
      bytes.push(first * 16 + second);
      v++;
    } else {
      switch (text[v]) {
        case '(': case ')': case '*': case '\\':
          bytes.push(text.charCodeAt(v));
          break;
        default:
          return null;
      }
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

export type FilterTrace = (line: string) => void;

function putSubstringFilter(attr: string, value: string, firstStar: number, trace?: FilterTrace): LdapFilter | null {
  trace?.(`put_substring_filter "${attr}=${value}"\n`);
  let initial: string | undefined;
  let final: string | undefined;
  const any: string[] = [];
  let gotStar = 0;
  let nextStar: number | null = firstStar;
  let from = 0;
  while (from < value.length) {
    if (gotStar > 0) nextStar = findWildcard(value, from);
    if (nextStar === null) return null;
    let kind: 'initial' | 'any' | 'final';
    let piece: string;
    if (nextStar >= value.length) {
      kind = 'final';
      piece = value.slice(from);
      from = value.length;
    } else {
      piece = value.slice(from, nextStar);
      from = nextStar + 1;
      kind = gotStar++ === 0 ? 'initial' : 'any';
    }
    if (piece !== '' || kind === 'any') {
      const bytes = unescapeValue(piece);
      if (bytes === null || bytes === '') return null;
      if (kind === 'initial') initial = bytes;
      else if (kind === 'final') final = bytes;
      else any.push(bytes);
    }
  }
  return { kind: 'substrings', attr, initial, any, final };
}

function putSimpleFilter(text: string, trace?: FilterTrace): LdapFilter | null {
  trace?.(`put_simple_filter: "${text}"\n`);
  if (text[0] === '=') return null;
  const equals = text.indexOf('=');
  if (equals < 0) return null;
  let head = text.slice(0, equals);
  const value = text.slice(equals + 1);
  const last = head[head.length - 1];

  if (last === ':') {
    head = head.slice(0, -1);
    let dnAttributes = false;
    let rule: string | null = null;
    let type = head;
    const firstColon = head.indexOf(':');
    if (firstColon >= 0) {
      type = head.slice(0, firstColon);
      const afterFirst = head.slice(firstColon + 1);
      const secondColon = afterFirst.indexOf(':');
      if (secondColon < 0) {
        if (afterFirst.toLowerCase() === 'dn') {
          if (!isDesc(type)) return null;
          dnAttributes = true;
          rule = '';
        } else {
          rule = afterFirst;
        }
      } else {
        const dn = afterFirst.slice(0, secondColon);
        rule = afterFirst.slice(secondColon + 1);
        if (dn.toLowerCase() !== 'dn') return null;
        dnAttributes = true;
      }
    }
    if (type === '' && (rule === null || rule === '')) return null;
    if (type !== '' && !isDesc(type)) return null;
    if (rule !== null && rule !== '' && !isOid(rule)) return null;
    const unescaped = unescapeValue(value);
    if (unescaped === null) return null;
    return {
      kind: 'extensibleMatch',
      matchingRule: rule !== null && rule !== '' ? rule : undefined,
      attr: type !== '' ? type : undefined,
      value: unescaped,
      dnAttributes,
    };
  }

  let kind: 'lessOrEqual' | 'greaterOrEqual' | 'approxMatch' | 'equalityMatch' | 'present' | 'substrings';
  switch (last) {
    case '<': kind = 'lessOrEqual'; head = head.slice(0, -1); break;
    case '>': kind = 'greaterOrEqual'; head = head.slice(0, -1); break;
    case '~': kind = 'approxMatch'; head = head.slice(0, -1); break;
    default: {
      if (!isDesc(head)) return null;
      const star = findWildcard(value, 0);
      if (star === null) return null;
      if (star >= value.length) kind = 'equalityMatch';
      else if (value === '*') kind = 'present';
      else return putSubstringFilter(head, value, star, trace);
    }
  }
  if (!isDesc(head)) return null;
  if (kind === 'present') return { kind: 'present', attr: head };
  const unescaped = unescapeValue(value);
  if (unescaped === null) return null;
  return { kind, attr: head, value: unescaped } as LdapFilter;
}

function putFilterList(text: string, notFilter: boolean, trace?: FilterTrace): LdapFilter[] | null {
  trace?.(`put_filter_list "${text}"\n`);
  const filters: LdapFilter[] = [];
  let at = 0;
  let next = -1;
  while (at < text.length) {
    while (at < text.length && isSpace(text[at])) at++;
    if (at >= text.length) break;
    const close = findRightParen(text, at + 1);
    if (close < 0) return null;
    next = close + 1;
    const child = putFilter(text.slice(at, next), trace);
    if (child === null) return null;
    filters.push(child);
    at = next;
    if (notFilter) break;
  }
  if (notFilter && (next < 0 || at < text.length)) return null;
  return filters;
}

function putComplexFilter(
  text: string, at: number, operator: '&' | '|' | '!', trace?: FilterTrace,
): { filter: LdapFilter; next: number } | null {
  const close = findRightParen(text, at + 1);
  if (close < 0) return null;
  const children = putFilterList(text.slice(at + 1, close), operator === '!', trace);
  if (children === null) return null;
  const filter: LdapFilter = operator === '&' ? { kind: 'and', filters: children }
    : operator === '|' ? { kind: 'or', filters: children }
    : { kind: 'not', filter: children[0] };
  return { filter, next: close + 1 };
}

export function putFilter(input: string, trace?: FilterTrace): LdapFilter | null {
  trace?.(`put_filter: "${input}"\n`);
  let at = 0;
  let parens = 0;
  let produced: LdapFilter | null = null;
  while (at < input.length) {
    const c = input[at];
    if (c === '(') {
      at++;
      parens++;
      while (isSpace(input[at])) at++;
      const op = input[at];
      if (op === '&' || op === '|' || op === '!') {
        trace?.(`put_filter: ${op === '&' ? 'AND' : op === '|' ? 'OR' : 'NOT'}\n`);
        const complex = putComplexFilter(input, at, op, trace);
        if (complex === null) return null;
        produced = complex.filter;
        at = complex.next;
        parens--;
      } else if (op === '(') {
        return null;
      } else {
        trace?.('put_filter: simple\n');
        let balance = 1;
        let escape = false;
        let next = at;
        while (next < input.length && balance > 0) {
          if (!escape) {
            if (input[next] === '(') balance++;
            else if (input[next] === ')') balance--;
          }
          escape = input[next] === '\\' && !escape;
          if (balance > 0) next++;
        }
        if (balance !== 0) return null;
        const simple = putSimpleFilter(input.slice(at, next), trace);
        if (simple === null) return null;
        produced = simple;
        at = next + 1;
        parens--;
      }
    } else if (c === ')') {
      trace?.('put_filter: end\n');
      at++;
      parens--;
    } else if (c === ' ') {
      at++;
    } else {
      trace?.('put_filter: default\n');
      const simple = putSimpleFilter(input.slice(at), trace);
      if (simple === null) return null;
      produced = simple;
      at = input.length;
    }
    if (parens === 0) break;
  }
  if (parens !== 0 || at < input.length) return null;
  return produced;
}

function putSimpleVrFilter(text: string, trace?: FilterTrace): LdapFilter | null {
  trace?.(`put_simple_vrFilter: "${text}"\n`);
  const equals = text.indexOf('=');
  if (equals < 0) return null;
  let head = text.slice(0, equals);
  const value = text.slice(equals + 1);
  const last = head[head.length - 1];

  if (last === ':') {
    head = head.slice(0, -1);
    let type = head;
    let rule = '';
    const colon = head.indexOf(':');
    if (colon < 0) {
      if (!isDesc(head)) return null;
    } else {
      type = head.slice(0, colon);
      rule = head.slice(colon + 1);
    }
    if (type === '' && rule === '') return null;
    if (type !== '' && !isDesc(type)) return null;
    if (rule !== '' && !isOid(rule)) return null;
    const unescaped = unescapeValue(value);
    if (unescaped === null) return null;
    return {
      kind: 'extensibleMatch',
      matchingRule: rule !== '' ? rule : undefined,
      attr: type !== '' ? type : undefined,
      value: unescaped,
      dnAttributes: false,
    };
  }

  let kind: 'lessOrEqual' | 'greaterOrEqual' | 'approxMatch' | 'equalityMatch' | 'present';
  switch (last) {
    case '<': kind = 'lessOrEqual'; head = head.slice(0, -1); break;
    case '>': kind = 'greaterOrEqual'; head = head.slice(0, -1); break;
    case '~': kind = 'approxMatch'; head = head.slice(0, -1); break;
    default: {
      if (!isDesc(head)) return null;
      const star = findWildcard(value, 0);
      if (star === null) return null;
      if (star >= value.length) kind = 'equalityMatch';
      else if (value === '*') kind = 'present';
      else return putSubstringFilter(head, value, star, trace);
    }
  }
  if (!isDesc(head)) return null;
  if (kind === 'present') return { kind: 'present', attr: head };
  const unescaped = unescapeValue(value);
  if (unescaped === null) return null;
  return { kind, attr: head, value: unescaped } as LdapFilter;
}

function putVrFilterList(text: string, into: LdapFilter[], trace?: FilterTrace): boolean {
  trace?.(`put_vrFilter_list "${text}"\n`);
  let at = 0;
  while (at < text.length) {
    while (at < text.length && isSpace(text[at])) at++;
    if (at >= text.length) break;
    const close = findRightParen(text, at + 1);
    if (close < 0) return false;
    if (!putVrFilterInto(text.slice(at, close + 1), into, trace)) return false;
    at = close + 1;
  }
  return true;
}

function putVrFilterInto(input: string, into: LdapFilter[], trace?: FilterTrace): boolean {
  trace?.(`put_vrFilter: "${input}"\n`);
  let at = 0;
  let parens = 0;
  while (at < input.length) {
    const c = input[at];
    if (c === '(') {
      at++;
      parens++;
      while (isSpace(input[at])) at++;
      if (input[at] === '(') {
        const close = findRightParen(input, at);
        if (close < 0) return false;
        if (!putVrFilterList(input.slice(at, close), into, trace)) return false;
        at = close + 1;
        parens--;
      } else {
        trace?.('put_vrFilter: simple\n');
        let balance = 1;
        let escape = false;
        let next = at;
        while (next < input.length && balance > 0) {
          if (!escape) {
            if (input[next] === '(') balance++;
            else if (input[next] === ')') balance--;
          }
          escape = input[next] === '\\' && !escape;
          if (balance > 0) next++;
        }
        if (balance !== 0) return false;
        const simple = putSimpleVrFilter(input.slice(at, next), trace);
        if (simple === null) return false;
        into.push(simple);
        at = next + 1;
        parens--;
      }
    } else if (c === ')') {
      trace?.('put_vrFilter: end\n');
      at++;
      parens--;
    } else if (c === ' ') {
      at++;
    } else {
      trace?.('put_vrFilter: default\n');
      const simple = putSimpleVrFilter(input.slice(at), trace);
      if (simple === null) return false;
      into.push(simple);
      at = input.length;
    }
  }
  return parens === 0;
}

export function putVrFilter(input: string, trace?: FilterTrace): LdapFilter[] | null {
  const items: LdapFilter[] = [];
  return putVrFilterInto(input, items, trace) ? items : null;
}

export function parseFilter(text: string): LdapFilter {
  const filter = putFilter(text);
  if (filter === null) throw new Error(`LdapFilter: malformed filter "${text}"`);
  return filter;
}

export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, c => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

export function formatFilter(f: LdapFilter): string {
  switch (f.kind) {
    case 'and': return `(&${f.filters.map(formatFilter).join('')})`;
    case 'or': return `(|${f.filters.map(formatFilter).join('')})`;
    case 'not': return `(!${formatFilter(f.filter)})`;
    case 'equalityMatch': return `(${f.attr}=${escapeFilterValue(f.value)})`;
    case 'greaterOrEqual': return `(${f.attr}>=${escapeFilterValue(f.value)})`;
    case 'lessOrEqual': return `(${f.attr}<=${escapeFilterValue(f.value)})`;
    case 'approxMatch': return `(${f.attr}~=${escapeFilterValue(f.value)})`;
    case 'present': return `(${f.attr}=*)`;
    case 'substrings': {
      const mid = f.any.map(a => `${escapeFilterValue(a)}*`).join('');
      return `(${f.attr}=${f.initial ? escapeFilterValue(f.initial) : ''}*${mid}${f.final ? escapeFilterValue(f.final) : ''})`;
    }
    case 'extensibleMatch': {
      const dn = f.dnAttributes ? ':dn' : '';
      const rule = f.matchingRule !== undefined ? `:${f.matchingRule}` : '';
      return `(${f.attr ?? ''}${dn}${rule}:=${escapeFilterValue(f.value)})`;
    }
  }
}
