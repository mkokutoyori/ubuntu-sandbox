import { describe, it, expect } from 'vitest';
import { encodeRadiusPacket, decodeRadiusPacket, isRadiusDecodeError } from '@/network/radius/codec';
import type { RadiusPacket } from '@/network/radius/types';

/**
 * RFC 3162 — RADIUS extensions for IPv6 (§2.2 of PRD-RADIUS's non-objectives,
 * now in scope): NAS-IPv6-Address (95), Framed-Interface-Id (96),
 * Framed-IPv6-Prefix (97), Login-IPv6-Host (98), Framed-IPv6-Route (99),
 * Framed-IPv6-Pool (100). Pure codec round-trip — no new protocol logic.
 */
function roundTrip(packet: RadiusPacket): RadiusPacket {
  const bytes = encodeRadiusPacket(packet);
  const decoded = decodeRadiusPacket(bytes);
  if (isRadiusDecodeError(decoded)) throw new Error(decoded.error);
  return decoded;
}

describe('RADIUS IPv6 attributes (RFC 3162)', () => {
  it('round-trips NAS-IPv6-Address (95)', () => {
    const packet: RadiusPacket = {
      type: 'radius', code: 'access-request', identifier: 1,
      authenticator: '00'.repeat(16),
      attributes: [{ type: 'nas-ipv6-address', value: '2001:db8::1' }],
    };
    const decoded = roundTrip(packet);
    expect(decoded.attributes[0]).toEqual({ type: 'nas-ipv6-address', value: '2001:db8::1' });
  });

  it('round-trips Login-IPv6-Host (98)', () => {
    const packet: RadiusPacket = {
      type: 'radius', code: 'access-accept', identifier: 2,
      authenticator: '00'.repeat(16),
      attributes: [{ type: 'login-ipv6-host', value: 'fe80::1' }],
    };
    const decoded = roundTrip(packet);
    expect(decoded.attributes[0]).toEqual({ type: 'login-ipv6-host', value: 'fe80::1' });
  });

  it('round-trips Framed-Interface-Id (96)', () => {
    const packet: RadiusPacket = {
      type: 'radius', code: 'access-accept', identifier: 3,
      authenticator: '00'.repeat(16),
      attributes: [{ type: 'framed-interface-id', value: '0000:0000:0000:0001' }],
    };
    const decoded = roundTrip(packet);
    expect(decoded.attributes[0]).toEqual({ type: 'framed-interface-id', value: '0000:0000:0000:0001' });
  });

  it('round-trips Framed-IPv6-Prefix (97) with a /64', () => {
    const packet: RadiusPacket = {
      type: 'radius', code: 'access-accept', identifier: 4,
      authenticator: '00'.repeat(16),
      attributes: [{ type: 'framed-ipv6-prefix', value: '2001:db8:abcd:1234::/64' }],
    };
    const decoded = roundTrip(packet);
    expect(decoded.attributes[0]).toEqual({ type: 'framed-ipv6-prefix', value: '2001:db8:abcd:1234::/64' });
  });

  it('round-trips Framed-IPv6-Prefix (97) with a /128 (full address, no truncation)', () => {
    const packet: RadiusPacket = {
      type: 'radius', code: 'access-accept', identifier: 5,
      authenticator: '00'.repeat(16),
      attributes: [{ type: 'framed-ipv6-prefix', value: '2001:db8::abcd:1/128' }],
    };
    const decoded = roundTrip(packet);
    expect(decoded.attributes[0]).toEqual({ type: 'framed-ipv6-prefix', value: '2001:db8::abcd:1/128' });
  });

  it('round-trips Framed-IPv6-Route (99) and Framed-IPv6-Pool (100) as text', () => {
    const packet: RadiusPacket = {
      type: 'radius', code: 'access-accept', identifier: 6,
      authenticator: '00'.repeat(16),
      attributes: [
        { type: 'framed-ipv6-route', value: '2001:db8:cafe::/48' },
        { type: 'framed-ipv6-pool', value: 'v6-clients' },
      ],
    };
    const decoded = roundTrip(packet);
    expect(decoded.attributes).toEqual([
      { type: 'framed-ipv6-route', value: '2001:db8:cafe::/48' },
      { type: 'framed-ipv6-pool', value: 'v6-clients' },
    ]);
  });

  it('rejects an invalid Interface-Id at encode time', () => {
    const packet: RadiusPacket = {
      type: 'radius', code: 'access-accept', identifier: 7,
      authenticator: '00'.repeat(16),
      attributes: [{ type: 'framed-interface-id', value: 'not-an-ifid' }],
    };
    expect(() => encodeRadiusPacket(packet)).toThrow();
  });
});
