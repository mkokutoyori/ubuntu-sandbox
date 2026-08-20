/**
 * LdapFilter — real LDAP search filters: RFC 4515 string syntax parser,
 * an AST, RFC 4511 §4.5.1 BER CHOICE encode/decode, and an evaluator
 * that matches the AST against a directory entry's attributes.
 */

import {
  type BerNode, parseTLV, parseAll,
  encodeContextPrimitiveString, encodeContextConstructed, encodeSequence,
  encodeOctetString, decodeOctetString,
} from './Ber';

export type LdapFilter =
  | { kind: 'and'; filters: LdapFilter[] }
  | { kind: 'or'; filters: LdapFilter[] }
  | { kind: 'not'; filter: LdapFilter }
  | { kind: 'equalityMatch'; attr: string; value: string }
  | { kind: 'substrings'; attr: string; initial?: string; any: string[]; final?: string }
  | { kind: 'greaterOrEqual'; attr: string; value: string }
  | { kind: 'lessOrEqual'; attr: string; value: string }
  | { kind: 'present'; attr: string }
  | { kind: 'approxMatch'; attr: string; value: string };

// ── RFC 4515 string parser ───────────────────────────────────────────────────

/** Unescape a filter value's `\XX` hex-pair escapes (RFC 4515 §3). */
function unescapeFilterValue(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      const hex = s.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 2; continue; }
    }
    out += s[i];
  }
  return out;
}

export function escapeFilterValue(s: string): string {
  return s.replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function parseFilterAt(s: string, pos: number): { filter: LdapFilter; next: number } {
  if (s[pos] !== '(') throw new Error(`LdapFilter: expected '(' at position ${pos} in "${s}"`);
  let i = pos + 1;
  const op = s[i];

  if (op === '&' || op === '|') {
    i++;
    const filters: LdapFilter[] = [];
    while (s[i] !== ')') {
      const r = parseFilterAt(s, i);
      filters.push(r.filter);
      i = r.next;
    }
    return { filter: { kind: op === '&' ? 'and' : 'or', filters }, next: i + 1 };
  }
  if (op === '!') {
    i++;
    const r = parseFilterAt(s, i);
    if (s[r.next] !== ')') throw new Error(`LdapFilter: expected ')' after NOT filter in "${s}"`);
    return { filter: { kind: 'not', filter: r.filter }, next: r.next + 1 };
  }

  // item: attr <op> value, terminated by the matching ')'
  const close = s.indexOf(')', i);
  if (close === -1) throw new Error(`LdapFilter: unterminated filter in "${s}"`);
  const body = s.slice(i, close);
  const item = parseFilterItem(body);
  return { filter: item, next: close + 1 };
}

function parseFilterItem(body: string): LdapFilter {
  const geIdx = body.indexOf('>=');
  const leIdx = body.indexOf('<=');
  const apIdx = body.indexOf('~=');
  if (geIdx !== -1) return { kind: 'greaterOrEqual', attr: body.slice(0, geIdx), value: unescapeFilterValue(body.slice(geIdx + 2)) };
  if (leIdx !== -1) return { kind: 'lessOrEqual', attr: body.slice(0, leIdx), value: unescapeFilterValue(body.slice(leIdx + 2)) };
  if (apIdx !== -1) return { kind: 'approxMatch', attr: body.slice(0, apIdx), value: unescapeFilterValue(body.slice(apIdx + 2)) };

  const eqIdx = body.indexOf('=');
  if (eqIdx === -1) throw new Error(`LdapFilter: malformed filter item "${body}"`);
  const attr = body.slice(0, eqIdx);
  const rawValue = body.slice(eqIdx + 1);

  if (rawValue === '*') return { kind: 'present', attr };
  if (rawValue.includes('*')) {
    const parts = rawValue.split('*').map(unescapeFilterValue);
    const initial = parts[0] !== '' ? parts[0] : undefined;
    const final = parts[parts.length - 1] !== '' ? parts[parts.length - 1] : undefined;
    const any = parts.slice(1, -1).filter(p => p !== '');
    return { kind: 'substrings', attr, initial, any, final };
  }
  return { kind: 'equalityMatch', attr, value: unescapeFilterValue(rawValue) };
}

/** Parse an RFC 4515 filter string, e.g. `(&(objectClass=user)(sAMAccountName=bob))`. */
export function parseFilter(s: string): LdapFilter {
  const trimmed = s.trim();
  const { filter, next } = parseFilterAt(trimmed, 0);
  if (next !== trimmed.length) throw new Error(`LdapFilter: trailing content after filter in "${s}"`);
  return filter;
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
  }
}

// ── BER CHOICE encode/decode (RFC 4511 §4.5.1) ───────────────────────────────

const FILTER_TAG = {
  and: 0, or: 1, not: 2, equalityMatch: 3, substrings: 4,
  greaterOrEqual: 5, lessOrEqual: 6, present: 7, approxMatch: 8,
} as const;

function encodeAVA(tagNumber: number, attr: string, value: string): Uint8Array {
  return encodeContextConstructed(tagNumber, [encodeOctetString(attr), encodeOctetString(value)]);
}

