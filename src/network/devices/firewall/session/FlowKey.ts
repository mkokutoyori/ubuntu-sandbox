import {
  ICMPV6_DEST_UNREACHABLE,
  ICMPV6_ECHO_REPLY,
  ICMPV6_ECHO_REQUEST,
  ICMPV6_NEIGHBOR_ADVERTISEMENT,
  ICMPV6_NEIGHBOR_SOLICITATION,
  ICMPV6_PACKET_TOO_BIG,
  ICMPV6_ROUTER_ADVERTISEMENT,
  ICMPV6_ROUTER_SOLICITATION,
  ICMPV6_TIME_EXCEEDED,
  IP_PROTO_ICMP,
  IP_PROTO_TCP,
  IP_PROTO_UDP,
  type ICMPPacket,
  type ICMPType,
  type ICMPv6Type,
  type IPv4Packet,
  type TCPPacket,
  type UDPPacket,
} from '../../../core/types';

export interface FlowKey {
  readonly sourceIP: string;
  readonly sourcePort: number;
  readonly destIP: string;
  readonly destPort: number;
  readonly protocol: number;
}

const ICMP_TYPE_NUMBER: Record<ICMPType, number> = {
  'echo-reply': 0,
  'destination-unreachable': 3,
  'redirect': 5,
  'echo-request': 8,
  'time-exceeded': 11,
};

const ICMP_RECIPROCAL_TYPE: Readonly<Record<number, number>> = { 0: 8, 8: 0 };

const NO_PORTS = { sourcePort: 0, destPort: 0 } as const;

export function icmpTypeNumber(icmpType: ICMPType): number {
  return ICMP_TYPE_NUMBER[icmpType];
}

const ICMPV6_TYPE_NUMBER: Readonly<Record<ICMPv6Type, number>> = {
  'echo-request': ICMPV6_ECHO_REQUEST,
  'echo-reply': ICMPV6_ECHO_REPLY,
  'router-solicitation': ICMPV6_ROUTER_SOLICITATION,
  'router-advertisement': ICMPV6_ROUTER_ADVERTISEMENT,
  'neighbor-solicitation': ICMPV6_NEIGHBOR_SOLICITATION,
  'neighbor-advertisement': ICMPV6_NEIGHBOR_ADVERTISEMENT,
  'destination-unreachable': ICMPV6_DEST_UNREACHABLE,
  'packet-too-big': ICMPV6_PACKET_TOO_BIG,
  'time-exceeded': ICMPV6_TIME_EXCEEDED,
};

export function icmpv6TypeNumber(icmpType: ICMPv6Type | undefined): number | undefined {
  return icmpType === undefined ? undefined : ICMPV6_TYPE_NUMBER[icmpType];
}

export function makeFlowKey(
  sourceIP: string, sourcePort: number,
  destIP: string, destPort: number,
  protocol: number,
): FlowKey {
  return Object.freeze({ sourceIP, sourcePort, destIP, destPort, protocol });
}

export function flowKeyFromPacket(packet: IPv4Packet): FlowKey {
  const { sourcePort, destPort } = transportEndpoints(packet);
  return makeFlowKey(
    packet.sourceIP.toString(), sourcePort,
    packet.destinationIP.toString(), destPort,
    packet.protocol,
  );
}

function transportEndpoints(packet: IPv4Packet): { sourcePort: number; destPort: number } {
  const payload = packet.payload as { type?: string } | null | undefined;
  if (!payload) return NO_PORTS;

  if (packet.protocol === IP_PROTO_TCP && payload.type === 'tcp') {
    const segment = payload as TCPPacket;
    return { sourcePort: segment.sourcePort, destPort: segment.destinationPort };
  }
  if (packet.protocol === IP_PROTO_UDP && payload.type === 'udp') {
    const datagram = payload as UDPPacket;
    return { sourcePort: datagram.sourcePort, destPort: datagram.destinationPort };
  }
  if (packet.protocol === IP_PROTO_ICMP && payload.type === 'icmp') {
    const message = payload as ICMPPacket;
    return { sourcePort: message.id, destPort: icmpTypeNumber(message.icmpType) };
  }
  return NO_PORTS;
}

export function reverseFlowKey(key: FlowKey): FlowKey {
  if (key.protocol === IP_PROTO_ICMP) {
    return makeFlowKey(
      key.destIP, key.sourcePort,
      key.sourceIP, ICMP_RECIPROCAL_TYPE[key.destPort] ?? key.destPort,
      key.protocol,
    );
  }
  return makeFlowKey(key.destIP, key.destPort, key.sourceIP, key.sourcePort, key.protocol);
}

export function flowKeyToString(key: FlowKey): string {
  return `${key.protocol}|${key.sourceIP}:${key.sourcePort}>${key.destIP}:${key.destPort}`;
}

export function flowKeyEquals(a: FlowKey, b: FlowKey): boolean {
  return a.protocol === b.protocol
    && a.sourcePort === b.sourcePort
    && a.destPort === b.destPort
    && a.sourceIP === b.sourceIP
    && a.destIP === b.destIP;
}
