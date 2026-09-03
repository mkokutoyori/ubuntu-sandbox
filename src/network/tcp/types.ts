import {
  IP_PROTO_TCP_NUMBER, onesComplement, payloadBytes,
  pushBytesAsWords, pushPseudoHeader,
} from '@/network/layers/transport/L4Checksum';


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
  | { kind: 'sack'; blocks: ReadonlyArray<{ start: number; end: number }> }
  | { kind: 'timestamp'; tsVal: number; tsEcr: number }
  | { kind: 'nop' }
  | { kind: 'end' };

export type TcpCloseReason = 'fin' | 'rst' | 'timeout' | 'shutdown';

/**
 * Minimal bidirectional-stream shape SSH/SFTP/SMB/WinRM code depends on —
 * migrated here from the now-deleted `core/TcpConnection.ts` ghost class
 * (PRD-TCP.md P9): that class was never instantiated in production (real
 * traffic goes through `TcpSocket` in `TcpStack.ts`), only these two type
 * definitions were actually used outside test doubles.
 */
export interface TcpStream {
  readonly localIp: string;
  readonly localPort: number;
  readonly remoteIp: string;
  readonly remotePort: number;
  write(data: string): void;
  close(): void;
  onData(handler: (data: string) => void): () => void;
  onClose?(handler: (reason: string) => void): () => void;
}

export type TcpWireOutcome = 'open' | 'refused' | 'prohibited' | 'timeout' | 'unreachable';

export interface TcpDialFailure {
  readonly dialFailed: 'refused' | 'timeout' | 'unreachable';
}

export function isDialFailure(outcome: unknown): outcome is TcpDialFailure {
  return typeof outcome === 'object' && outcome !== null && 'dialFailed' in outcome;
}

export type TcpConnector =
  (host: string, port: number) => Promise<TcpStream | TcpDialFailure | null>;

/**
 * A sent segment that consumed sequence space (SYN, FIN, or data) and is
 * awaiting an ACK that covers it — PRD-TCP.md P1. Pure ACKs/RSTs never
 * enter this queue: real TCP never retransmits a bare ACK on its own.
 */
export interface UnackedSegment {
  sequence: number;
  length: number;
  flags: TcpFlags;
  payload: unknown;
  /** SYN-specific options (mss/window-scale/sack-permitted/timestamp offer) that must be re-sent identically on every retransmission of this segment (PRD-TCP.md P6) — a retransmitted SYN missing them would silently break negotiation. */
  extraOptions?: TcpOption[];
  /** When this segment was first sent — Karn's algorithm (P4) only clock-samples RTT off a segment with `retransmitCount === 0`. */
  firstSentAtMs: number;
  retransmitCount: number;
  /**
   * PRD-TCP.md P6 (RFC 7323 §4.3, RTTM) — the timestamp value/send time of
   * the *most recent* (re)transmission of this segment. When timestamps
   * are negotiated, an ACK echoing `lastSentTsVal` unambiguously identifies
   * which attempt it acknowledges, so RTT can be sampled even off a
   * retransmitted segment — bypassing Karn's algorithm's restriction,
   * which exists only because a plain cumulative ACK can't tell attempts
   * apart.
   */
  lastSentTsVal?: number;
  lastSentAtMs?: number;
}

export const TCP_DEFAULT_MSS = 1460;
export const TCP_DEFAULT_WINDOW = 65535;

/** Floor for Path MTU Discovery's MSS shrinkage (PRD-TCP.md P7) — real stacks never let a reported Next-Hop MTU drive MSS to something absurdly tiny. */
export const TCP_MIN_MSS = 8;

/** Maximum Segment Lifetime; TIME-WAIT lasts 2×MSL (RFC 9293 §3.4.1). */
export const TCP_MSL_MS = 30_000;
export const TCP_TIME_WAIT_MS = 2 * TCP_MSL_MS;

/** True when `a` precedes `b` in 32-bit sequence space (mod 2³²). */
export function seqLt(a: number, b: number): boolean {
  return ((a - b) >>> 0) > 0x7fffffff;
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

export function verifyTcpChecksum(
  seg: TcpSegment, srcIp: string, dstIp: string,
): boolean {
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