export function encodeFilter(f: LdapFilter): Uint8Array {
  switch (f.kind) {
    case 'and': return encodeContextConstructed(FILTER_TAG.and, f.filters.map(encodeFilter));
    case 'or': return encodeContextConstructed(FILTER_TAG.or, f.filters.map(encodeFilter));
    case 'not': return encodeContextConstructed(FILTER_TAG.not, [encodeFilter(f.filter)]);
    case 'equalityMatch': return encodeAVA(FILTER_TAG.equalityMatch, f.attr, f.value);
    case 'greaterOrEqual': return encodeAVA(FILTER_TAG.greaterOrEqual, f.attr, f.value);
    case 'lessOrEqual': return encodeAVA(FILTER_TAG.lessOrEqual, f.attr, f.value);
    case 'approxMatch': return encodeAVA(FILTER_TAG.approxMatch, f.attr, f.value);
    case 'present': return encodeContextPrimitiveString(FILTER_TAG.present, f.attr);
    case 'substrings': {
      const subs: Uint8Array[] = [];
      if (f.initial !== undefined) subs.push(encodeContextPrimitiveString(0, f.initial));
      for (const a of f.any) subs.push(encodeContextPrimitiveString(1, a));
      if (f.final !== undefined) subs.push(encodeContextPrimitiveString(2, f.final));
      // SubstringFilter ::= SEQUENCE { type OCTET STRING, substrings SEQUENCE OF CHOICE {...} }
      return encodeContextConstructed(FILTER_TAG.substrings, [
        encodeOctetString(f.attr),
        encodeSequence(subs),
      ]);
    }
  }
}

export function decodeFilter(node: BerNode): LdapFilter {
  const tag = node.tagNumber;
  if (tag === FILTER_TAG.and) return { kind: 'and', filters: parseAll(node.content).map(decodeFilter) };
  if (tag === FILTER_TAG.or) return { kind: 'or', filters: parseAll(node.content).map(decodeFilter) };
  if (tag === FILTER_TAG.not) return { kind: 'not', filter: decodeFilter(parseTLV(node.content, 0)) };
  if (tag === FILTER_TAG.present) return { kind: 'present', attr: decodeOctetString(node.content) };
  if (tag === FILTER_TAG.equalityMatch || tag === FILTER_TAG.greaterOrEqual
      || tag === FILTER_TAG.lessOrEqual || tag === FILTER_TAG.approxMatch) {
    const [attrNode, valueNode] = parseAll(node.content);
    const attr = decodeOctetString(attrNode.content);
    const value = decodeOctetString(valueNode.content);
    const kind = tag === FILTER_TAG.equalityMatch ? 'equalityMatch'
      : tag === FILTER_TAG.greaterOrEqual ? 'greaterOrEqual'
      : tag === FILTER_TAG.lessOrEqual ? 'lessOrEqual' : 'approxMatch';
    return { kind, attr, value } as LdapFilter;
  }
  if (tag === FILTER_TAG.substrings) {
    const [attrNode, subsNode] = parseAll(node.content);
    const attr = decodeOctetString(attrNode.content);
    let initial: string | undefined; let final: string | undefined; const any: string[] = [];
    for (const sub of parseAll(subsNode.content)) {
      const value = decodeOctetString(sub.content);
      if (sub.tagNumber === 0) initial = value;
      else if (sub.tagNumber === 1) any.push(value);
      else if (sub.tagNumber === 2) final = value;
    }
    return { kind: 'substrings', attr, initial, any, final };
  }
  throw new Error(`LdapFilter: unknown filter CHOICE tag ${tag}`);
}

// ── Evaluation against a directory entry ─────────────────────────────────────

export interface AttributeSource {
  /** Case-insensitive lookup of an attribute's values (may be multi-valued). */
  get(attr: string): string[] | undefined;
}

function matchesSubstring(value: string, f: Extract<LdapFilter, { kind: 'substrings' }>): boolean {
  const lower = value.toLowerCase();
  let pos = 0;
  if (f.initial !== undefined) {
    const needle = f.initial.toLowerCase();
    if (!lower.startsWith(needle)) return false;
    pos = needle.length;
  }
  for (const a of f.any) {
    const needle = a.toLowerCase();
    const idx = lower.indexOf(needle, pos);
    if (idx === -1) return false;
    pos = idx + needle.length;
  }
  if (f.final !== undefined) {
    const needle = f.final.toLowerCase();
    if (!lower.endsWith(needle)) return false;
    if (lower.length - needle.length < pos) return false;
  }
  return true;
}

export function evaluateFilter(f: LdapFilter, entry: AttributeSource): boolean {
  switch (f.kind) {
    case 'and': return f.filters.every(sub => evaluateFilter(sub, entry));
    case 'or': return f.filters.some(sub => evaluateFilter(sub, entry));
    case 'not': return !evaluateFilter(f.filter, entry);
    case 'present': return (entry.get(f.attr)?.length ?? 0) > 0;
    case 'equalityMatch': {
      const values = entry.get(f.attr) ?? [];
      return values.some(v => v.toLowerCase() === f.value.toLowerCase());
    }
    case 'approxMatch': {
      // No soundex/metaphone matching rule implemented — approxMatch
      // degrades to equality, which is a valid (if imprecise) LDAP server behaviour.
      const values = entry.get(f.attr) ?? [];
      return values.some(v => v.toLowerCase() === f.value.toLowerCase());
    }
    case 'greaterOrEqual': {
      const values = entry.get(f.attr) ?? [];
      return values.some(v => v.toLowerCase() >= f.value.toLowerCase());
    }
    case 'lessOrEqual': {
      const values = entry.get(f.attr) ?? [];
      return values.some(v => v.toLowerCase() <= f.value.toLowerCase());
    }
    case 'substrings': {
      const values = entry.get(f.attr) ?? [];
      return values.some(v => matchesSubstring(v, f));
    }
  }
}
