/**
 * Shared ICMP error-message generation (RFC 792, RFC 1122 §3.2.2, RFC 1812 §4.3.2).
 *
 * Both routers and end hosts must emit Time Exceeded / Destination Unreachable
 * messages under the same rules, so the construction logic and the "may we
 * even send an error?" guards live here instead of being re-implemented per
 * device class.
 */

import {
  ICMPPacket,
  IPv4Packet,
  IPAddress,
  createIPv4Packet,
  IP_PROTO_ICMP,
} from './types';

// ─── ICMP codes (RFC 792 / RFC 1812) ─────────────────────────────────

/** Destination Unreachable (Type 3) codes */
export const ICMP_UNREACH_NET = 0;
export const ICMP_UNREACH_HOST = 1;
export const ICMP_UNREACH_PORT = 3;
export const ICMP_UNREACH_FRAG_NEEDED = 4;
export const ICMP_UNREACH_ADMIN_PROHIBITED = 13;

/** Time Exceeded (Type 11) codes */
export const ICMP_TTL_EXPIRED_IN_TRANSIT = 0;
export const ICMP_FRAG_REASSEMBLY_TIME_EXCEEDED = 1;

/**
 * On-wire payload of an ICMP error: 8-byte ICMP header + original IP header
 * (20 bytes) + first 8 bytes of the original datagram (RFC 792).
 * With the 20-byte outer IPv4 header this yields the 56-byte total a real
 * `traceroute` reports for TIME_EXCEEDED probes.
 */
export const ICMP_ERROR_PAYLOAD_SIZE = 8 + 20 + 8;

export type ICMPErrorType = 'time-exceeded' | 'destination-unreachable';

// ─── RFC 1122 §3.2.2 generation guards ──────────────────────────────

const ICMP_ERROR_TYPES: ReadonlySet<string> = new Set([
  'time-exceeded',
  'destination-unreachable',
  'redirect',
]);

/** True if the packet itself carries an ICMP error message. */
export function isICMPErrorMessage(pkt: IPv4Packet): boolean {
  if (pkt.protocol !== IP_PROTO_ICMP) return false;
  const icmp = pkt.payload as ICMPPacket;
  return !!icmp && icmp.type === 'icmp' && ICMP_ERROR_TYPES.has(icmp.icmpType);
}

function isUnicastSource(ip: IPAddress): boolean {
  const octets = ip.getOctets();
  if (octets[0] === 0) return false;    // 0.0.0.0/8 — unspecified ("this network")
  if (octets[0] >= 224) return false;   // 224/4 multicast, 240/4 reserved, 255.255.255.255
  return true;
}

function isMulticastOrLimitedBroadcast(ip: IPAddress): boolean {
  return ip.getOctets()[0] >= 224;
}

/**
 * RFC 1122 §3.2.2: an ICMP error message MUST NOT be sent in response to
 *  - another ICMP error message (prevents error storms),
 *  - a non-initial fragment,
 *  - a packet destined to an IP multicast/broadcast address,
 *  - a packet whose source address is not a valid unicast address.
 *
 * Subnet-directed broadcast cannot be detected here without the destination
 * subnet mask; callers that know the mask must check `isBroadcastFor()`
 * themselves before invoking the error path.
 */
export function mayGenerateICMPError(offendingPkt: IPv4Packet): boolean {
  if (isICMPErrorMessage(offendingPkt)) return false;
  if (offendingPkt.fragmentOffset !== 0) return false;
  if (isMulticastOrLimitedBroadcast(offendingPkt.destinationIP)) return false;
  if (!isUnicastSource(offendingPkt.sourceIP)) return false;
  return true;
}

// ─── Error packet construction ───────────────────────────────────────

export interface ICMPErrorOptions {
  /** RFC 1191 §4: Next-Hop MTU for Fragmentation Needed (Type 3, Code 4). */
  nextHopMTU?: number;
}

/**
 * Build an ICMP error datagram addressed to the source of the offending
 * packet. Callers are responsible for checking `mayGenerateICMPError()`
 * first and for routing/transmitting the result.
 */
export function buildICMPError(
  sourceIP: IPAddress,
  offendingPkt: IPv4Packet,
  icmpType: ICMPErrorType,
  code: number,
  ttl: number,
  options: ICMPErrorOptions = {},
): IPv4Packet {
  const icmpError: ICMPPacket = {
    type: 'icmp',
    icmpType,
    code,
    id: 0,
    sequence: 0,
    dataSize: 0,
    mtu: (icmpType === 'destination-unreachable' && code === ICMP_UNREACH_FRAG_NEEDED)
      ? options.nextHopMTU
      : undefined,
    // Simulator-level reference to the offending packet: receivers correlate
    // echo failures (ping/traceroute) and IPsec PMTU discovery through it.
    originalPacket: offendingPkt,
  };

  return createIPv4Packet(
    sourceIP,
    offendingPkt.sourceIP,
    IP_PROTO_ICMP,
    ttl,
    icmpError,
    ICMP_ERROR_PAYLOAD_SIZE,
  );
}
