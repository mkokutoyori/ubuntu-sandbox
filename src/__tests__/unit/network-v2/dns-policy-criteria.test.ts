/*
 * Structure — the criteria of a Windows DNS policy, as [MS-DNSP] 3.1.8.2 and the Add-DnsServerResponseRateLimitingExceptionlist
 * page describe them: a text of comparators EQ and NE, each followed by its values ("EQ, America, Asia, NE, Europe", a final
 * comma allowed), at most one EQ and one NE, each with a value. The values after EQ are combined with OR, the values after NE
 * with AND of their negation, and the two expressions with the condition of the policy. A criterion that cannot be decided
 * does not hold. An FQDN value is a name, or a name under a wildcard that covers the name itself and everything below it; an
 * interface value is an IPv4 or IPv6 address. The query resolution policies add the other four kinds: a query type is an IANA
 * mnemonic read case-insensitively, a transport is TCP or UDP, a family is IPv4 or IPv6, a time of day is a range hh:mm-hh:mm
 * (one or two digits for the hour, hours below 24, minutes below 60, the start not after the end) that holds at both of its
 * ends to the minute, read on the wall clock of the zone of the server; the groups of a criterion may be separated by ";" as
 * the Learn pages write them ("EQ,TXT,SRV;NE,MX"). Discrimination (run on the tree before the change): 96 of 175 cases fall.
 * The 79 that pass either way are NON-REGRESSION: the 76 cases of the grammar, the evaluation, the FQDN and the interface
 * values that existed, plus "reads EQ,10:00-12:00,22:00-23:00" (only commas) and the refusals of ";" and "EQ;" (the splitter
 * that read commas refused them too).
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, IPv6Address } from '@/network/core/types';
import {
  addressCriterionMatches, criterionText, evaluateCriterion, fqdnCriterionMatches, internetProtocolCriterionMatches,
  INTERNET_PROTOCOLS, isValidCriterionAddress, isValidCriterionFqdn, isValidCriterionInternetProtocol,
  isValidCriterionQueryType, isValidCriterionTimeRange, isValidCriterionTransport, minuteOfDay, parseCriterion,
  parseTimeRange, POLICY_CONDITIONS, queryTypeCriterionMatches, timeRangeCriterionMatches, TRANSPORT_PROTOCOLS,
  transportCriterionMatches,
} from '@/network/devices/windows/server/dns/DnsPolicyCriteria';
import { ZonedDate } from '@/network/core/time/ZonedDate';

describe('reading a criterion', () => {
  it.each([
    ['EQ,a,b,c', { equal: ['a', 'b', 'c'], different: [] }],
    ['NE,a,b,c,', { equal: [], different: ['a', 'b', 'c'] }],
    ['EQ, America, Asia, NE, Europe', { equal: ['America', 'Asia'], different: ['Europe'] }],
    ['NE,x,EQ,y', { equal: ['y'], different: ['x'] }],
    ['eq,a', { equal: ['a'], different: [] }],
    ['  Ne , a ,', { equal: [], different: ['a'] }],
    ['EQ,*.contoso.com', { equal: ['*.contoso.com'], different: [] }],
    ['EQ,TXT,SRV;NE,MX', { equal: ['TXT', 'SRV'], different: ['MX'] }],
    ['EQ,10:00-12:00,22:00-23:00', { equal: ['10:00-12:00', '22:00-23:00'], different: [] }],
    ['NE,a;EQ,b;', { equal: ['b'], different: ['a'] }],
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
    ['EQ,a;;NE,b'],
    [';'],
    ['EQ;'],
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

describe('a query type value', () => {
  it.each(['A', 'AAAA', 'TXT', 'srv', 'Mx', 'ANY', 'DNSKEY', 'CAA', 'SVCB'])('is valid: %s', value => {
    expect(isValidCriterionQueryType(value)).toBe(true);
  });

  it.each(['', 'ZORGLUB', '16', 'A B', 'TXT,SRV', '*', 'TYPE0'])('is not valid: %j', value => {
    expect(isValidCriterionQueryType(value)).toBe(false);
  });

  it.each([
    ['A', 1, true],
    ['a', 1, true],
    ['AAAA', 28, true],
    ['TXT', 16, true],
    ['txt', 16, true],
    ['SRV', 33, true],
    ['ANY', 255, true],
    ['TXT', 15, false],
    ['A', 28, false],
    ['MX', 0, false],
  ])('%s against the type %i: %s', (value, qtype, expected) => {
    expect(queryTypeCriterionMatches(value, qtype)).toBe(expected);
  });
});

describe('a transport protocol value', () => {
  it('names the two transports a DNS server listens on', () => {
    expect(TRANSPORT_PROTOCOLS).toEqual(['TCP', 'UDP']);
  });

  it.each(['TCP', 'UDP', 'tcp', 'Udp'])('is valid: %s', value => {
    expect(isValidCriterionTransport(value)).toBe(true);
  });

  it.each(['', 'ICMP', 'TCP,UDP', 'QUIC', 'T'])('is not valid: %j', value => {
    expect(isValidCriterionTransport(value)).toBe(false);
  });

  it.each([
    ['TCP', 'TCP', true],
    ['tcp', 'TCP', true],
    ['UDP', 'UDP', true],
    ['udp', 'UDP', true],
    ['TCP', 'UDP', false],
    ['UDP', 'TCP', false],
  ] as const)('%s against %s: %s', (value, transport, expected) => {
    expect(transportCriterionMatches(value, transport)).toBe(expected);
  });
});

describe('an internet protocol value', () => {
  it('names the two families', () => {
    expect(INTERNET_PROTOCOLS).toEqual(['IPv4', 'IPv6']);
  });

  it.each(['IPv4', 'IPv6', 'ipv4', 'IPV6'])('is valid: %s', value => {
    expect(isValidCriterionInternetProtocol(value)).toBe(true);
  });

  it.each(['', 'IP', 'IPv5', 'IPv4,IPv6', '4', 'v6'])('is not valid: %j', value => {
    expect(isValidCriterionInternetProtocol(value)).toBe(false);
  });

  it.each([
    ['IPv4', 'IPv4', true],
    ['ipv4', 'IPv4', true],
    ['IPv6', 'IPv6', true],
    ['IPV6', 'IPv6', true],
    ['IPv4', 'IPv6', false],
    ['IPv6', 'IPv4', false],
  ] as const)('%s against %s: %s', (value, protocol, expected) => {
    expect(internetProtocolCriterionMatches(value, protocol)).toBe(expected);
  });
});

describe('a time of day value', () => {
  it.each([
    ['10:00-12:00', { startMinute: 600, endMinute: 720 }],
    ['9:05-17:30', { startMinute: 545, endMinute: 1050 }],
    ['00:00-23:59', { startMinute: 0, endMinute: 1439 }],
    ['12:30-12:30', { startMinute: 750, endMinute: 750 }],
    ['22:00-23:00', { startMinute: 1320, endMinute: 1380 }],
  ])('reads %s', (value, expected) => {
    expect(parseTimeRange(value)).toEqual(expected);
  });

  it.each([
    [''],
    ['10:00'],
    ['10:00-'],
    ['-12:00'],
    ['10-12'],
    ['1000-1200'],
    ['10:00-12'],
    ['10:00-12:00-14:00'],
    ['10:00 - 12:00'],
    ['24:00-24:30'],
    ['10:00-25:00'],
    ['10:60-11:00'],
    ['10:00-11:60'],
    ['10:0-11:00'],
    ['12:00-10:00'],
    ['10:01-10:00'],
    ['ab:cd-ef:gh'],
  ])('refuses %j', value => {
    expect(parseTimeRange(value)).toBeNull();
    expect(isValidCriterionTimeRange(value)).toBe(false);
  });

  it('accepts what it reads', () => {
    expect(isValidCriterionTimeRange('10:00-12:00')).toBe(true);
  });

  it.each([
    ['10:00-12:00', 9 * 60 + 59, false],
    ['10:00-12:00', 10 * 60, true],
    ['10:00-12:00', 11 * 60, true],
    ['10:00-12:00', 12 * 60, true],
    ['10:00-12:00', 12 * 60 + 1, false],
    ['12:30-12:30', 12 * 60 + 30, true],
    ['12:30-12:30', 12 * 60 + 31, false],
    ['00:00-23:59', 0, true],
    ['00:00-23:59', 23 * 60 + 59, true],
    ['not a range', 11 * 60, false],
  ])('%s holds at minute %i: %s', (value, minute, expected) => {
    expect(timeRangeCriterionMatches(value, minute)).toBe(expected);
  });

  it('counts the minutes of the wall clock of the zone, not of the machine running the simulation', () => {
    const instant = Date.UTC(2024, 5, 3, 22, 30, 0);
    expect(minuteOfDay(ZonedDate.in(instant, 'UTC'))).toBe(22 * 60 + 30);
    expect(minuteOfDay(ZonedDate.in(instant, 'Asia/Tokyo'))).toBe(7 * 60 + 30);
    expect(minuteOfDay(ZonedDate.in(instant, 'America/New_York'))).toBe(18 * 60 + 30);
    expect(minuteOfDay(ZonedDate.in(instant, 'Europe/Paris'))).toBe(0 * 60 + 30);
  });
});
