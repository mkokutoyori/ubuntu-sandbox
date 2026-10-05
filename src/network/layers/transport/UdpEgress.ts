import {
  createIPv4Packet, IP_PROTO_UDP,
  type IPAddress, type IPv4Option, type IPv4Packet, type UDPPacket,
} from '../../core/types';
import { IPV4_FLAG_DF } from '../../core/Ipv4Fragmentation';
import { payloadBytes as bytesOf } from './L4Checksum';
import { stampUdpChecksum } from './UdpChecksum';

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
  readonly dontFragment?: boolean;
  readonly ipOptions?: readonly IPv4Option[];
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
  ipOptions?: readonly IPv4Option[];
  iface?: string;
  ttl?: number;
  tos?: number;
  badChecksum?: boolean;
  /** Une adresse source FORGEE, celle que `nmap -S`/`-D` compose. */
  sourceIp?: IPAddress;
}

const DEFAULT_TTL = 64;

export const UDP_OVER_IPV4_HEADER_BYTES = 28;

export function udpPayloadLength(payload: unknown, declared: number): number {
  if (declared > 0) return declared;
  return typeof payload === 'string' || payload instanceof Uint8Array ? bytesOf(payload).length : 0;
}

export function buildUdpDatagram(request: UdpSendRequest): UDPPacket {
  return {
    type: 'udp',
    sourcePort: request.sourcePort,
    destinationPort: request.destinationPort,
    length: 8 + udpPayloadLength(request.payload, request.payloadBytes),
    checksum: 0,
    payload: request.payload,
  };
}

export function buildUdpOverIpv4(source: IPAddress, request: UdpSendRequest): IPv4Packet {
  const udp = stampUdpChecksum(
    buildUdpDatagram(request), source.toString(), request.destination.toString());
  return createIPv4Packet(
    source, request.destination, IP_PROTO_UDP,
    request.ttl ?? DEFAULT_TTL, udp, udp.length,
    {
      flags: request.dontFragment === false ? 0 : IPV4_FLAG_DF,
      ...(request.tos === undefined ? {} : { tos: request.tos }),
      ...(request.ipOptions === undefined ? {} : { ipOptions: [...request.ipOptions] }),
    });
}
