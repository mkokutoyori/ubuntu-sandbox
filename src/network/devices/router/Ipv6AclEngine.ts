/**
 * IPv6 access lists, EVALUATED.
 *
 * `ipv6 access-list` parsed into real structured entries and
 * `ipv6 traffic-filter` bound one to an interface — and nothing ever
 * read either. Measured on a live pair: a list whose first line is
 * `deny icmp any any`, applied inbound, let a ping through at 100 %.
 * A security feature that is accepted, displayed by
 * `show ipv6 access-list`, and filters nothing is worse than an absent
 * one, because it reads as protection.
 *
 * The one rule that is easy to miss and load-bearing: **IOS implicitly
 * permits Neighbor Discovery at the end of every IPv6 ACL**, before the
 * implicit deny —
 *
 *     permit icmp any any nd-na
 *     permit icmp any any nd-ns
 *     deny ipv6 any any
 *
 * — and without it, applying any IPv6 ACL kills NDP and takes the link
 * down with it. An implementation that stopped at "implicit deny" would
 * look correct in a review and destroy every lab that used it.
 */
import type { IPv6Packet, ICMPv6Packet } from '../../core/types';
import { IPv6Address } from '../../core/types';
import type { IPv6ACL, IPv6ACLEntry } from '../Router';

const IP_PROTO_TCP = 6;
const IP_PROTO_UDP = 17;
const IP_PROTO_ICMPV6 = 58;

const PROTOCOL_NUMBERS: Readonly<Record<string, number>> = {
  tcp: IP_PROTO_TCP,
  udp: IP_PROTO_UDP,
  icmp: IP_PROTO_ICMPV6,
  ipv6: -1,
};

/** The ND messages every IPv6 ACL lets through whatever it says. */
function isNeighborDiscovery(pkt: IPv6Packet): boolean {
  if (pkt.nextHeader !== IP_PROTO_ICMPV6) return false;
  const icmp = pkt.payload as ICMPv6Packet | undefined;
  if (icmp?.type !== 'icmpv6') return false;
  return icmp.icmpType === 'neighbor-solicitation'
    || icmp.icmpType === 'neighbor-advertisement';
}

function matchesPrefix(address: IPv6Address, prefix?: string, prefixLength?: number): boolean {
  if (!prefix || prefix === 'any') return true;
  let candidate: IPv6Address;
  try {
    candidate = new IPv6Address(prefix);
  } catch {
    return false;
  }
  const length = prefixLength ?? 128;
  return address.getNetworkPrefix(length).equals(candidate.getNetworkPrefix(length));
}

function portOf(pkt: IPv6Packet, which: 'source' | 'destination'): number | null {
  const l4 = pkt.payload as { sourcePort?: number; destinationPort?: number } | undefined;
  const port = which === 'source' ? l4?.sourcePort : l4?.destinationPort;
  return typeof port === 'number' ? port : null;
}

function matchesEntry(entry: IPv6ACLEntry, pkt: IPv6Packet): boolean {
  if (entry.remark !== undefined) return false;
  // A reflexive-list reference has no session table behind it here, so it
  // matches nothing rather than everything — failing an unbacked clause
  // CLOSED is the rule this repo already applies to `RoutePolicy`.
  if (entry.evaluate !== undefined) return false;

  const wanted = PROTOCOL_NUMBERS[(entry.protocol ?? 'ipv6').toLowerCase()];
  if (wanted === undefined) return false;
  if (wanted >= 0 && pkt.nextHeader !== wanted) return false;

  if (!matchesPrefix(pkt.sourceIP, entry.srcPrefix, entry.srcPrefixLength)) return false;
  if (!matchesPrefix(pkt.destinationIP, entry.dstPrefix, entry.dstPrefixLength)) return false;

  if (entry.dstPort !== undefined) {
    const port = portOf(pkt, 'destination');
    if (port === null || String(port) !== entry.dstPort) return false;
  }
  return true;
}

/**
 * The verdict of one list on one packet. An empty or unknown list
 * permits: on IOS an access list that does not exist filters nothing,
 * and a list bound before it is written is the normal configuration
 * order, not an error.
 */
export function evaluateIpv6Acl(acl: IPv6ACL | undefined, pkt: IPv6Packet): 'permit' | 'deny' {
  if (!acl || acl.entries.length === 0) return 'permit';
  for (const entry of acl.entries) {
    if (matchesEntry(entry, pkt)) return entry.action;
  }
  if (isNeighborDiscovery(pkt)) return 'permit';
  return 'deny';
}
