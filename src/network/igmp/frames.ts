/**
 * IGMP frame construction — the single place where an IGMP message is
 * turned into an Ethernet frame.
 *
 * Three engines emit IGMP: the router agent (`IgmpAgent`, queries), the
 * host agent (`IgmpHostAgent`, reports and leaves) and the switch's
 * snooping querier (`IgmpSnoopingAgent`). They share this module so the
 * wire format can never drift between them.
 *
 * Header shape follows RFC 2236 §2: IGMP rides directly on IPv4
 * (protocol 2) with TTL 1 and the Router Alert option (IHL 6, tos 0xc0),
 * destined to a multicast group address.
 */
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet,
  ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import {
  IP_PROTO_IGMP, IGMP_ALL_SYSTEMS, IGMP_ALL_ROUTERS,
  ipv4MulticastToMac, type IgmpPacket,
} from './types';

const IGMP_HEADER_BYTES = 8;
const IPV4_RA_HEADER_BYTES = 24;

/** General Query (group 0.0.0.0) or Group-Specific Query. */
export function igmpQuery(group: string, maxRespTimeDs: number): IgmpPacket {
  return {
    type: 'igmp', version: 2,
    messageType: 'membership-query',
    maxRespTimeDs,
    groupAddress: group,
    checksum: 0,
  };
}

/** Membership Report — v1 or v2 depending on the querier version in force. */
export function igmpReport(group: string, version: 1 | 2): IgmpPacket {
  return {
    type: 'igmp', version: 2,
    messageType: version === 1 ? 'v1-membership-report' : 'v2-membership-report',
    maxRespTimeDs: 0,
    groupAddress: group,
    checksum: 0,
  };
}

/** Leave Group — IGMPv2 only (RFC 2236 §3). */
export function igmpLeave(group: string): IgmpPacket {
  return {
    type: 'igmp', version: 2,
    messageType: 'leave-group',
    maxRespTimeDs: 0,
    groupAddress: group,
    checksum: 0,
  };
}

/**
 * Destination address an IGMP message is sent to, per RFC 2236 §2:
 * a General Query goes to all-systems, a Group-Specific Query and a
 * Report go to the group itself, a Leave goes to all-routers.
 */
export function igmpDestination(payload: IgmpPacket): string {
  switch (payload.messageType) {
    case 'membership-query':
      return payload.groupAddress === '0.0.0.0' ? IGMP_ALL_SYSTEMS : payload.groupAddress;
    case 'leave-group':
      return IGMP_ALL_ROUTERS;
    default:
      return payload.groupAddress;
  }
}

export function buildIgmpFrame(
  srcMac: MACAddress,
  srcIp: IPAddress,
  dstIp: IPAddress,
  payload: IgmpPacket,
): EthernetFrame {
  const ipPkt: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 6, tos: 0xc0,
    totalLength: IPV4_RA_HEADER_BYTES + IGMP_HEADER_BYTES,
    identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
    ttl: 1, protocol: IP_PROTO_IGMP, headerChecksum: 0,
    sourceIP: srcIp, destinationIP: dstIp,
    payload,
  };
  ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
  return {
    srcMAC: srcMac,
    dstMAC: new MACAddress(ipv4MulticastToMac(dstIp.toString())),
    etherType: ETHERTYPE_IPV4,
    payload: ipPkt,
  };
}
