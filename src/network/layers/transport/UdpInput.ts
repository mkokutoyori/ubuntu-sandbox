import type { UDPPacket } from '../../core/types';
import { payloadBytes } from './L4Checksum';
import { verifyUdpChecksum } from './UdpChecksum';

export const UDP_HEADER_BYTES = 8;
export const UDP_MAX_PAYLOAD_OVER_IPV4 = 65535 - 20 - UDP_HEADER_BYTES;

export type UdpInputRefusal = 'short-datagram' | 'truncated-datagram' | 'checksum-fail';

export interface UdpArrival {
  readonly source: string;
  readonly destination: string;
  readonly availableBytes: number;
}

export type UdpInputVerdict =
  | { readonly accepted: true; readonly datagram: UDPPacket }
  | { readonly accepted: false; readonly refusal: UdpInputRefusal };

function trimmedTo(udp: UDPPacket, bytes: number): UDPPacket {
  if (payloadBytes(udp.payload).length <= bytes) return udp;
  if (typeof udp.payload === 'string') return { ...udp, payload: udp.payload.slice(0, bytes) };
  if (udp.payload instanceof Uint8Array) return { ...udp, payload: udp.payload.subarray(0, bytes) };
  return udp;
}

export function acceptUdpDatagram(udp: UDPPacket, arrival: UdpArrival): UdpInputVerdict {
  if (udp.length < UDP_HEADER_BYTES) return { accepted: false, refusal: 'short-datagram' };
  if (udp.length > arrival.availableBytes) return { accepted: false, refusal: 'truncated-datagram' };
  const datagram = trimmedTo(udp, udp.length - UDP_HEADER_BYTES);
  if (!verifyUdpChecksum(datagram, arrival.source, arrival.destination)) {
    return { accepted: false, refusal: 'checksum-fail' };
  }
  return { accepted: true, datagram };
}
