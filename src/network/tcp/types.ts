import { IPv6Address } from '@/network/core/types';

export type TcpState =
  | 'closed'
  | 'listen'
  | 'syn-sent'
  | 'syn-received'
  | 'established'
  | 'fin-wait-1'
  | 'fin-wait-2'
  | 'close-wait'
  | 'closing'
  | 'last-ack'
  | 'time-wait';

export interface TcpFlags {
  fin: boolean;
  syn: boolean;
  rst: boolean;
  psh: boolean;
  ack: boolean;
  urg: boolean;
  ece: boolean;
  cwr: boolean;
}

export function noFlags(): TcpFlags {
  return { fin: false, syn: false, rst: false, psh: false, ack: false, urg: false, ece: false, cwr: false };
}

export interface TcpSegment {
  type: 'tcp';
  sourcePort: number;
  destinationPort: number;
  sequence: number;
  acknowledgement: number;
  dataOffset: number;
  flags: TcpFlags;
  window: number;
  checksum: number;
  urgentPointer: number;
  options: TcpOption[];
  payload: unknown;
}

export type TcpOption =
  | { kind: 'mss'; value: number }
  | { kind: 'window-scale'; shift: number }
  | { kind: 'sack-permitted' }
  | { kind: 'timestamp'; tsVal: number; tsEcr: number }
  | { kind: 'nop' }
  | { kind: 'end' };

export type TcpCloseReason = 'fin' | 'rst' | 'timeout' | 'shutdown';

export const TCP_DEFAULT_MSS = 1460;
export const TCP_DEFAULT_WINDOW = 65535;

/** Maximum Segment Lifetime; TIME-WAIT lasts 2×MSL (RFC 9293 §3.4.1). */
export const TCP_MSL_MS = 30_000;
export const TCP_TIME_WAIT_MS = 2 * TCP_MSL_MS;

/** True when `a` precedes `b` in 32-bit sequence space (mod 2³²). */
export function seqLt(a: number, b: number): boolean {
  return ((a - b) >>> 0) > 0x7fffffff;
}

const IP_PROTO_TCP_NUMBER = 6;
const IP_PROTO_UDP_NUMBER = 17;

function pushPseudoHeader(
  words: number[], srcIp: string, dstIp: string, protocol: number, l4Length: number,
): void {
  if (srcIp.includes(':') || dstIp.includes(':')) {
    for (const ip of [srcIp, dstIp]) {
      for (const hextet of new IPv6Address(ip).getHextets()) words.push(hextet & 0xffff);
    }
    words.push((l4Length >>> 16) & 0xffff, l4Length & 0xffff);
    words.push(0x0000, protocol & 0xffff);
    return;
  }
  for (const ip of [srcIp, dstIp]) {
    const o = ip.split('.').map(Number);
    words.push(((o[0] ?? 0) << 8) | (o[1] ?? 0), ((o[2] ?? 0) << 8) | (o[3] ?? 0));
  }
  words.push(protocol & 0xffff, l4Length & 0xffff);
}

function payloadBytes(payload: unknown): number[] {
  if (typeof payload === 'string') {
    const bytes: number[] = [];
    for (let i = 0; i < payload.length; i++) bytes.push(payload.charCodeAt(i) & 0xff);
    return bytes;
  }
  if (payload instanceof Uint8Array) return Array.from(payload);
  return [];
}

function pushBytesAsWords(words: number[], bytes: number[]): void {
  for (let i = 0; i < bytes.length; i += 2) {
    const hi = bytes[i] & 0xff;
    const lo = i + 1 < bytes.length ? bytes[i + 1] & 0xff : 0;
    words.push((hi << 8) | lo);
  }
}

function onesComplement(words: number[]): number {
  let sum = 0;
  for (const w of words) {
    sum += w;
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return (~sum) & 0xffff;
}

export function computeTcpChecksum(
  seg: TcpSegment, srcIp: string, dstIp: string,
): number {
  const bytes = payloadBytes(seg.payload);
  const tcpLen = 20 + bytes.length;

  const words: number[] = [];
  pushPseudoHeader(words, srcIp, dstIp, IP_PROTO_TCP_NUMBER, tcpLen);
  words.push(seg.sourcePort & 0xffff, seg.destinationPort & 0xffff);
  words.push((seg.sequence >>> 16) & 0xffff, seg.sequence & 0xffff);
  words.push((seg.acknowledgement >>> 16) & 0xffff, seg.acknowledgement & 0xffff);
  const f = seg.flags;
  const flagBits = (f.fin ? 1 : 0) | (f.syn ? 2 : 0) | (f.rst ? 4 : 0)
    | (f.psh ? 8 : 0) | (f.ack ? 16 : 0) | (f.urg ? 32 : 0)
    | (f.ece ? 64 : 0) | (f.cwr ? 128 : 0);
  words.push(((seg.dataOffset & 0xf) << 12) | flagBits, seg.window & 0xffff);
  words.push(0, seg.urgentPointer & 0xffff);
  pushBytesAsWords(words, bytes);

  return onesComplement(words);
}

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

/**
 * Verify a received segment's checksum. A checksum of 0 is treated as
 * "not computed" (checksum offload) and accepted — segments built by
 * this stack always carry a real checksum.
 */
export function verifyTcpChecksum(
  seg: TcpSegment, srcIp: string, dstIp: string,
): boolean {
  if (seg.checksum === 0) return true;
  return computeTcpChecksum(seg, srcIp, dstIp) === seg.checksum;
}

export function flagsString(f: TcpFlags): string {
  const parts: string[] = [];
  if (f.cwr) parts.push('CWR');
  if (f.ece) parts.push('ECE');
  if (f.urg) parts.push('URG');
  if (f.ack) parts.push('ACK');
  if (f.psh) parts.push('PSH');
  if (f.rst) parts.push('RST');
  if (f.syn) parts.push('SYN');
  if (f.fin) parts.push('FIN');
  return parts.join('|') || '(none)';
}

export function nextIsn(): number {
  return (Date.now() & 0xffffffff) ^ Math.floor(Math.random() * 0xffffffff);
}

export function makeSocketKey(localIp: string, localPort: number, remoteIp: string, remotePort: number): string {
  return `${localIp}:${localPort}|${remoteIp}:${remotePort}`;
}

export function makeListenerKey(localIp: string, localPort: number): string {
  return `${localIp}:${localPort}`;
}
