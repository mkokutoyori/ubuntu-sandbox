/**
 * PRD-QUIC.md §5 P1 — varints (RFC 9000 §16) and packet format (§17):
 * long header (Initial/0-RTT/Handshake/Retry), short header, and Version
 * Negotiation. Purely additive, no network, no protection (that's P3).
 */
import { describe, it, expect } from 'vitest';
import { encodeVarint, decodeVarint } from '@/network/quic/varint';
import {
  encodeLongHeader, decodeLongHeader,
  encodeShortHeader, decodeShortHeader,
  encodeVersionNegotiation, decodeVersionNegotiation,
  decodePacket, determinePacketNumberLength,
} from '@/network/quic/packetFormat';
import { QUIC_VERSION_1, type QuicLongHeaderPacket, type QuicShortHeaderPacket } from '@/network/quic/types';

describe('varint (RFC 9000 §16)', () => {
  it('round-trips a 1-byte value (< 64)', () => {
    const bytes = encodeVarint(37);
    expect(bytes.length).toBe(1);
    expect(decodeVarint(bytes)).toEqual({ value: 37, bytesConsumed: 1 });
  });

  it('round-trips a 2-byte value (< 16384)', () => {
    const bytes = encodeVarint(15293);
    expect(bytes.length).toBe(2);
    expect(decodeVarint(bytes)).toEqual({ value: 15293, bytesConsumed: 2 });
  });

  it('round-trips a 4-byte value (< 2^30)', () => {
    const bytes = encodeVarint(494878333);
    expect(bytes.length).toBe(4);
    expect(decodeVarint(bytes).value).toBe(494878333);
  });

  it('round-trips an 8-byte value (>= 2^30)', () => {
    const bytes = encodeVarint(1073741824);
    expect(bytes.length).toBe(8);
    expect(decodeVarint(bytes).value).toBe(1073741824);
  });

  it('matches the RFC 9000 §16 worked example (37 -> single byte 0x25)', () => {
    expect(Array.from(encodeVarint(37))).toEqual([0x25]);
  });

  it('round-trips the boundary values at each length transition', () => {
    for (const v of [0, 63, 64, 16383, 16384, 1073741823, 1073741824]) {
      const bytes = encodeVarint(v);
      expect(decodeVarint(bytes).value).toBe(v);
    }
  });

  it('returns null on a truncated buffer', () => {
    const bytes = encodeVarint(15293).slice(0, 1);
    expect(decodeVarint(bytes)).toBeNull();
  });

  it('rejects a negative or non-integer value', () => {
    expect(() => encodeVarint(-1)).toThrow();
    expect(() => encodeVarint(1.5)).toThrow();
  });
});

describe('determinePacketNumberLength', () => {
  it('picks the smallest byte length that fits the packet number', () => {
    expect(determinePacketNumberLength(0)).toBe(1);
    expect(determinePacketNumberLength(255)).toBe(1);
    expect(determinePacketNumberLength(256)).toBe(2);
    expect(determinePacketNumberLength(65535)).toBe(2);
    expect(determinePacketNumberLength(65536)).toBe(3);
    expect(determinePacketNumberLength(16777216)).toBe(4);
  });
});

describe('Long header packet (RFC 9000 §17.2)', () => {
  it('round-trips an Initial packet with a token', () => {
    const packet: QuicLongHeaderPacket = {
      form: 'long', type: 'initial', version: QUIC_VERSION_1,
      destConnectionId: 'aabbccdd', srcConnectionId: '1122',
      token: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      packetNumber: 42,
      payload: new TextEncoder().encode('hello-quic-payload'),
    };
    const bytes = encodeLongHeader(packet);
    const decoded = decodeLongHeader(bytes)!;
    expect(decoded.packet).toEqual(packet);
    expect(decoded.bytesConsumed).toBe(bytes.length);
  });

  it('round-trips a Handshake packet with no token', () => {
    const packet: QuicLongHeaderPacket = {
      form: 'long', type: 'handshake', version: QUIC_VERSION_1,
      destConnectionId: 'ff00ff00', srcConnectionId: '',
      packetNumber: 1000000,
      payload: new Uint8Array([1, 2, 3, 4, 5]),
    };
    const bytes = encodeLongHeader(packet);
    const decoded = decodeLongHeader(bytes)!;
    expect(decoded.packet.type).toBe('handshake');
    expect(decoded.packet.packetNumber).toBe(1000000);
    expect(decoded.packet.payload).toEqual(packet.payload);
  });

  it('round-trips a 0-RTT packet', () => {
    const packet: QuicLongHeaderPacket = {
      form: 'long', type: '0-rtt', version: QUIC_VERSION_1,
      destConnectionId: 'abcd', srcConnectionId: 'ef01',
      packetNumber: 7, payload: new Uint8Array([9, 9, 9]),
    };
    const decoded = decodeLongHeader(encodeLongHeader(packet))!;
    expect(decoded.packet).toEqual(packet);
  });

  it('round-trips a Retry packet (no packet number, token extends to end)', () => {
    const packet: QuicLongHeaderPacket = {
      form: 'long', type: 'retry', version: QUIC_VERSION_1,
      destConnectionId: 'aa', srcConnectionId: 'bb',
      token: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      payload: new Uint8Array(0),
    };
    const decoded = decodeLongHeader(encodeLongHeader(packet))!;
    expect(decoded.packet.type).toBe('retry');
    expect(decoded.packet.token).toEqual(packet.token);
    expect(decoded.packet.packetNumber).toBeUndefined();
  });

  it('chooses the packet number encoding length based on magnitude', () => {
    const small: QuicLongHeaderPacket = { form: 'long', type: 'handshake', version: QUIC_VERSION_1, destConnectionId: 'aa', srcConnectionId: 'bb', packetNumber: 5, payload: new Uint8Array(0) };
    const large: QuicLongHeaderPacket = { ...small, packetNumber: 100_000_000 };
    expect(encodeLongHeader(small).length).toBeLessThan(encodeLongHeader(large).length);
    expect(decodeLongHeader(encodeLongHeader(large))!.packet.packetNumber).toBe(100_000_000);
  });

  it('returns null for a truncated long header', () => {
    const packet: QuicLongHeaderPacket = { form: 'long', type: 'initial', version: QUIC_VERSION_1, destConnectionId: 'aabb', srcConnectionId: '', packetNumber: 1, payload: new Uint8Array([1, 2, 3]) };
    const bytes = encodeLongHeader(packet);
    expect(decodeLongHeader(bytes.slice(0, bytes.length - 2))).toBeNull();
  });

  it('rejects a short-header byte (header form bit unset)', () => {
    expect(decodeLongHeader(new Uint8Array([0x40, 0, 0]))).toBeNull();
  });
});

