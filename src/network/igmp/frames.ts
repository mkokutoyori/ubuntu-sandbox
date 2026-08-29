/**
 * IGMP frame construction — the single place where an IGMP message is
 * turned into an Ethernet frame.
 *
 * Three engines emit IGMP: the router agent (`IgmpAgent`, queries), the
 * host agent (`IgmpHostAgent`, reports and leaves) and the switch's
 * snooping querier (`IgmpSnoopingAgent`). They share this module so the
 * wire format can never drift between them.
 *
 * Header shape is the one Linux itself emits (`net/ipv4/igmp.c`, both
 * the report and the query path): IHL 6 — a 24-byte header carrying the
 * 4-byte Router Alert option — tos 0xc0, TTL 1, DF set, protocol 2,
 * destined to a multicast group address. RFC 2236 §2 requires the option
 * but says nothing about DF; the kernel is what sets it.
 */
import { type IPAddress } from '../core/types';
import type { Ipv4SendRequest } from '../layers/internet/Ipv4Egress';
import {
  IP_PROTO_IGMP, IGMP_ALL_SYSTEMS, IGMP_ALL_ROUTERS,
  type IgmpPacket,
} from './types';

const IGMP_HEADER_BYTES = 8;
const IPV4_RA_HEADER_BYTES = 24;
const IPV4_FLAG_DF = 0b010;

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

export function igmpSendRequest(
  iface: string,
  srcIp: IPAddress,
  dstIp: IPAddress,
  payload: IgmpPacket,
): Ipv4SendRequest {
  return {
    destination: dstIp, source: srcIp, iface,
    protocol: IP_PROTO_IGMP, ttl: 1,
    payload, payloadBytes: IGMP_HEADER_BYTES,
    tos: 0xc0, flags: IPV4_FLAG_DF,
    headerBytes: IPV4_RA_HEADER_BYTES,
  };
}
