import type { UDPLitePacket } from '../../core/types';
import { ChecksumCoverage } from './ChecksumCoverage';
import { verifyUdpLiteChecksum } from './UdpChecksum';

export const UDPLITE_HEADER_BYTES = 8;

export type UdpLiteInputRefusal =
  | 'short-datagram' | 'invalid-coverage' | 'coverage-beyond-datagram' | 'checksum-fail';

export interface UdpLiteArrival {
  readonly source: string;
  readonly destination: string;
  readonly availableBytes: number;
}

export type UdpLiteInputVerdict =
  | { readonly accepted: true; readonly datagram: UDPLitePacket; readonly coverage: number }
  | { readonly accepted: false; readonly refusal: UdpLiteInputRefusal };

export function acceptUdpLiteDatagram(udp: UDPLitePacket, arrival: UdpLiteArrival): UdpLiteInputVerdict {
  if (arrival.availableBytes < UDPLITE_HEADER_BYTES) return { accepted: false, refusal: 'short-datagram' };
  const declared = udp.checksumCoverage;
  if (!ChecksumCoverage.isValid(declared)) return { accepted: false, refusal: 'invalid-coverage' };
  if (declared > arrival.availableBytes) return { accepted: false, refusal: 'coverage-beyond-datagram' };
  if (!verifyUdpLiteChecksum(udp, arrival.availableBytes, arrival.source, arrival.destination)) {
    return { accepted: false, refusal: 'checksum-fail' };
  }
  return {
    accepted: true, datagram: udp,
    coverage: declared === 0 ? arrival.availableBytes : declared,
  };
}

export function admitsCoverage(
  minimum: ChecksumCoverage, coverage: number, datagramBytes: number,
): boolean {
  if (coverage >= datagramBytes) return true;
  return !minimum.coversWholeDatagram && coverage >= minimum.value;
}
