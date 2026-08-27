import {
  IP_PROTO_UDP_NUMBER, onesComplement, payloadBytes,
  pushBytesAsWords, pushPseudoHeader,
} from './L4Checksum';

export interface UdpChecksumInput {
  sourcePort: number;
  destinationPort: number;
  payload: unknown;
}

export function computeUdpChecksum(
  udp: UdpChecksumInput, srcIp: string, dstIp: string,
): number {
  const bytes = payloadBytes(udp.payload);
  const udpLen = 8 + bytes.length;

  const words: number[] = [];
  pushPseudoHeader(words, srcIp, dstIp, IP_PROTO_UDP_NUMBER, udpLen);
  words.push(udp.sourcePort & 0xffff, udp.destinationPort & 0xffff);
  words.push(udpLen & 0xffff, 0);
  pushBytesAsWords(words, bytes);

  return onesComplement(words);
}

export function verifyUdpChecksum(
  udp: UdpChecksumInput & { checksum: number }, srcIp: string, dstIp: string,
): boolean {
  if (udp.checksum === 0) return true;
  return computeUdpChecksum(udp, srcIp, dstIp) === udp.checksum;
}
