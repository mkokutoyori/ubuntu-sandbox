import type { IPv6Packet } from '../../core/types';

export const IPV6_HEADER_BYTES = 40;

export type Ipv6HeaderProblem =
  | 'loopback-address'
  | 'interface-local-multicast'
  | 'reserved-multicast-scope'
  | 'multicast-source';

export function ipv6HeaderProblem(packet: IPv6Packet, arrivedOnLoopback: boolean): Ipv6HeaderProblem | null {
  const { sourceIP, destinationIP } = packet;
  if (!arrivedOnLoopback && (sourceIP.isLoopback() || destinationIP.isLoopback())) return 'loopback-address';
  if (destinationIP.isMulticast()) {
    const scope = destinationIP.multicastScope();
    if (!arrivedOnLoopback && scope === 1) return 'interface-local-multicast';
    if (scope === 0) return 'reserved-multicast-scope';
  }
  if (sourceIP.isMulticast()) return 'multicast-source';
  return null;
}

export function ipv6PacketBytes(packet: IPv6Packet): number {
  return IPV6_HEADER_BYTES + packet.payloadLength;
}
