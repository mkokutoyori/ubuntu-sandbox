import { describe, it, expect } from 'vitest';
import {
  IPAddress, IP_PROTO_UDP, createIPv4Packet, verifyIPv4Checksum, type IPv4Packet, type UDPPacket,
} from '@/network/core/types';
import { fragmentIPv4, IPv4Reassembler, IPV4_FLAG_DF, IPV4_FLAG_MF } from '@/network/core/Ipv4Fragmentation';

const datagram = (payloadBytes: number, flags = 0): IPv4Packet => {
  const udp: UDPPacket = { type: 'udp', sourcePort: 5000, destinationPort: 9000, length: 8 + payloadBytes, checksum: 0, payload: 'X'.repeat(payloadBytes) };
  return createIPv4Packet(new IPAddress('10.0.0.1'), new IPAddress('10.0.0.2'), IP_PROTO_UDP, 64, udp, 8 + payloadBytes, { flags });
};

const reassembled = (pieces: readonly IPv4Packet[]): IPv4Packet => {
  const reassembler = new IPv4Reassembler();
  let whole: IPv4Packet | null = null;
  for (const piece of pieces) whole = reassembler.add(piece, 0, 'eth0') ?? whole;
  if (whole === null) throw new Error('the pieces did not complete the datagram');
  return whole;
};

const withDf = (piece: IPv4Packet, df: boolean): IPv4Packet => ({ ...piece, flags: (piece.flags & IPV4_FLAG_MF) | (df ? IPV4_FLAG_DF : 0) });

describe('the reassembler keeps what ip_frag_reasm keeps', () => {
  it('records the size of the largest piece it was given', () => {
    const pieces = fragmentIPv4(datagram(3000), 1500);
    expect(pieces.map((piece) => piece.totalLength)).toEqual([1500, 1500, 68]);
    expect(reassembled(pieces).largestFragmentBytes).toBe(1500);
  });

  it('records it whatever the order the pieces arrived in', () => {
    const pieces = fragmentIPv4(datagram(3000), 1500);
    expect(reassembled([pieces[2], pieces[0], pieces[1]]).largestFragmentBytes).toBe(1500);
  });

  it('records the largest piece even when it is not the first', () => {
    const small = fragmentIPv4(datagram(3000), 1500);
    const mixed = [...fragmentIPv4(small[0], 600), small[1], small[2]];
    expect(reassembled(mixed).largestFragmentBytes).toBe(1500);
  });

  it('puts the datagram back whole, with a valid header', () => {
    const whole = reassembled(fragmentIPv4(datagram(3000), 1500));
    expect(whole.totalLength).toBe(3028);
    expect(whole.fragmentOffset).toBe(0);
    expect(whole.flags & IPV4_FLAG_MF).toBe(0);
    expect(verifyIPv4Checksum(whole)).toBe(true);
  });

  it('hands a datagram that is not a fragment back as it is', () => {
    const plain = datagram(100);
    const result = new IPv4Reassembler().add(plain, 0, 'eth0');
    expect(result).toBe(plain);
    expect(result?.largestFragmentBytes).toBeUndefined();
  });

  it('keeps DF when every piece carried it', () => {
    const pieces = fragmentIPv4(datagram(3000, IPV4_FLAG_DF), 1500).map((piece) => withDf(piece, true));
    expect(reassembled(pieces).flags & IPV4_FLAG_DF).toBe(IPV4_FLAG_DF);
  });

  it('drops DF when no piece carried it', () => {
    expect(reassembled(fragmentIPv4(datagram(3000), 1500)).flags & IPV4_FLAG_DF).toBe(0);
  });

  it('keeps DF when the largest piece carried it, even if the first piece did not', () => {
    const [head, second, last] = fragmentIPv4(datagram(3000), 1500);
    const [smallA, smallB, smallC] = fragmentIPv4(head, 600);
    const pieces = [smallA, smallB, smallC, withDf(second, true), last].map((piece, index) => (index === 3 ? piece : withDf(piece, false)));
    expect(reassembled(pieces).flags & IPV4_FLAG_DF).toBe(IPV4_FLAG_DF);
  });

  it('drops DF when only the first piece carried it and it was not the largest', () => {
    const [head, second, last] = fragmentIPv4(datagram(3000), 1500);
    const [smallA, smallB, smallC] = fragmentIPv4(head, 600);
    const pieces = [withDf(smallA, true), withDf(smallB, false), withDf(smallC, false), withDf(second, false), withDf(last, false)];
    expect(reassembled(pieces).flags & IPV4_FLAG_DF).toBe(0);
  });

  it('keeps DF when only one of two pieces of the largest size carried it', () => {
    const [first, second, last] = fragmentIPv4(datagram(3000), 1500);
    expect(reassembled([withDf(first, true), withDf(second, false), withDf(last, false)]).flags & IPV4_FLAG_DF).toBe(IPV4_FLAG_DF);
  });

  it('drops DF when the only piece that carried it is smaller than the largest', () => {
    const [first, second, last] = fragmentIPv4(datagram(3000), 1500);
    expect(reassembled([withDf(first, false), withDf(second, false), withDf(last, true)]).flags & IPV4_FLAG_DF).toBe(0);
  });
});