describe('Short header packet (RFC 9000 §17.3)', () => {
  it('round-trips a short header given the known DCID length', () => {
    const packet: QuicShortHeaderPacket = {
      form: 'short', destConnectionId: 'aabbccdd', packetNumber: 12345,
      payload: new TextEncoder().encode('application data'),
    };
    const bytes = encodeShortHeader(packet);
    const decoded = decodeShortHeader(bytes, 4)!;
    expect(decoded.packet).toEqual(packet);
  });

  it('requires the DCID length to be known (cannot self-describe)', () => {
    const packet: QuicShortHeaderPacket = { form: 'short', destConnectionId: 'aabb', packetNumber: 1, payload: new Uint8Array(0) };
    const bytes = encodeShortHeader(packet);
    const wrongLength = decodeShortHeader(bytes, 1)!;
    expect(wrongLength.packet.destConnectionId).not.toBe('aabb');
  });

  it('rejects a long-header byte (header form bit set)', () => {
    expect(decodeShortHeader(new Uint8Array([0xc0, 0, 0]), 4)).toBeNull();
  });
});

describe('Version Negotiation packet (RFC 9000 §17.2.1)', () => {
  it('round-trips with multiple supported versions', () => {
    const packet = {
      form: 'version-negotiation' as const,
      destConnectionId: 'aabb', srcConnectionId: 'ccdd',
      supportedVersions: [QUIC_VERSION_1, 0xff00001d],
    };
    const decoded = decodeVersionNegotiation(encodeVersionNegotiation(packet))!;
    expect(decoded.packet).toEqual(packet);
  });

  it('is distinguished from a regular long header by a zero version field', () => {
    const vn = encodeVersionNegotiation({ form: 'version-negotiation', destConnectionId: 'aa', srcConnectionId: 'bb', supportedVersions: [QUIC_VERSION_1] });
    expect(decodeLongHeader(vn)).toBeNull();
    expect(decodeVersionNegotiation(vn)).not.toBeNull();
  });
});

describe('decodePacket — dispatches by header form and version', () => {
  it('dispatches a long header (Initial) packet', () => {
    const packet: QuicLongHeaderPacket = { form: 'long', type: 'initial', version: QUIC_VERSION_1, destConnectionId: 'aa', srcConnectionId: 'bb', packetNumber: 1, payload: new Uint8Array([1]) };
    const decoded = decodePacket(encodeLongHeader(packet))!;
    expect(decoded.packet.form).toBe('long');
  });

  it('dispatches a Version Negotiation packet', () => {
    const bytes = encodeVersionNegotiation({ form: 'version-negotiation', destConnectionId: 'aa', srcConnectionId: 'bb', supportedVersions: [QUIC_VERSION_1] });
    expect(decodePacket(bytes)!.packet.form).toBe('version-negotiation');
  });

  it('dispatches a short header packet given shortHeaderDcidLength', () => {
    const bytes = encodeShortHeader({ form: 'short', destConnectionId: 'aabbccdd', packetNumber: 1, payload: new Uint8Array(0) });
    expect(decodePacket(bytes, { shortHeaderDcidLength: 4 })!.packet.form).toBe('short');
  });

  it('returns null for a short header without shortHeaderDcidLength', () => {
    const bytes = encodeShortHeader({ form: 'short', destConnectionId: 'aabb', packetNumber: 1, payload: new Uint8Array(0) });
    expect(decodePacket(bytes)).toBeNull();
  });
});
