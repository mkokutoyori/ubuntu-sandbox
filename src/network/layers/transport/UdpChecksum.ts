import { IP_PROTO_UDPLITE } from '../../core/types';
import {
  IP_PROTO_UDP_NUMBER, onesComplement, payloadBytes,
  pushBytesAsWords, pushPseudoHeader,
} from './L4Checksum';

export interface UdpChecksumInput {
  sourcePort: number;
  destinationPort: number;
  payload: unknown;
}

export interface UdpLiteChecksumInput {
  sourcePort: number;
  destinationPort: number;
  checksumCoverage: number;
  payload: unknown;
}

const UDP_HEADER_BYTES = 8;

function datagramChecksum(
  protocol: number, srcIp: string, dstIp: string, pseudoHeaderLength: number,
  ports: { sourcePort: number; destinationPort: number }, thirdHeaderWord: number,
  coveredPayload: number[],
): number {
  const words: number[] = [];
  pushPseudoHeader(words, srcIp, dstIp, protocol, pseudoHeaderLength);
  words.push(ports.sourcePort & 0xffff, ports.destinationPort & 0xffff);
  words.push(thirdHeaderWord & 0xffff, 0);
  pushBytesAsWords(words, coveredPayload);
  const sum = onesComplement(words);
  return sum === 0 ? 0xffff : sum;
}

export function computeUdpChecksum(
  udp: UdpChecksumInput, srcIp: string, dstIp: string,
): number {
  const bytes = payloadBytes(udp.payload);
  const udpLen = UDP_HEADER_BYTES + bytes.length;
  return datagramChecksum(IP_PROTO_UDP_NUMBER, srcIp, dstIp, udpLen, udp, udpLen, bytes);
}

export function computeUdpLiteChecksum(
  udp: UdpLiteChecksumInput, ipPayloadLength: number, srcIp: string, dstIp: string,
): number {
  const covered = udp.checksumCoverage === 0
    ? ipPayloadLength : Math.min(udp.checksumCoverage, ipPayloadLength);
  const bytes = payloadBytes(udp.payload);
  const coveredPayload = Array.from(
    { length: Math.max(0, covered - UDP_HEADER_BYTES) }, (_, i) => bytes[i] ?? 0);
  return datagramChecksum(
    IP_PROTO_UDPLITE, srcIp, dstIp, ipPayloadLength, udp, udp.checksumCoverage, coveredPayload);
}

function isIpv6(srcIp: string, dstIp: string): boolean {
  return srcIp.includes(':') || dstIp.includes(':');
}

export function verifyUdpChecksum(
  udp: UdpChecksumInput & { checksum: number }, srcIp: string, dstIp: string,
): boolean {
  if (udp.checksum === 0) return !isIpv6(srcIp, dstIp);
  return computeUdpChecksum(udp, srcIp, dstIp) === udp.checksum;
}

export function stampUdpChecksum<T extends UdpChecksumInput>(
  udp: T, srcIp: string, dstIp: string,
): T & { checksum: number } {
  return { ...udp, checksum: computeUdpChecksum(udp, srcIp, dstIp) };
}

export function verifyUdpLiteChecksum(
  udp: UdpLiteChecksumInput & { checksum: number }, ipPayloadLength: number, srcIp: string, dstIp: string,
): boolean {
  if (udp.checksum === 0) return false;
  return computeUdpLiteChecksum(udp, ipPayloadLength, srcIp, dstIp) === udp.checksum;
}

export function stampUdpLiteChecksum<T extends UdpLiteChecksumInput>(
  udp: T, ipPayloadLength: number, srcIp: string, dstIp: string,
): T & { checksum: number } {
  return { ...udp, checksum: computeUdpLiteChecksum(udp, ipPayloadLength, srcIp, dstIp) };
}
