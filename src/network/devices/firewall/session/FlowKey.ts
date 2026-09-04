import {
  IP_PROTO_ICMP,
  IP_PROTO_TCP,
  IP_PROTO_UDP,
  icmpTypeNumber,
  icmpv6TypeNumber as wireIcmpv6TypeNumber,
  type ICMPPacket,
  type ICMPv6Type,
  type IPv4Packet,
  type TCPPacket,
  type UDPPacket,
} from '../../../core/types';

export { icmpTypeNumber };

export interface FlowKey {
  readonly sourceIP: string;
  readonly sourcePort: number;
  readonly destIP: string;
  readonly destPort: number;
  readonly protocol: number;
}

const ICMP_RECIPROCAL_TYPE: Readonly<Record<number, number>> = { 0: 8, 8: 0 };

const NO_PORTS = { sourcePort: 0, destPort: 0 } as const;

export function icmpv6TypeNumber(icmpType: ICMPv6Type | undefined): number | undefined {
  return icmpType === undefined ? undefined : wireIcmpv6TypeNumber(icmpType);
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
