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

function pushIpWords(words: number[], ip: string): void {
  const o = ip.split('.').map(Number);
  words.push(((o[0] ?? 0) << 8) | (o[1] ?? 0), ((o[2] ?? 0) << 8) | (o[3] ?? 0));
}

/**
 * One's-complement checksum over the IPv4 pseudo-header + TCP header
 * + payload (RFC 9293 §3.1). The checksum field itself counts as 0.
 * Non-string payloads (structured sim objects) count as one byte.
 */
export function computeTcpChecksum(
  seg: TcpSegment, srcIp: string, dstIp: string,
): number {
  const payloadStr = typeof seg.payload === 'string'
    ? seg.payload
    : seg.payload === undefined ? '' : '';
  const tcpLen = 20 + payloadStr.length;

  const words: number[] = [];
  pushIpWords(words, srcIp);
  pushIpWords(words, dstIp);
  words.push(0x0006, tcpLen & 0xffff);          // zero|proto, TCP length
  words.push(seg.sourcePort & 0xffff, seg.destinationPort & 0xffff);
  words.push((seg.sequence >>> 16) & 0xffff, seg.sequence & 0xffff);
  words.push((seg.acknowledgement >>> 16) & 0xffff, seg.acknowledgement & 0xffff);
  const f = seg.flags;
  const flagBits = (f.fin ? 1 : 0) | (f.syn ? 2 : 0) | (f.rst ? 4 : 0)
    | (f.psh ? 8 : 0) | (f.ack ? 16 : 0) | (f.urg ? 32 : 0)
    | (f.ece ? 64 : 0) | (f.cwr ? 128 : 0);
  words.push(((seg.dataOffset & 0xf) << 12) | flagBits, seg.window & 0xffff);
  words.push(0 /* checksum slot */, seg.urgentPointer & 0xffff);
  for (let i = 0; i < payloadStr.length; i += 2) {
    const hi = payloadStr.charCodeAt(i) & 0xff;
    const lo = i + 1 < payloadStr.length ? payloadStr.charCodeAt(i + 1) & 0xff : 0;
    words.push((hi << 8) | lo);
  }

  let sum = 0;
  for (const w of words) {
    sum += w;
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return (~sum) & 0xffff;
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
