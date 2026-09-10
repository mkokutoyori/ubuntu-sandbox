import type { IPv6Packet, ICMPv6Packet, TCPPacket } from '../../core/types';
import { IPv6Address } from '../../core/types';
import type { IPv6ACL, IPv6ACLEntry } from '../Router';
import type { AclPortSpec } from './acl/AclSyntax';
import {
  ipv6ProtocolMatches,
  isIpv6TcpFlagName,
  type Ipv6TcpFlagName,
} from './acl/Ipv6AclSyntax';

const IP_PROTO_ICMPV6 = 58;
const IP_PROTO_TCP = 6;

export interface Ipv6AclLogEvent {
  listName: string;
  action: 'permit' | 'deny';
  protocol: string;
  sourceIP: string;
  sourcePort?: number;
  destinationIP: string;
  destinationPort?: number;
}

export function formatIpv6AclLogMessage(event: Ipv6AclLogEvent): string {
  const verb = event.action === 'permit' ? 'permitted' : 'denied';
  const src = event.sourcePort === undefined
    ? event.sourceIP : `${event.sourceIP}(${event.sourcePort})`;
  const dst = event.destinationPort === undefined
    ? event.destinationIP : `${event.destinationIP}(${event.destinationPort})`;
  return `list ${event.listName} ${verb} ${event.protocol} ${src} -> ${dst}, 1 packet`;
}

export interface Ipv6AclContext {
  log?: (event: Ipv6AclLogEvent) => void;
  timeRangeActive?: (name: string, now: Date) => boolean;
  now?: () => number;
}

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

function portSpecMatches(port: number, spec: AclPortSpec): boolean {
  switch (spec.op) {
    case 'eq': return port === spec.port;
    case 'neq': return port !== spec.port;
    case 'gt': return port > spec.port;
    case 'lt': return port < spec.port;
    case 'range': return port >= spec.port && port <= (spec.endPort ?? spec.port);
  }
}

function portCriteriaMatch(entry: IPv6ACLEntry, pkt: IPv6Packet): boolean {
  if (entry.srcPortSpec) {
    const port = portOf(pkt, 'source');
    if (port === null || !portSpecMatches(port, entry.srcPortSpec)) return false;
  }
  if (entry.dstPortSpec) {
    const port = portOf(pkt, 'destination');
    if (port === null || !portSpecMatches(port, entry.dstPortSpec)) return false;
  }
  return true;
}

function icmpCriteriaMatch(entry: IPv6ACLEntry, pkt: IPv6Packet): boolean {
  if (entry.icmpType === undefined) return true;
  const icmp = pkt.payload as ICMPv6Packet | undefined;
  if (icmp?.type !== 'icmpv6') return false;
  if (/^\d+$/.test(entry.icmpType)) {
    const wanted = parseInt(entry.icmpType, 10);
    const carried = icmpv6TypeNumberOf(icmp.icmpType);
    if (carried === null || carried !== wanted) return false;
  } else if (icmp.icmpType !== entry.icmpType) {
    return false;
  }
  if (entry.icmpCode !== undefined && icmp.code !== entry.icmpCode) return false;
  return true;
}

const ICMPV6_TYPE_NUMBERS: Readonly<Record<string, number>> = {
  'destination-unreachable': 1,
  'packet-too-big': 2,
  'time-exceeded': 3,
  'echo-request': 128,
  'echo-reply': 129,
  'router-solicitation': 133,
  'router-advertisement': 134,
  'neighbor-solicitation': 135,
  'neighbor-advertisement': 136,
};

function icmpv6TypeNumberOf(name: string): number | null {
  return ICMPV6_TYPE_NUMBERS[name] ?? null;
}

function tcpFlagsMatch(entry: IPv6ACLEntry, pkt: IPv6Packet): boolean {
  if (!entry.tcpFlags && !entry.tcpEstablished) return true;
  if (pkt.nextHeader !== IP_PROTO_TCP) return false;
  const tcp = pkt.payload as TCPPacket | undefined;
  const flags = tcp && tcp.type === 'tcp' ? tcp.flags : undefined;
  if (!flags) return false;

  if (entry.tcpEstablished && !(flags.ack || flags.rst)) return false;

  if (entry.tcpFlags) {
    for (const name of entry.tcpFlags) {
      if (!isIpv6TcpFlagName(name)) return false;
      if (!flags[name.toLowerCase() as Ipv6TcpFlagName]) return false;
    }
  }
  return true;
}

function matchesEntry(entry: IPv6ACLEntry, pkt: IPv6Packet, ctx?: Ipv6AclContext): boolean {
  if (entry.remark !== undefined) return false;
  if (entry.evaluate !== undefined) return false;

  if (!ipv6ProtocolMatches(entry.protocol ?? 'ipv6', pkt.nextHeader)) return false;

  if (!matchesPrefix(pkt.sourceIP, entry.srcPrefix, entry.srcPrefixLength)) return false;
  if (!matchesPrefix(pkt.destinationIP, entry.dstPrefix, entry.dstPrefixLength)) return false;

  if (!portCriteriaMatch(entry, pkt)) return false;
  if (!icmpCriteriaMatch(entry, pkt)) return false;
  if (!tcpFlagsMatch(entry, pkt)) return false;

  if (entry.dscp !== undefined) {
    const carried = typeof pkt.trafficClass === 'number' ? pkt.trafficClass >> 2 : undefined;
    if (carried === undefined || carried !== entry.dscp) return false;
  }
  if (entry.flowLabel !== undefined) {
    if (typeof pkt.flowLabel !== 'number' || pkt.flowLabel !== entry.flowLabel) return false;
  }
  if (entry.fragments === true) return false;
  if (entry.routing === true) return false;
  if (entry.undeterminedTransport === true) return false;

  if (entry.timeRange !== undefined) {
    if (!ctx?.timeRangeActive) return false;
    const now = new Date(ctx.now ? ctx.now() : Date.now());
    if (!ctx.timeRangeActive(entry.timeRange, now)) return false;
  }

  return true;
}

export function ipv6EntriesInOrder(acl: IPv6ACL): IPv6ACLEntry[] {
  return [...acl.entries].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
}

export function evaluateIpv6Acl(
  acl: IPv6ACL | undefined,
  pkt: IPv6Packet,
  ctx?: Ipv6AclContext,
): 'permit' | 'deny' {
  if (!acl || acl.entries.length === 0) return 'permit';
  for (const entry of ipv6EntriesInOrder(acl)) {
    if (!matchesEntry(entry, pkt, ctx)) continue;
    entry.matchCount = (entry.matchCount ?? 0) + 1;
    if ((entry.log || entry.logInput) && ctx?.log) {
      ctx.log({
        listName: acl.name,
        action: entry.action,
        protocol: entry.protocol ?? 'ipv6',
        sourceIP: pkt.sourceIP.toString(),
        sourcePort: portOf(pkt, 'source') ?? undefined,
        destinationIP: pkt.destinationIP.toString(),
        destinationPort: portOf(pkt, 'destination') ?? undefined,
      });
    }
    return entry.action;
  }
  if (isNeighborDiscovery(pkt)) return 'permit';
  return 'deny';
}
