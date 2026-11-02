/*
 * Structure — the criteria of a Windows DNS policy, as [MS-DNSP] 3.1.8.2 and the Add-DnsServerResponseRateLimitingExceptionlist
 * page describe them: a text of comparators EQ and NE, each followed by its values ("EQ, America, Asia, NE, Europe", a final
 * comma allowed), at most one EQ and one NE, each with a value. The values after EQ are combined with OR, the values after NE
 * with AND of their negation, and the two expressions with the condition of the policy. A criterion that cannot be decided
 * does not hold. An FQDN value is a name, or a name under a wildcard that covers the name itself and everything below it; an
 * interface value is an IPv4 or IPv6 address. Discrimination (run on the tree before the change): every case falls, the
 * module did not exist.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, IPv6Address } from '@/network/core/types';
import {
  addressCriterionMatches, criterionText, evaluateCriterion, fqdnCriterionMatches, isValidCriterionAddress,
  isValidCriterionFqdn, parseCriterion, POLICY_CONDITIONS,
} from '@/network/devices/windows/server/dns/DnsPolicyCriteria';

describe('reading a criterion', () => {
  it.each([
    ['EQ,a,b,c', { equal: ['a', 'b', 'c'], different: [] }],
    ['NE,a,b,c,', { equal: [], different: ['a', 'b', 'c'] }],
    ['EQ, America, Asia, NE, Europe', { equal: ['America', 'Asia'], different: ['Europe'] }],
    ['NE,x,EQ,y', { equal: ['y'], different: ['x'] }],
    ['eq,a', { equal: ['a'], different: [] }],
    ['  Ne , a ,', { equal: [], different: ['a'] }],
    ['EQ,*.contoso.com', { equal: ['*.contoso.com'], different: [] }],
  ])('reads %j', (text, expected) => {
    expect(parseCriterion(text)).toEqual(expected);
  });

  it.each([
    [''],
    [','],
    ['a,b'],
    ['EQ'],
    ['EQ,'],
    ['EQ,a,NE'],
    ['EQ,a,NE,'],
    ['EQ,a,EQ,b'],
    ['NE,a,NE,b'],
    ['EQ,a,,b'],
    ['EQ,,a'],
    ['XX,a'],
    ['EQ,a,NE,b,EQ,c'],
    ['EQ,NE,a'],
    ['NE,EQ,a'],
  ])('refuses %j', text => {
    expect(parseCriterion(text)).toBeNull();
  });

  it('writes a criterion back with the comparators in capitals, EQ first, and the values trimmed', () => {
    expect(criterionText(parseCriterion('ne , Europe , eq , America , Asia ,')!)).toBe('EQ,America,Asia,NE,Europe');
    expect(criterionText(parseCriterion('EQ,a')!)).toBe('EQ,a');
    expect(criterionText(parseCriterion('NE,a')!)).toBe('NE,a');
  });

  it('names the two conditions', () => {
    expect(POLICY_CONDITIONS).toEqual(['AND', 'OR']);
  });
});

describe('deciding a criterion', () => {
  const holds = (text: string, condition: 'AND' | 'OR', ...present: string[]) =>
    evaluateCriterion(parseCriterion(text)!, condition, value => present.includes(value));

  it('holds for EQ when one of the values is present', () => {
    expect(holds('EQ,a,b', 'AND', 'b')).toBe(true);
    expect(holds('EQ,a,b', 'AND', 'c')).toBe(false);
    expect(holds('EQ,a,b', 'OR')).toBe(false);
  });

  it('holds for NE when none of the values is present', () => {
    expect(holds('NE,a,b', 'AND', 'c')).toBe(true);
    expect(holds('NE,a,b', 'AND')).toBe(true);
    expect(holds('NE,a,b', 'AND', 'a')).toBe(false);
    expect(holds('NE,a,b', 'OR', 'b')).toBe(false);
  });

  it.each([
    ['AND', ['a'], true],
    ['AND', ['a', 'z'], false],
    ['AND', ['q'], false],
    ['AND', ['z'], false],
    ['OR', ['a'], true],
    ['OR', ['a', 'z'], true],
    ['OR', ['q'], true],
    ['OR', ['z'], false],
  ] as const)('combines EQ,a,b with NE,z under %s when %j is present', (condition, present, expected) => {
    expect(evaluateCriterion(parseCriterion('EQ,a,b,NE,z')!, condition, value => present.includes(value as never))).toBe(expected);
  });

  it('does not hold when nothing is expressed', () => {
    expect(evaluateCriterion({ equal: [], different: [] }, 'AND', () => true)).toBe(false);
    expect(evaluateCriterion({ equal: [], different: [] }, 'OR', () => true)).toBe(false);
  });
});

describe('an FQDN value', () => {
  it.each(['a.contoso.com', '*.contoso.com', '*', 'contoso.com.', '_ldap._tcp.contoso.com', 'host'])('is valid: %s', value => {
    expect(isValidCriterionFqdn(value)).toBe(true);
  });

  it.each(['', 'a..b', '*.', 'a.*.b', 'x y', 'a*.b', `${'a'.repeat(64)}.com`, `${'a.'.repeat(130)}com`, '**'])('is not valid: %j', value => {
    expect(isValidCriterionFqdn(value)).toBe(false);
  });

  it.each([
    ['web.corp.test', 'web.corp.test', true],
    ['WEB.corp.TEST.', 'web.Corp.test', true],
    ['web.corp.test', 'www.corp.test', false],
    ['web.corp.test', 'a.web.corp.test', false],
    ['*.corp.test', 'corp.test', true],
    ['*.corp.test', 'web.corp.test', true],
    ['*.corp.test', 'a.b.web.corp.test', true],
    ['*.corp.test', 'Web.CORP.test.', true],
    ['*.corp.test', 'xcorp.test', false],
    ['*.corp.test', 'corp.test.evil', false],
    ['*.corp.test', 'other.test', false],
    ['*', 'anything.at.all', true],
  ])('%s against the name %s: %s', (value, name, expected) => {
    expect(fqdnCriterionMatches(value, name)).toBe(expected);
  });
});

describe('an interface value', () => {
  it.each(['10.0.0.3', '192.168.1.1', '2001:db8::1', '::1', 'fe80::1'])('is valid: %s', value => {
    expect(isValidCriterionAddress(value)).toBe(true);
  });

  it.each(['', 'hostname', '10.0.0', '10.0.0.256', '2001:db8::g', '10.0.0.1/24'])('is not valid: %j', value => {
    expect(isValidCriterionAddress(value)).toBe(false);
  });

  it('matches the address it names and no other', () => {
    expect(addressCriterionMatches('10.0.0.3', new IPAddress('10.0.0.3'))).toBe(true);
    expect(addressCriterionMatches('10.0.0.3', new IPAddress('10.0.0.4'))).toBe(false);
  });

  it('matches an IPv6 address however it is written', () => {
    expect(addressCriterionMatches('2001:db8::1', new IPv6Address('2001:0db8:0:0:0:0:0:1'))).toBe(true);
    expect(addressCriterionMatches('2001:db8::1', new IPv6Address('2001:db8::2'))).toBe(false);
  });

  it('never matches an address of the other family', () => {
    expect(addressCriterionMatches('10.0.0.3', new IPv6Address('::1'))).toBe(false);
    expect(addressCriterionMatches('::1', new IPAddress('10.0.0.3'))).toBe(false);
  });
});
