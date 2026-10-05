import type { UDPLitePacket } from '../../core/types';
import type { ChecksumCoverage } from './ChecksumCoverage';
import { UDPLITE_HEADER_BYTES } from './UdpLiteInput';
import { udpPayloadLength } from './UdpEgress';

export const UDPLITE_MAX_IP_PAYLOAD = 65535;

export function udpLiteIpPayloadLength(payload: unknown, declaredBytes: number): number {
  return UDPLITE_HEADER_BYTES + udpPayloadLength(payload, declaredBytes);
}

export function coverageFieldFor(requested: ChecksumCoverage | undefined, ipPayloadLength: number): number {
  if (requested === undefined) return ipPayloadLength;
  if (requested.coversWholeDatagram) return 0;
  return Math.min(requested.value, ipPayloadLength);
}

export function buildUdpLiteDatagram(
  sourcePort: number, destinationPort: number, payload: unknown,
  requested: ChecksumCoverage | undefined, ipPayloadLength: number,
): UDPLitePacket {
  return {
    type: 'udplite',
    sourcePort,
    destinationPort,
    checksumCoverage: coverageFieldFor(requested, ipPayloadLength),
    checksum: 0,
    payload,
  };
}
