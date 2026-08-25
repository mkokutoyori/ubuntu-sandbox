import type { IPv4Packet, IPAddress } from '../../core/types';
import { computeIPv4Checksum } from '../../core/types';
import { isMulticastIpv4 } from '../../core/ip';

export type Ipv4DestinationClass =
  | 'limited-broadcast'
  | 'link-local-multicast'
  | 'multicast'
  | 'unicast';

const LIMITED_BROADCAST = '255.255.255.255';

export function classifyIpv4Destination(destination: IPAddress): Ipv4DestinationClass {
  const text = destination.toString();
  if (text === LIMITED_BROADCAST) return 'limited-broadcast';
  if (!isMulticastIpv4(text)) return 'unicast';
  const octets = destination.getOctets();
  return octets[0] === 224 && octets[1] === 0 && octets[2] === 0
    ? 'link-local-multicast'
    : 'multicast';
}

export type TtlDecision =
  | { readonly kind: 'expired' }
  | { readonly kind: 'forward'; readonly packet: IPv4Packet };

export function decrementForForwarding(packet: IPv4Packet): TtlDecision {
  if (packet.ttl <= 1) return { kind: 'expired' };
  const forwarded: IPv4Packet = { ...packet, ttl: packet.ttl - 1, headerChecksum: 0 };
  forwarded.headerChecksum = computeIPv4Checksum(forwarded);
  return { kind: 'forward', packet: forwarded };
}
