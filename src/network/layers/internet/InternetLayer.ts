import type { IPv4Packet } from '../../core/types';
import { computeIPv4Checksum } from '../../core/types';

export type TtlDecision =
  | { readonly kind: 'expired' }
  | { readonly kind: 'forward'; readonly packet: IPv4Packet };

export function decrementForForwarding(packet: IPv4Packet): TtlDecision {
  if (packet.ttl <= 1) return { kind: 'expired' };
  const forwarded: IPv4Packet = { ...packet, ttl: packet.ttl - 1, headerChecksum: 0 };
  forwarded.headerChecksum = computeIPv4Checksum(forwarded);
  return { kind: 'forward', packet: forwarded };
}
