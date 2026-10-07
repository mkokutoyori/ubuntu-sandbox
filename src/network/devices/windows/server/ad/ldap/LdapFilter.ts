/**
 * LdapFilter — real LDAP search filters: RFC 4515 string syntax parser,
 * an AST, RFC 4511 §4.5.1 BER CHOICE encode/decode, and an evaluator
 * that matches the AST against a directory entry's attributes.
 */

import {
  type BerNode, parseTLV, parseAll,
  encodeContextPrimitive, encodeContextPrimitiveString, encodeContextConstructed, encodeSequence,
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
  | { kind: 'approxMatch'; attr: string; value: string }
  | { kind: 'extensibleMatch'; matchingRule?: string; attr?: string; value: string; dnAttributes: boolean };

export { parseFilter, formatFilter, escapeFilterValue } from './LdapFilterString';

// ── BER CHOICE encode/decode (RFC 4511 §4.5.1) ───────────────────────────────

const FILTER_TAG = {
  and: 0, or: 1, not: 2, equalityMatch: 3, substrings: 4,
  greaterOrEqual: 5, lessOrEqual: 6, present: 7, approxMatch: 8, extensibleMatch: 9,
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
    case 'extensibleMatch': {
      const parts: Uint8Array[] = [];
      if (f.matchingRule !== undefined) parts.push(encodeContextPrimitiveString(1, f.matchingRule));
      if (f.attr !== undefined) parts.push(encodeContextPrimitiveString(2, f.attr));
      parts.push(encodeContextPrimitiveString(3, f.value));
      if (f.dnAttributes) parts.push(encodeContextPrimitive(4, new Uint8Array([0xff])));
      return encodeContextConstructed(FILTER_TAG.extensibleMatch, parts);
    }
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
  if (tag === FILTER_TAG.extensibleMatch) {
    let matchingRule: string | undefined;
    let attr: string | undefined;
    let value = '';
    let dnAttributes = false;
    for (const part of parseAll(node.content)) {
      if (part.tagNumber === 1) matchingRule = decodeOctetString(part.content);
      else if (part.tagNumber === 2) attr = decodeOctetString(part.content);
      else if (part.tagNumber === 3) value = decodeOctetString(part.content);
      else if (part.tagNumber === 4) dnAttributes = part.content.length > 0 && part.content[0] !== 0;
    }
    return { kind: 'extensibleMatch', matchingRule, attr, value, dnAttributes };
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
  dnComponents?(): readonly { type: string; value: string }[];
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

export const MATCHING_RULE = {
  caseIgnoreMatch: '2.5.13.2',
  caseExactMatch: '2.5.13.5',
  bitAnd: '1.2.840.113556.1.4.803',
  bitOr: '1.2.840.113556.1.4.804',
} as const;

function bigIntOf(text: string): bigint | null {
  return /^\s*[+-]?\d+\s*$/.test(text) ? BigInt(text.trim()) : null;
}

function matchesExtensible(f: Extract<LdapFilter, { kind: 'extensibleMatch' }>, entry: AttributeSource): boolean {
  if (f.attr === undefined) return false;
  const wanted = f.attr.toLowerCase();
  const candidates = [...(entry.get(f.attr) ?? [])];
  if (f.dnAttributes) {
    for (const component of entry.dnComponents?.() ?? []) {
      if (component.type.toLowerCase() === wanted) candidates.push(component.value);
    }
  }
  const rule = f.matchingRule;
  if (rule === undefined || rule === MATCHING_RULE.caseIgnoreMatch || rule.toLowerCase() === 'caseignorematch') {
    return candidates.some(value => value.toLowerCase() === f.value.toLowerCase());
  }
  if (rule === MATCHING_RULE.caseExactMatch || rule.toLowerCase() === 'caseexactmatch') {
    return candidates.some(value => value === f.value);
  }
  const mask = bigIntOf(f.value);
  if (mask === null) return false;
  if (rule === MATCHING_RULE.bitAnd) {
    return candidates.some(value => {
      const bits = bigIntOf(value);
      return bits !== null && (bits & mask) === mask;
    });
  }
  if (rule === MATCHING_RULE.bitOr) {
    return candidates.some(value => {
      const bits = bigIntOf(value);
      return bits !== null && (bits & mask) !== 0n;
    });
  }
  return false;
}

export function evaluateFilter(f: LdapFilter, entry: AttributeSource): boolean {
  switch (f.kind) {
    case 'extensibleMatch': return matchesExtensible(f, entry);
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
