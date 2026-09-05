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
  readonly iface?: string;
  readonly ttl?: number;
  readonly tos?: number;
}

export interface UdpEgressHost {
  sendUdpDatagram(request: UdpSendRequest): boolean;
}

/**
 * Ce que l'ECRITURE positionnelle de `sendUdpDatagram` accepte en plus de
 * ses parametres : les memes faits que `UdpSendRequest` porte par champ,
 * plus `badChecksum`, qui n'a de sens que pour un emetteur composant
 * deliberement un datagramme faux (`nmap --badsum`).
 */
export interface UdpEmissionOptions {
  df?: boolean;
  iface?: string;
  ttl?: number;
  badChecksum?: boolean;
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
    request.ttl ?? DEFAULT_TTL, udp, udp.length,
    request.tos === undefined ? {} : { tos: request.tos });
}
