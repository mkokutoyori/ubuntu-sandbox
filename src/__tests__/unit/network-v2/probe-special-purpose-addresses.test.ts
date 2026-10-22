/**
 * Probe: RFC 1918 / RFC 5737 / RFC 6890 address classification.
 * Authority: docs/rfc/addressing (RFC 6890 §2.2.2 tables 1-16, §2.2.3 for IPv6).
 * Before the fix 38 of the 40 cases fail (no isPrivate, isDocumentation,
 * specialPurpose, isGloballyForwardable, IPv6 registry); the two that pass
 * either way are the registry-invariant case (structural, reads the table
 * alone) and one that never calls a new method.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, IPv6Address } from '@/network/core/types';
import { IPV4_SPECIAL_PURPOSE_ENTRIES } from '@/network/core/SpecialPurposeRegistry';

const ip = (s: string) => new IPAddress(s);

describe('RFC 1918 private blocks', () => {
  it.each([
    ['10.0.0.0', true], ['10.255.255.255', true],
    ['172.15.255.255', false], ['172.16.0.0', true], ['172.31.255.255', true], ['172.32.0.0', false],
    ['192.167.255.255', false], ['192.168.0.0', true], ['192.168.255.255', true], ['192.169.0.0', false],
    ['11.0.0.0', false], ['9.255.255.255', false],
  ])('%s private=%s', (address, expected) => {
    expect(ip(address).isPrivate()).toBe(expected);
  });

  it('witness: a public address is neither private nor special', () => {
    expect(ip('8.8.8.8').isPrivate()).toBe(false);
    expect(ip('8.8.8.8').specialPurpose()).toBeNull();
    expect(ip('8.8.8.8').isGloballyForwardable()).toBe(true);
  });

  it('private addresses are forwardable but not global (RFC 6890 table 2)', () => {
    const entry = ip('10.1.2.3').specialPurpose()!;
    expect(entry).toMatchObject({ name: 'Private-Use', rfc: 'RFC1918', source: true, destination: true, forwardable: true, global: false });
    expect(ip('10.1.2.3').isGloballyForwardable()).toBe(false);
  });
});

describe('RFC 5737 documentation blocks', () => {
  it.each([
    ['192.0.2.0', true], ['192.0.2.255', true], ['192.0.1.255', false], ['192.0.3.0', false],
    ['198.51.100.7', true], ['198.51.99.255', false], ['198.51.101.0', false],
    ['203.0.113.200', true], ['203.0.112.255', false], ['203.0.114.0', false],
    ['128.66.0.1', false],
  ])('%s documentation=%s', (address, expected) => {
    expect(ip(address).isDocumentation()).toBe(expected);
  });

  it('documentation addresses are not valid as source or destination', () => {
    expect(ip('192.0.2.1').specialPurpose()).toMatchObject({ source: false, destination: false, forwardable: false, global: false });
    expect(ip('192.0.2.1').isGloballyForwardable()).toBe(false);
  });
});

describe('RFC 6890 registry', () => {
  it('longest prefix wins: 192.0.0.1 is DS-Lite, 192.0.0.8 is IETF Protocol Assignments', () => {
    expect(ip('192.0.0.1').specialPurpose()!.name).toBe('DS-Lite');
    expect(ip('192.0.0.8').specialPurpose()!.name).toBe('IETF Protocol Assignments');
  });

  it('6to4 relay anycast is global, hence not "reserved"', () => {
    expect(ip('192.88.99.1').specialPurpose()!.global).toBe(true);
    expect(ip('192.88.99.1').isReserved()).toBe(false);
  });

  it('witness: isReserved still covers loopback, class E and broadcast', () => {
    expect(ip('127.0.0.1').isReserved()).toBe(true);
    expect(ip('240.0.0.1').isReserved()).toBe(true);
    expect(ip('255.255.255.255').isReserved()).toBe(true);
    expect(ip('100.64.0.1').isReserved()).toBe(true);
  });

  it('limited broadcast is a destination only', () => {
    expect(ip('255.255.255.255').specialPurpose()).toMatchObject({ source: false, destination: true, forwardable: false });
  });

  it('link-local 169.254/16 is not forwardable and is reserved by protocol', () => {
    expect(ip('169.254.1.1').isLinkLocal()).toBe(true);
    expect(ip('169.253.255.255').isLinkLocal()).toBe(false);
    expect(ip('169.254.1.1').specialPurpose()).toMatchObject({ rfc: 'RFC3927', forwardable: false, reservedByProtocol: true });
  });

  it('every entry honours: Destination false implies Forwardable and Global false', () => {
    for (const e of IPV4_SPECIAL_PURPOSE_ENTRIES) {
      if (!e.destination) { expect(e.forwardable).toBe(false); expect(e.global).toBe(false); }
    }
  });
});

describe('IPv6 (RFC 3849, RFC 4291, RFC 6890)', () => {
  it.each([
    ['2001:db8::1', true], ['2001:db8:ffff::', true], ['2001:db7::', false], ['2001:db9::', false],
  ])('%s documentation=%s', (address, expected) => {
    expect(new IPv6Address(address).isDocumentation()).toBe(expected);
  });

  it('unique-local fc00::/7', () => {
    expect(new IPv6Address('fd12:3456::1').isUniqueLocal()).toBe(true);
    expect(new IPv6Address('fc00::1').isUniqueLocal()).toBe(true);
    expect(new IPv6Address('fe00::1').isUniqueLocal()).toBe(false);
  });

  it('longest prefix: 2001:db8::/32 beats 2001::/23, teredo is 2001::/32', () => {
    expect(new IPv6Address('2001:db8::1').specialPurpose()!.name).toBe('Documentation');
    expect(new IPv6Address('2001:0:1::').specialPurpose()!.name).toBe('TEREDO');
    expect(new IPv6Address('2001:1::').specialPurpose()!.name).toBe('IETF Protocol Assignments');
  });

  it('witness: a global unicast address is not special', () => {
    expect(new IPv6Address('2606:4700::1111').specialPurpose()).toBeNull();
  });

  it('::1 and :: and ::ffff:0:0/96', () => {
    expect(new IPv6Address('::1').specialPurpose()!.name).toBe('Loopback Address');
    expect(new IPv6Address('::').specialPurpose()!.name).toBe('Unspecified Address');
    expect(new IPv6Address('::ffff:1.2.3.4').specialPurpose()!.name).toBe('IPv4-mapped Address');
  });
});
