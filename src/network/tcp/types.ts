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

/**
 * Maximum Segment Lifetime (RFC 793 §3.3). The active closer must hold the
 * connection in TIME_WAIT for 2×MSL before releasing the socket pair, so
 * delayed segments from the old incarnation cannot corrupt a new one and a
 * retransmitted remote FIN can still be acknowledged. 30 s matches Linux
 * (TCP_TIMEWAIT_LEN = 60 s = 2×MSL).
 */
export const TCP_MSL_MS = 30_000;

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
