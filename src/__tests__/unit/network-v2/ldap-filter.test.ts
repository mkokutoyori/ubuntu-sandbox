/**
 * Real LDAP filter tests: RFC 4515 string parsing, RFC 4511 §4.5.1 BER
 * CHOICE encode/decode round-trip, and evaluation against entries.
 */
import { describe, it, expect } from 'vitest';
import {
  parseFilter, formatFilter, encodeFilter, decodeFilter, evaluateFilter,
  type LdapFilter, type AttributeSource,
} from '@/network/devices/windows/server/ad/ldap/LdapFilter';
import { parseTLV } from '@/network/devices/windows/server/ad/ldap/Ber';

function entryOf(attrs: Record<string, string[]>): AttributeSource {
  const lower = new Map(Object.entries(attrs).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (attr) => lower.get(attr.toLowerCase()) };
}

describe('parseFilter — RFC 4515 string syntax', () => {
  it('parses a simple equality filter', () => {
    expect(parseFilter('(sAMAccountName=bob)')).toEqual({ kind: 'equalityMatch', attr: 'sAMAccountName', value: 'bob' });
  });

  it('parses a presence filter', () => {
    expect(parseFilter('(objectClass=*)')).toEqual({ kind: 'present', attr: 'objectClass' });
  });

  it('parses AND / OR / NOT', () => {
    expect(parseFilter('(&(objectClass=user)(sAMAccountName=bob))')).toEqual({
      kind: 'and',
      filters: [
        { kind: 'equalityMatch', attr: 'objectClass', value: 'user' },
        { kind: 'equalityMatch', attr: 'sAMAccountName', value: 'bob' },
      ],
    });
    expect(parseFilter('(|(cn=a)(cn=b))')).toEqual({
      kind: 'or', filters: [{ kind: 'equalityMatch', attr: 'cn', value: 'a' }, { kind: 'equalityMatch', attr: 'cn', value: 'b' }],
    });
    expect(parseFilter('(!(cn=a))')).toEqual({ kind: 'not', filter: { kind: 'equalityMatch', attr: 'cn', value: 'a' } });
  });

  it('parses nested boolean filters', () => {
    const f = parseFilter('(&(objectClass=user)(|(cn=bob)(cn=alice)))');
    expect(f.kind).toBe('and');
  });

  it('parses substring filters (initial/any/final)', () => {
    expect(parseFilter('(cn=bob*)')).toEqual({ kind: 'substrings', attr: 'cn', initial: 'bob', any: [], final: undefined });
    expect(parseFilter('(cn=*bob)')).toEqual({ kind: 'substrings', attr: 'cn', initial: undefined, any: [], final: 'bob' });
    expect(parseFilter('(cn=*bob*)')).toEqual({ kind: 'substrings', attr: 'cn', initial: undefined, any: ['bob'], final: undefined });
    expect(parseFilter('(cn=b*o*b)')).toEqual({ kind: 'substrings', attr: 'cn', initial: 'b', any: ['o'], final: 'b' });
  });

  it('parses >=, <=, ~=', () => {
    expect(parseFilter('(uidNumber>=1000)')).toEqual({ kind: 'greaterOrEqual', attr: 'uidNumber', value: '1000' });
    expect(parseFilter('(uidNumber<=2000)')).toEqual({ kind: 'lessOrEqual', attr: 'uidNumber', value: '2000' });
    expect(parseFilter('(cn~=bob)')).toEqual({ kind: 'approxMatch', attr: 'cn', value: 'bob' });
  });

  it('unescapes hex-pair values', () => {
    expect(parseFilter('(cn=Smith\\28Bob\\29)')).toEqual({ kind: 'equalityMatch', attr: 'cn', value: 'Smith(Bob)' });
  });

  it('round-trips via formatFilter for a representative set', () => {
    for (const s of ['(cn=bob)', '(&(a=1)(b=2))', '(|(a=1)(b=2))', '(!(a=1))', '(cn=*bob*)', '(cn=*)']) {
      expect(formatFilter(parseFilter(s))).toBe(s);
    }
  });
});

