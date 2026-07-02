import { describe, it, expect } from 'vitest';
import { computeTcpChecksum, verifyTcpChecksum, computeUdpChecksum, noFlags } from '@/network/tcp/types';
import type { TcpSegment } from '@/network/tcp/types';
import type { UDPPacket } from '@/network/core/types';

function segment(overrides: Partial<TcpSegment> = {}): TcpSegment {
  const flags = noFlags();
  flags.syn = true;
  return {
    type: 'tcp',
    sourcePort: 40000,
    destinationPort: 22,
    sequence: 0x11223344,
    acknowledgement: 0,
    dataOffset: 5,
    flags,
    window: 64240,
    checksum: 0,
    urgentPointer: 0,
    options: [],
    payload: 'hello',
    ...overrides,
  };
}

const V6_SRC = '2001:db8::1';
const V6_DST = '2001:db8::2';
const V4_SRC = '10.0.0.1';
const V4_DST = '10.0.0.2';

describe('TCP checksum — IPv6 pseudo-header (RFC 8200 §8.1)', () => {
  it('computes a non-zero checksum over the IPv6 pseudo-header', () => {
    const checksum = computeTcpChecksum(segment(), V6_SRC, V6_DST);
    expect(checksum).toBeGreaterThan(0);
    expect(checksum).toBeLessThanOrEqual(0xffff);
  });

  it('round-trips: a segment stamped with its IPv6 checksum verifies', () => {
    const seg = segment();
    seg.checksum = computeTcpChecksum(seg, V6_SRC, V6_DST);
    expect(verifyTcpChecksum(seg, V6_SRC, V6_DST)).toBe(true);
  });

  it('differs from the IPv4 checksum for the same segment (pseudo-header covers the address)', () => {
    const seg = segment();
    expect(computeTcpChecksum(seg, V6_SRC, V6_DST)).not.toBe(computeTcpChecksum(seg, V4_SRC, V4_DST));
  });

  it('fails verification when the source address is spoofed', () => {
    const seg = segment();
    seg.checksum = computeTcpChecksum(seg, V6_SRC, V6_DST);
    expect(verifyTcpChecksum(seg, '2001:db8::99', V6_DST)).toBe(false);
  });

  it('fails verification when the payload is tampered', () => {
    const seg = segment();
    seg.checksum = computeTcpChecksum(seg, V6_SRC, V6_DST);
    const tampered = segment({ payload: 'hellO', checksum: seg.checksum });
    expect(verifyTcpChecksum(tampered, V6_SRC, V6_DST)).toBe(false);
  });

  it('expands :: correctly so equivalent spellings hash identically', () => {
    const seg = segment();
    const compact = computeTcpChecksum(seg, '2001:db8::1', '2001:db8::2');
    const expanded = computeTcpChecksum(seg, '2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::2');
    expect(compact).toBe(expanded);
  });

  it('keeps IPv4 checksums unchanged (regression)', () => {
    const seg = segment();
    seg.checksum = computeTcpChecksum(seg, V4_SRC, V4_DST);
    expect(verifyTcpChecksum(seg, V4_SRC, V4_DST)).toBe(true);
    expect(verifyTcpChecksum(seg, '10.0.0.9', V4_DST)).toBe(false);
  });
});

describe('UDP checksum — mandatory over IPv6 (RFC 8200 §8.1)', () => {
  function datagram(payloadBytes: number, payload: unknown = 'dns-query'): UDPPacket {
    return {
      type: 'udp',
      sourcePort: 51000,
      destinationPort: 53,
      length: 8 + payloadBytes,
      checksum: 0,
      payload,
    };
  }

  it('computes a non-zero checksum for an IPv6 datagram', () => {
    const checksum = computeUdpChecksum(datagram(9), V6_SRC, V6_DST);
    expect(checksum).toBeGreaterThan(0);
    expect(checksum).toBeLessThanOrEqual(0xffff);
  });

  it('differs between IPv4 and IPv6 for the same datagram', () => {
    const dgram = datagram(9);
    expect(computeUdpChecksum(dgram, V6_SRC, V6_DST)).not.toBe(computeUdpChecksum(dgram, V4_SRC, V4_DST));
  });

  it('changes when the destination address changes', () => {
    const dgram = datagram(9);
    expect(computeUdpChecksum(dgram, V6_SRC, V6_DST)).not.toBe(computeUdpChecksum(dgram, V6_SRC, '2001:db8::3'));
  });
});
