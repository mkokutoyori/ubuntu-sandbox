import { ETHERTYPE_ARP, IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP } from '../../../../../core/types';
import type { ARPPacket, IPv4Packet, TCPPacket } from '../../../../../core/types';
import { icmpOf, portsOf, type CapturedFrame } from '../../../diag/PacketCapture';

export interface SnifferRequest {
  readonly iface: string;
  readonly expression: string;
  readonly verbosity: number;
  readonly count: number;
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
    lines.push(renderFrame(entry, request.verbosity, startedAt));
  }
  lines.push(...snifferTrailer(frames.length));
  return lines.join('\n');
}

export function renderFrame(entry: CapturedFrame, verbosity: number, startedAt: number): string {
  const stamp = ((entry.at - startedAt) / 1000).toFixed(6);
  const named = verbosity >= 4;
  const head = named ? `${stamp} ${entry.iface} -- ` : `${stamp} `;
  return head + describe(entry);
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

function describeIcmp(packet: IPv4Packet): string {
  const icmp = icmpOf(packet);
  const kind = icmp?.icmpType === 'echo-reply' ? 'echo reply' : 'echo request';
  return `${packet.sourceIP} -> ${packet.destinationIP}: icmp: ${kind}`;
}

function describeTcp(packet: IPv4Packet): string {
  const ports = portsOf(packet);
  const segment = packet.payload as TCPPacket | undefined;
  const flags = segment?.type === 'tcp' ? tcpFlags(segment) : '';
  const sequence = segment?.type === 'tcp' ? ` ${segment.sequenceNumber}` : '';
  const acknowledged = segment?.type === 'tcp' && segment.flags.ack
    ? ` ack ${segment.acknowledgementNumber}`
    : '';

  return `${packet.sourceIP}.${ports.source} -> ${packet.destinationIP}.${ports.destination}:`
    + ` ${flags}${sequence}${acknowledged}`;
}

function describeUdp(packet: IPv4Packet): string {
  const ports = portsOf(packet);
  return `${packet.sourceIP}.${ports.source} -> ${packet.destinationIP}.${ports.destination}:`
    + ` udp ${Math.max(0, packet.totalLength - 28)}`;
}

function tcpFlags(segment: TCPPacket): string {
  const flags = segment.flags;
  if (flags.syn && flags.ack) return 'syn';
  if (flags.syn) return 'syn';
  if (flags.rst) return 'rst';
  if (flags.fin) return 'fin';
  if (flags.psh) return 'psh';
  return 'ack';
}
