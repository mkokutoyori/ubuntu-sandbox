/**
 * Packet codec — lossless serialization of an IPv4Packet to/from bytes, so ESP
 * can encrypt the genuine inner packet and rebuild it on decryption.
 *
 * The packet model is plain interface data except for the address value
 * objects (IPAddress / MACAddress / SubnetMask), which carry behaviour. They
 * are tagged and reconstructed; everything else round-trips through JSON.
 */

import { describe, it, expect } from 'vitest';
import { encodePacket, decodePacket } from '@/network/ipsec/packetCodec';
import { IPAddress, createIPv4Packet, IP_PROTO_ICMP, type IPv4Packet } from '@/network/core/types';

function sampleIcmp(): IPv4Packet {
  const payload = { type: 'icmp', icmpType: 8, code: 0, identifier: 7, sequenceNumber: 3, data: 'ping' };
  return createIPv4Packet(new IPAddress('10.1.1.1'), new IPAddress('10.2.2.2'), IP_PROTO_ICMP, 64, payload, 84);
}

describe('packetCodec', () => {
  it('round-trips an IPv4 packet to bytes and back', () => {
    const src = sampleIcmp();
    const d = decodePacket(encodePacket(src));
    expect(d.protocol).toBe(IP_PROTO_ICMP);
    expect(d.ttl).toBe(64);
    expect(d.totalLength).toBe(src.totalLength);
  });

  it('reconstructs IPAddress instances (not plain strings)', () => {
    const d = decodePacket(encodePacket(sampleIcmp()));
    expect(d.sourceIP).toBeInstanceOf(IPAddress);
    expect(d.destinationIP).toBeInstanceOf(IPAddress);
    expect(d.sourceIP.toString()).toBe('10.1.1.1');
    expect(d.destinationIP.toString()).toBe('10.2.2.2');
  });

  it('preserves inner payload data', () => {
    const d = decodePacket(encodePacket(sampleIcmp()));
    expect(d.payload).toMatchObject({ type: 'icmp', icmpType: 8, identifier: 7, data: 'ping' });
  });

  it('emits a Uint8Array', () => {
    expect(encodePacket(sampleIcmp())).toBeInstanceOf(Uint8Array);
  });

  it('is stable: encode∘decode∘encode is idempotent', () => {
    const once = encodePacket(sampleIcmp());
    expect(Array.from(encodePacket(decodePacket(once)))).toEqual(Array.from(once));
  });

  it('reconstructs a nested IPAddress in the payload (ICMP error)', () => {
    const pkt = createIPv4Packet(
      new IPAddress('192.168.0.1'), new IPAddress('192.168.0.2'), IP_PROTO_ICMP, 64,
      { type: 'icmp', icmpType: 3, code: 1, originalSource: new IPAddress('8.8.8.8') }, 84,
    );
    const pl = decodePacket(encodePacket(pkt)).payload as { originalSource: IPAddress };
    expect(pl.originalSource).toBeInstanceOf(IPAddress);
    expect(pl.originalSource.toString()).toBe('8.8.8.8');
  });
});
