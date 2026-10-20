/**
 * RFC 6052 (docs/rfc/nat/rfc6052.txt): IPv4-embedded IPv6 addresses.
 *
 * Measured before the module existed: nothing in the repository could build or read an IPv4-embedded
 * address, so every case below failed to import (the 64:ff9b::/96 prefix existed only as a keyword
 * the FortiGate schema refused). The vectors are Tables 1 and 2 of section 2.4, the restriction is
 * section 3.1 (the Well-Known Prefix never carries a non-global IPv4 address), the reserved octet is
 * section 2.2 (bits 64 to 71 are zero). The witness cases pass whatever the implementation: they
 * prove the vectors are well formed (the round trip of the /96 form and the address parser agree).
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, IPv6Address } from '@/network/core/types';
import { Nat64Prefix, isGlobalIpv4 } from '@/network/nat/nat64/Nat64Prefix';

const V4 = new IPAddress('192.0.2.33');

const TABLE_1: ReadonlyArray<[string, string]> = [
  ['2001:db8::/32', '2001:db8:c000:221::'],
  ['2001:db8:100::/40', '2001:db8:1c0:2:21::'],
  ['2001:db8:122::/48', '2001:db8:122:c000:2:2100::'],
  ['2001:db8:122:300::/56', '2001:db8:122:3c0:0:221::'],
  ['2001:db8:122:344::/64', '2001:db8:122:344:c0:2:2100:0'],
  ['2001:db8:122:344::/96', '2001:db8:122:344::c000:221'],
];

describe('RFC 6052 section 2.4 Table 1: network-specific prefixes', () => {
  for (const [prefix, expected] of TABLE_1) {
    it(`${prefix} embeds 192.0.2.33 as ${expected} and reads it back`, () => {
      const p = Nat64Prefix.parse(prefix);
      const synthesized = p.synthesize(V4);
      expect(synthesized.equals(new IPv6Address(expected))).toBe(true);
      expect(p.extract(synthesized)?.toString()).toBe('192.0.2.33');
    });
  }
});

describe('RFC 6052 Table 2 and section 3.1: the Well-Known Prefix', () => {
  it('64:ff9b::/96 embeds a global address', () => {
    const wkp = Nat64Prefix.wellKnownPrefix();
    expect(wkp.synthesize(new IPAddress('8.8.4.4')).equals(new IPv6Address('64:ff9b::808:404'))).toBe(true);
    expect(wkp.extract(new IPv6Address('64:ff9b::808:404'))?.toString()).toBe('8.8.4.4');
  });

  it('refuses to represent RFC 1918, shared (RFC 6598), loopback, link-local and documentation addresses', () => {
    const wkp = Nat64Prefix.wellKnownPrefix();
    for (const v4 of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '192.0.2.1', '224.0.0.1']) {
      expect(() => wkp.synthesize(new IPAddress(v4))).toThrow(/non-global/);
    }
  });

  it('drops an address that embeds a non-global IPv4 under the Well-Known Prefix', () => {
    expect(Nat64Prefix.wellKnownPrefix().extract(new IPv6Address('64:ff9b::a01:203'))).toBeNull();
  });

  it('a network-specific prefix may carry a private address', () => {
    const p = Nat64Prefix.parse('2001:db8:122:344::/96');
    expect(p.extract(p.synthesize(new IPAddress('10.1.2.3')))?.toString()).toBe('10.1.2.3');
  });

  it('follows the Global column of the RFC 6890 registry: 6to4 relay anycast is global, protocol assignments are not', () => {
    expect(isGlobalIpv4(new IPAddress('192.88.99.1'))).toBe(true);
    expect(isGlobalIpv4(new IPAddress('192.0.0.8'))).toBe(false);
    expect(isGlobalIpv4(new IPAddress('255.255.255.255'))).toBe(false);
  });

  it('witness: global and non-global classification', () => {
    expect(isGlobalIpv4(new IPAddress('8.8.8.8'))).toBe(true);
    expect(isGlobalIpv4(new IPAddress('10.0.0.1'))).toBe(false);
  });
});

describe('RFC 6052 section 2.2: what a prefix may be', () => {
  it('accepts only the lengths 32, 40, 48, 56, 64 and 96', () => {
    for (const bad of ['2001:db8::/24', '2001:db8::/80', '2001:db8::/128']) expect(() => Nat64Prefix.parse(bad)).toThrow(/length/);
  });

  it('refuses bits set beyond the prefix and a /96 whose bits 64 to 71 are not zero', () => {
    expect(() => Nat64Prefix.parse('2001:db8:1::/32')).toThrow(/zero/);
    expect(() => Nat64Prefix.parse('2001:db8:0:0:ff00::/96')).toThrow(/64 to 71/);
  });

  it('recognises its own addresses and no others', () => {
    const p = Nat64Prefix.parse('2001:db8::/32');
    expect(p.contains(new IPv6Address('2001:db8:c000:221::'))).toBe(true);
    expect(p.extract(new IPv6Address('2001:db9::1'))).toBeNull();
  });
});
