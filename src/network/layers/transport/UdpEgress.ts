import {
  createIPv4Packet, IP_PROTO_UDP,
  type IPAddress, type IPv4Packet, type UDPPacket,
} from '../../core/types';

export interface UdpSendRequest {
  readonly destination: IPAddress;
  readonly destinationPort: number;
  readonly sourcePort: number;
  readonly payload: unknown;
  readonly payloadBytes: number;
  readonly source?: IPAddress;
  readonly ttl?: number;
}

export interface UdpEgressHost {
  sendUdpDatagram(request: UdpSendRequest): boolean;
}

const DEFAULT_TTL = 64;

export function buildUdpDatagram(request: UdpSendRequest): UDPPacket {
  return {
    type: 'udp',
    sourcePort: request.sourcePort,
    destinationPort: request.destinationPort,
    length: 8 + request.payloadBytes,
    checksum: 0,
    payload: request.payload,
  };
}

export function buildUdpOverIpv4(source: IPAddress, request: UdpSendRequest): IPv4Packet {
  const udp = buildUdpDatagram(request);
  return createIPv4Packet(
    source, request.destination, IP_PROTO_UDP,
    request.ttl ?? DEFAULT_TTL, udp, udp.length);
}