describe('encodeFilter / decodeFilter — BER CHOICE round-trip', () => {
  const cases: LdapFilter[] = [
    { kind: 'equalityMatch', attr: 'sAMAccountName', value: 'bob' },
    { kind: 'present', attr: 'objectClass' },
    { kind: 'greaterOrEqual', attr: 'x', value: '5' },
    { kind: 'lessOrEqual', attr: 'x', value: '5' },
    { kind: 'approxMatch', attr: 'cn', value: 'bob' },
    { kind: 'substrings', attr: 'cn', initial: 'b', any: ['o'], final: 'b' },
    { kind: 'substrings', attr: 'cn', any: ['mid'] },
    { kind: 'and', filters: [{ kind: 'equalityMatch', attr: 'a', value: '1' }, { kind: 'equalityMatch', attr: 'b', value: '2' }] },
    { kind: 'or', filters: [{ kind: 'equalityMatch', attr: 'a', value: '1' }] },
    { kind: 'not', filter: { kind: 'present', attr: 'a' } },
  ];
  for (const f of cases) {
    it(`round-trips ${JSON.stringify(f)}`, () => {
      const bytes = encodeFilter(f);
      const node = parseTLV(bytes, 0);
      expect(decodeFilter(node)).toEqual(f);
    });
  }

  it('round-trips a deeply nested filter', () => {
    const f: LdapFilter = parseFilter('(&(objectClass=user)(|(sAMAccountName=bob)(sAMAccountName=alice))(!(userAccountControl=2)))');
    const bytes = encodeFilter(f);
    expect(decodeFilter(parseTLV(bytes, 0))).toEqual(f);
  });
});

describe('evaluateFilter', () => {
  const bob = entryOf({ objectClass: ['user', 'top'], sAMAccountName: ['bob'], cn: ['Bob Smith'], uidNumber: ['1500'] });

  it('equalityMatch is case-insensitive', () => {
    expect(evaluateFilter(parseFilter('(sAMAccountName=BOB)'), bob)).toBe(true);
    expect(evaluateFilter(parseFilter('(sAMAccountName=eve)'), bob)).toBe(false);
  });

  it('present checks attribute existence', () => {
    expect(evaluateFilter(parseFilter('(mail=*)'), bob)).toBe(false);
    expect(evaluateFilter(parseFilter('(cn=*)'), bob)).toBe(true);
  });

  it('and / or / not compose correctly', () => {
    expect(evaluateFilter(parseFilter('(&(objectClass=user)(sAMAccountName=bob))'), bob)).toBe(true);
    expect(evaluateFilter(parseFilter('(&(objectClass=user)(sAMAccountName=eve))'), bob)).toBe(false);
    expect(evaluateFilter(parseFilter('(|(sAMAccountName=eve)(sAMAccountName=bob))'), bob)).toBe(true);
    expect(evaluateFilter(parseFilter('(!(sAMAccountName=eve))'), bob)).toBe(true);
  });

  it('multi-valued attribute matches if ANY value matches', () => {
    expect(evaluateFilter(parseFilter('(objectClass=top)'), bob)).toBe(true);
    expect(evaluateFilter(parseFilter('(objectClass=group)'), bob)).toBe(false);
  });

  it('substrings matches initial/any/final', () => {
    expect(evaluateFilter(parseFilter('(cn=Bob*)'), bob)).toBe(true);
    expect(evaluateFilter(parseFilter('(cn=*Smith)'), bob)).toBe(true);
    // "Bob Smith" contains "o" then, later, "m" — each `any` token just needs
    // to appear in sequence, not as one contiguous literal.
    expect(evaluateFilter(parseFilter('(cn=*o*m*)'), bob)).toBe(true);
    // "m" never appears before "o" — order matters.
    expect(evaluateFilter(parseFilter('(cn=*m*o*)'), bob)).toBe(false);
    expect(evaluateFilter(parseFilter('(cn=Alice*)'), bob)).toBe(false);
  });

  it('greaterOrEqual / lessOrEqual do lexicographic string comparison', () => {
    expect(evaluateFilter(parseFilter('(uidNumber>=1000)'), bob)).toBe(true); // "1500" >= "1000" lexicographically
    expect(evaluateFilter(parseFilter('(uidNumber<=1000)'), bob)).toBe(false);
  });
});
