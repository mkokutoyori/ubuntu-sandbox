import { icmpTimeExceededPhrase, icmpUnreachablePhrase } from '@/network/core/IcmpPhrase';
import { ETHERTYPE_ARP, IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP } from '../../../../../core/types';
import type { ARPPacket, ICMPPacket, IPv4Packet } from '../../../../../core/types';
import { icmpOf, portsOf, type CapturedFrame } from '../../../diag/PacketCapture';
import { decodeCaptured } from '../../../diag/SnifferFilter';
import type { TcpSegment } from '../../../../../tcp/types';

export type SnifferTimestamps = 'relative' | 'absolute' | 'local';

export interface SnifferRequest {
  readonly iface: string;
  readonly expression: string;
  readonly verbosity: number;
  readonly count: number;
  readonly timestamps?: SnifferTimestamps;
}

export function snifferHeader(request: SnifferRequest): string[] {
  return [
    `interfaces=[${request.iface}]`,
    `filters=[${request.expression === '' ? 'none' : request.expression}]`,
  ];
}

export function snifferTrailer(received: number): string[] {
  return ['', `${received} packets received by filter`, '0 packets dropped by kernel'];
}

export function renderSniffer(
  request: SnifferRequest, frames: readonly CapturedFrame[], startedAt: number,
): string {
  const lines = snifferHeader(request);
  for (const entry of frames) {
    lines.push(renderFrame(entry, request.verbosity, startedAt, request.timestamps));
  }
  lines.push(...snifferTrailer(frames.length));
  return lines.join('\n');
}

export function renderFrame(
  entry: CapturedFrame, verbosity: number, startedAt: number, timestamps: SnifferTimestamps = 'relative',
): string {
  const stamp = timestamps === 'relative' ? ((entry.at - startedAt) / 1000).toFixed(6) : absoluteStamp(entry.at);
  const named = verbosity >= 4;
  const head = named ? `${stamp} ${entry.iface} -- ` : `${stamp} `;
  const lines = [head + describe(entry)];
  const dumped = dumpedBytes(entry, verbosity);
  if (dumped !== null) lines.push(...hexLines(dumped));
  return lines.join('\n');
}

function absoluteStamp(at: number): string {
  const whole = Math.floor(at);
  const micros = Math.round((at - whole) * 1000);
  const date = new Date(whole);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
    + `.${pad(date.getUTCMilliseconds(), 3)}${pad(micros, 3)}`;
}

function dumpedBytes(entry: CapturedFrame, verbosity: number): readonly number[] | null {
  if (verbosity !== 2 && verbosity !== 3 && verbosity !== 5 && verbosity !== 6) return null;
  const decoded = decodeCaptured(entry);
  return verbosity === 2 || verbosity === 5 ? decoded.raw.slice(decoded.rawLinkOffset) : decoded.raw;
}

function hexLines(bytes: readonly number[]): string[] {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const row = bytes.slice(offset, offset + 16);
    const groups: string[] = [];
    for (let index = 0; index < row.length; index += 2) {
      groups.push(row.slice(index, index + 2).map((byte) => byte.toString(16).padStart(2, '0')).join(''));
    }
    const text = row.map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.')).join('');
    lines.push(`0x${offset.toString(16).padStart(4, '0')}   ${groups.join(' ').padEnd(39, ' ')}        ${text}`);
  }
  return lines;
}

function describe(entry: CapturedFrame): string {
  if (entry.frame.etherType === ETHERTYPE_ARP) {
    const arp = entry.frame.payload as ARPPacket;
    if (arp.operation === 'request') {
      return `arp who-has ${arp.targetIP} tell ${arp.senderIP}`;
    }
    return `arp reply ${arp.senderIP} is-at ${arp.senderMAC}`;
  }

  const packet = entry.frame.payload as IPv4Packet | undefined;
  if (packet?.type !== 'ipv4') return 'unknown protocol';

  if (packet.protocol === IP_PROTO_ICMP) return describeIcmp(packet);
  if (packet.protocol === IP_PROTO_TCP) return describeTcp(packet);
  if (packet.protocol === IP_PROTO_UDP) return describeUdp(packet);
  return `${packet.sourceIP} -> ${packet.destinationIP}: ip-proto-${packet.protocol}`;
}

function icmpKind(icmp: ICMPPacket | undefined): string {
  if (!icmp) return 'unknown';
  if (icmp.icmpType === 'echo-reply') return 'echo reply';
  if (icmp.icmpType === 'echo-request') return 'echo request';
  if (icmp.icmpType === 'time-exceeded') return icmpTimeExceededPhrase(icmp.code);
  if (icmp.icmpType === 'destination-unreachable') {
    const quoted = icmp.originalPacket;
    const transport = quoted?.payload as { type?: string; destinationPort?: number } | undefined;
    const kind = transport?.type === 'tcp' || transport?.type === 'udp' ? transport.type : 'other';
    return icmpUnreachablePhrase({
      code: icmp.code,
      quotedDestination: quoted?.destinationIP.toString() ?? '',
      quotedProtocol: quoted?.protocol,
      quotedTransport: kind,
      quotedDestinationPort: transport?.destinationPort,
      nextHopMtu: icmp.mtu,
    });
  }
  return icmp.icmpType;
}

function describeIcmp(packet: IPv4Packet): string {
  return `${packet.sourceIP} -> ${packet.destinationIP}: icmp: ${icmpKind(icmpOf(packet))}`;
}

function describeTcp(packet: IPv4Packet): string {
  const ports = portsOf(packet);
  const segment = packet.payload as TcpSegment | undefined;
  return `${packet.sourceIP}.${ports.source} -> ${packet.destinationIP}.${ports.destination}:`
    + ` ${segment?.type === 'tcp' ? describeSegment(segment) : ''}`;
}

function describeSegment(segment: TcpSegment): string {
  const flags = tcpFlags(segment);
  const acknowledged = segment.flags.ack ? `ack ${segment.acknowledgement}` : '';
  if (flags === 'ack') return acknowledged;
  return acknowledged ? `${flags} ${segment.sequence} ${acknowledged}` : `${flags} ${segment.sequence}`;
}

function describeUdp(packet: IPv4Packet): string {
  const ports = portsOf(packet);
  return `${packet.sourceIP}.${ports.source} -> ${packet.destinationIP}.${ports.destination}:`
    + ` udp ${Math.max(0, packet.totalLength - 28)}`;
}

function tcpFlags(segment: TcpSegment): string {
  const flags = segment.flags;
  if (flags.syn && flags.ack) return 'syn';
  if (flags.syn) return 'syn';
  if (flags.rst) return 'rst';
  if (flags.fin) return 'fin';
  if (flags.psh) return 'psh';
  return 'ack';
}
