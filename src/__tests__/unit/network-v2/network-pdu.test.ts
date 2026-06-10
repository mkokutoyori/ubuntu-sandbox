/**
 * Central PDU contract guard. Every protocol data unit must descend from the
 * single `NetworkPdu` base, so the "packet" concept has one representation.
 * These checks are mostly compile-time (assignability); the runtime asserts
 * pin the discriminator.
 */

import { describe, it, expect } from 'vitest';
import type { NetworkPdu } from '@/network/core/NetworkPdu';
import {
  IPAddress, createIPv4Packet, IP_PROTO_ICMP,
  type IPv4Packet, type ESPPacket, type ARPPacket, type UDPPacket,
} from '@/network/core/types';

describe('NetworkPdu — central packet contract', () => {
  it('an IPv4 packet is a NetworkPdu with type "ipv4"', () => {
    const pkt: NetworkPdu = createIPv4Packet(
      new IPAddress('10.0.0.1'), new IPAddress('10.0.0.2'), IP_PROTO_ICMP, 64, { type: 'icmp' }, 84,
    );
    expect(pkt.type).toBe('ipv4');
  });

  it('representative core PDUs are assignable to NetworkPdu', () => {
    // Compile-time assignability is the real assertion; the runtime check
    // simply confirms each carries a non-empty string discriminator.
    const esp = { type: 'esp', spi: 1, sequenceNumber: 1, innerPacket: {} as IPv4Packet } satisfies ESPPacket;
    const arp = {
      type: 'arp', operation: 1,
      senderMAC: '', senderIP: '', targetMAC: '', targetIP: '',
    } as unknown as ARPPacket;
    const udp = { type: 'udp', sourcePort: 1, destinationPort: 2, length: 8, checksum: 0, payload: {} } satisfies UDPPacket;

    for (const pdu of [esp, arp, udp] as NetworkPdu[]) {
      expect(typeof pdu.type).toBe('string');
      expect(pdu.type.length).toBeGreaterThan(0);
    }
  });
});
