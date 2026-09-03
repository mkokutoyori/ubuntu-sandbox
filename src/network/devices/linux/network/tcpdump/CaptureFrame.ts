import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ETHERTYPE_IPV6,
  IP_PROTO_ICMP,
  IP_PROTO_ICMPV6,
  IP_PROTO_TCP,
  IP_PROTO_UDP,
  ethernetFrameBytes,
  verifyIPv4Checksum,
  type EthernetFrame,
  type IPv4Packet,
  type IPv6Packet,
  type ARPPacket,
  type ICMPPacket,
  type ICMPv6Packet,
  type UDPPacket,
} from '@/network/core/types';
import type { Dot1QTag, TaggedEthernetFrame } from '../../../Switch';
import type { TcpSegment, TcpOption } from '@/network/tcp/types';
import { computeTcpChecksum } from '@/network/tcp/types';
import { computeUdpChecksum } from '@/network/layers/transport/UdpChecksum';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import { RRType } from '@/network/dns/wire/RRType';
import { decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { rrTypeName } from '@/network/dns/compat/DnsWireCompat';

export type CaptureDirection = 'in' | 'out';
export type CaptureL3 = 'arp' | 'ipv4' | 'ipv6' | 'other';
export type CaptureL4 = 'icmp' | 'icmp6' | 'tcp' | 'udp' | 'other' | 'none';

export interface CaptureTcpFlags {
  syn: boolean;
  ack: boolean;
  fin: boolean;
  rst: boolean;
  psh: boolean;
  urg: boolean;
}

export interface CaptureFrame {
  at: Date;
  iface: string;
  direction: CaptureDirection;
  linkType: string;
  srcMac: string;
  dstMac: string;
  etherType: number;
  l3: CaptureL3;
  l4: CaptureL4;
  length: number;
  srcIp?: string;
  dstIp?: string;
  ttl?: number;
  ipId?: number;
  ipProtocol?: number;
  ipTotalLength?: number;
  ipHeaderLen?: number;
  ipFlags?: number;
  ipFragmentOffset?: number;
  srcPort?: number;
  dstPort?: number;
  payloadLength?: number;
  dnsSummary?: string;
  icmpType?: string;
  icmpCode?: number;
  icmpId?: number;
  icmpSeq?: number;
  /** RFC 1191 §4 Next-Hop MTU, present on Fragmentation Needed (type 3, code 4). */
  icmpNextHopMtu?: number;
  /** Original IP header + first 8 bytes, encapsulated in an ICMP error (RFC 792). */
  icmpOrig?: IcmpOrigInfo;
  tcpFlags?: CaptureTcpFlags;
  tcpSeq?: number;
  tcpAck?: number;
  tcpWindow?: number;
  tcpOptions?: readonly TcpOption[];
  tcpChecksum?: number;
  tcpChecksumComputed?: number;
  tcpChecksumOk?: boolean;
  udpChecksum?: number;
  udpChecksumOk?: boolean;
  ipChecksum?: number;
  ipChecksumOk?: boolean;
  arpOp?: 'request' | 'reply';
  arpSenderIp?: string;
  arpSenderMac?: string;
  arpTargetIp?: string;
  arpTargetMac?: string;
  raw: number[];
  rawLinkOffset: number;
  tcpPayload?: number[];
  vlanId?: number;
  vlanPriority?: number;
  vlanDei?: number;
  dnsId?: number;
  dnsQr?: boolean;
  dnsRd?: boolean;
  dnsQtype?: string;
  dnsQname?: string;
  dnsRcode?: number;
  dnsTc?: boolean;
  dnsCounts?: { an: number; ns: number; ar: number };
  dnsAnswers?: readonly { type: string; data: string; ttl: number }[];
  dnsAuthority?: readonly { type: string; data: string; ttl: number }[];
}

export interface IcmpOrigInfo {
  srcIp: string;
  dstIp: string;
  ttl: number;
  ipId: number;
  protocol: number;
  ipFlags: number;
  ipTotalLength: number;
  l4: 'tcp' | 'udp' | 'icmp' | 'other';
  srcPort?: number;
  dstPort?: number;
  payloadLength?: number;
}

function formatResourceRecordData(rr: ResourceRecord<ResourceRecordData>): string {
  const d = rr.data;
  switch (d.type) {
    case RRType.A: return d.address.toString();
    case RRType.AAAA: return d.address.toString();
    case RRType.CNAME: return d.cname;
    case RRType.NS: return d.nsdname;
    case RRType.PTR: return d.ptrdname;
    case RRType.MX: return `${d.preference} ${d.exchange}`;
    case RRType.SOA: return `${d.mname} ${d.rname} ${d.serial}`;
    default: return rrTypeName(d.type as number);
  }
}

function decodeDnsPayload(base: CaptureFrame, payload: unknown): void {
  if (!(payload instanceof Uint8Array)) return;
  let msg: DnsMessage;
  try {
    msg = decodeDnsMessage(payload);
  } catch {
    return;
  }
  const question = msg.questions[0];
  base.dnsId = msg.id;
  base.dnsQr = msg.flags.qr;
  base.dnsRd = msg.flags.rd;
  base.dnsQtype = question ? rrTypeName(question.qtype as number) : '';
  base.dnsQname = question?.qname ?? '';
  base.dnsRcode = msg.flags.rcode;
  base.dnsTc = msg.flags.tc;
  base.dnsCounts = { an: msg.answers.length, ns: msg.authorities.length, ar: msg.additionals.length };
  base.dnsAnswers = msg.answers.map((rr) => ({
    type: rrTypeName(rr.data.type as number),
    data: formatResourceRecordData(rr),
    ttl: rr.ttl,
  }));
  base.dnsAuthority = msg.authorities.map((rr) => ({
    type: rrTypeName(rr.data.type as number),
    data: formatResourceRecordData(rr),
    ttl: rr.ttl,
  }));
}

function normalizeTcpSegment(payload: unknown): TcpSegment {
  const p = payload as Record<string, unknown>;
  const modern = typeof p.sequence === 'number';
  const f = (p.flags ?? {}) as Record<string, unknown>;
  return {
    type: 'tcp',
    sourcePort: typeof p.sourcePort === 'number' ? p.sourcePort : 0,
    destinationPort: typeof p.destinationPort === 'number' ? p.destinationPort : 0,
    sequence: (modern ? (p.sequence as number) : (typeof p.sequenceNumber === 'number' ? p.sequenceNumber : 0)) >>> 0,
    acknowledgement: (modern
      ? (p.acknowledgement as number)
      : (typeof p.acknowledgementNumber === 'number' ? p.acknowledgementNumber : 0)) >>> 0,
    dataOffset: typeof p.dataOffset === 'number' ? p.dataOffset : 5,
    flags: {
      fin: !!f.fin, syn: !!f.syn, rst: !!f.rst, psh: !!f.psh,
      ack: !!f.ack, urg: !!f.urg, ece: !!f.ece, cwr: !!f.cwr,
    },
    window: modern ? (p.window as number) : (typeof p.windowSize === 'number' ? p.windowSize : 0),
    checksum: typeof p.checksum === 'number' ? p.checksum : 0,
    urgentPointer: typeof p.urgentPointer === 'number' ? p.urgentPointer : 0,
    options: Array.isArray(p.options) ? (p.options as TcpOption[]) : [],
    payload: p.payload,
  };
}

function appPayloadBytes(payload: unknown): number[] | undefined {
  if (typeof payload === 'string') return Array.from(new TextEncoder().encode(payload));
  if (payload instanceof Uint8Array) return Array.from(payload);
  if (Array.isArray(payload) && payload.every((b) => typeof b === 'number')) {
    return payload as number[];
  }
  return undefined;
}

function macBytes(mac: string): number[] {
  const parts = mac.split(':').map((h) => parseInt(h, 16) & 0xff);
  while (parts.length < 6) parts.push(0);
  return parts.slice(0, 6);
}

function ipBytes(ip: string): number[] {
  const parts = ip.split('.').map((d) => parseInt(d, 10) & 0xff);
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4);
}

function ipv6Bytes(hextets: readonly number[]): number[] {
  const bytes: number[] = [];
  for (const h of hextets) bytes.push(...u16(h));
  return bytes;
}

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

const ICMP_TYPE_BYTE: Record<string, number> = {
  'echo-reply': 0,
  'destination-unreachable': 3,
  redirect: 5,
  'echo-request': 8,
  'time-exceeded': 11,
};

const ICMPV6_TYPE_BYTE: Record<string, number> = {
  'destination-unreachable': 1,
  'packet-too-big': 2,
  'time-exceeded': 3,
  'echo-request': 128,
  'echo-reply': 129,
  'router-solicitation': 133,
  'router-advertisement': 134,
  'neighbor-solicitation': 135,
  'neighbor-advertisement': 136,
};

function synthIcmpBytes(icmp: ICMPPacket): number[] {
  const type = ICMP_TYPE_BYTE[icmp.icmpType] ?? 8;
  const header = [type, icmp.code & 0xff, ...u16(0), ...u16(icmp.id & 0xffff), ...u16(icmp.sequence & 0xffff)];
  const data: number[] = [];
  for (let i = 0; i < (icmp.dataSize ?? 0); i++) data.push(i & 0xff);
  return [...header, ...data];
}

function tcpFlagsByte(flags: CaptureTcpFlags): number {
  return (flags.urg ? 0x20 : 0) | (flags.ack ? 0x10 : 0) | (flags.psh ? 0x08 : 0)
    | (flags.rst ? 0x04 : 0) | (flags.syn ? 0x02 : 0) | (flags.fin ? 0x01 : 0);
}

function synthTcpBytes(seg: TcpSegment): number[] {
  const dataOffset = Math.max(5, seg.dataOffset || 5);
  const optionBytes = new Array((dataOffset - 5) * 4).fill(0);
  return [
    ...u16(seg.sourcePort), ...u16(seg.destinationPort),
    ...u32(seg.sequence >>> 0), ...u32(seg.acknowledgement >>> 0),
    dataOffset << 4, tcpFlagsByte(seg.flags),
    ...u16(seg.window & 0xffff),
    ...u16(seg.checksum & 0xffff),
    ...u16(seg.urgentPointer & 0xffff),
    ...optionBytes,
    ...(appPayloadBytes(seg.payload) ?? []),
  ];
}

function synthL4Bytes(pkt: IPv4Packet): number[] {
  const payload = pkt.payload as { type?: string };
  if (payload?.type === 'icmp') return synthIcmpBytes(pkt.payload as ICMPPacket);
  if (payload?.type === 'tcp') return synthTcpBytes(normalizeTcpSegment(pkt.payload));
  if (payload?.type === 'udp') {
    const udp = pkt.payload as UDPPacket;
    return [...u16(udp.sourcePort), ...u16(udp.destinationPort), ...u16(udp.length), ...u16(udp.checksum & 0xffff)];
  }
  return [];
}

function synthIpv4Bytes(pkt: IPv4Packet): number[] {
  const versionIhl = (4 << 4) | (pkt.ihl ?? 5);
  const total = pkt.totalLength ?? 20;
  const header = [
    versionIhl,
    pkt.tos & 0xff,
    ...u16(total),
    ...u16(pkt.identification & 0xffff),
    ...u16(((pkt.flags & 0x7) << 13) | (pkt.fragmentOffset & 0x1fff)),
    pkt.ttl & 0xff,
    pkt.protocol & 0xff,
    ...u16(pkt.headerChecksum & 0xffff),
    ...ipBytes(pkt.sourceIP.toString()),
    ...ipBytes(pkt.destinationIP.toString()),
  ];
  return [...header, ...synthL4Bytes(pkt)];
}

function synthIcmpv6Bytes(icmp: ICMPv6Packet): number[] {
  const type = ICMPV6_TYPE_BYTE[icmp.icmpType] ?? 128;
  const header = [type, icmp.code & 0xff, ...u16(0)];
  if (icmp.id !== undefined && icmp.sequence !== undefined) {
    header.push(...u16(icmp.id & 0xffff), ...u16(icmp.sequence & 0xffff));
  }
  const data: number[] = [];
  for (let i = 0; i < (icmp.dataSize ?? 0); i++) data.push(i & 0xff);
  return [...header, ...data];
}

function synthL4BytesV6(pkt: IPv6Packet): number[] {
  const payload = pkt.payload as { type?: string };
  if (payload?.type === 'icmpv6') return synthIcmpv6Bytes(pkt.payload as ICMPv6Packet);
  if (payload?.type === 'tcp') return synthTcpBytes(normalizeTcpSegment(pkt.payload));
  if (payload?.type === 'udp') {
    const udp = pkt.payload as UDPPacket;
    return [...u16(udp.sourcePort), ...u16(udp.destinationPort), ...u16(udp.length), ...u16(udp.checksum & 0xffff)];
  }
  return [];
}

function synthIpv6Bytes(pkt: IPv6Packet): number[] {
  const versionTrafficFlow = (6 << 28) | ((pkt.trafficClass & 0xff) << 20) | (pkt.flowLabel & 0xfffff);
  const header = [
    ...u32(versionTrafficFlow >>> 0),
    ...u16(pkt.payloadLength & 0xffff),
    pkt.nextHeader & 0xff,
    pkt.hopLimit & 0xff,
    ...ipv6Bytes(pkt.sourceIP.getHextets()),
    ...ipv6Bytes(pkt.destinationIP.getHextets()),
  ];
  return [...header, ...synthL4BytesV6(pkt)];
}

function synthArpBytes(arp: ARPPacket): number[] {
  return [
    ...u16(1),
    ...u16(ETHERTYPE_IPV4),
    6,
    4,
    ...u16(arp.operation === 'reply' ? 2 : 1),
    ...macBytes(arp.senderMAC.toString()),
    ...ipBytes(arp.senderIP.toString()),
    ...macBytes(arp.targetMAC.toString()),
    ...ipBytes(arp.targetIP.toString()),
  ];
}

function dot1qTagOf(frame: EthernetFrame): Dot1QTag | undefined {
  return (frame as TaggedEthernetFrame).dot1q;
}

function withEthernet(frame: EthernetFrame, l3Bytes: number[]): { raw: number[]; offset: number } {
  const eth = [
    ...macBytes(frame.dstMAC.toString()),
    ...macBytes(frame.srcMAC.toString()),
  ];
  const tag = dot1qTagOf(frame);
  if (tag) {
    const tci = ((tag.pcp & 0x7) << 13) | ((tag.dei & 0x1) << 12) | (tag.vid & 0xfff);
    eth.push(...u16(tag.tpid), ...u16(tci));
  }
  eth.push(...u16(frame.etherType));
  return { raw: [...eth, ...l3Bytes], offset: eth.length };
}

export function decodeEthernetFrame(
  frame: EthernetFrame,
  iface: string,
  direction: CaptureDirection,
  at: Date,
): CaptureFrame {
  const tag = dot1qTagOf(frame);
  const base: CaptureFrame = {
    at,
    iface,
    direction,
    linkType: 'EN10MB',
    srcMac: frame.srcMAC.toString(),
    dstMac: frame.dstMAC.toString(),
    etherType: frame.etherType,
    l3: 'other',
    l4: 'none',
    length: ethernetFrameBytes(frame),
    raw: [],
    rawLinkOffset: 0,
    vlanId: tag?.vid,
    vlanPriority: tag?.pcp,
    vlanDei: tag?.dei,
  };

  if (frame.etherType === ETHERTYPE_ARP) {
    const arp = frame.payload as ARPPacket;
    base.l3 = 'arp';
    base.arpOp = arp.operation === 'reply' ? 'reply' : 'request';
    base.arpSenderIp = arp.senderIP.toString();
    base.arpSenderMac = arp.senderMAC.toString();
    base.arpTargetIp = arp.targetIP.toString();
    base.arpTargetMac = arp.targetMAC.toString();
    const built = withEthernet(frame, synthArpBytes(arp));
    base.raw = built.raw;
    base.rawLinkOffset = built.offset;
    return base;
  }

  if (frame.etherType === ETHERTYPE_IPV4) {
    const ip = frame.payload as IPv4Packet;
    base.l3 = 'ipv4';
    base.srcIp = ip.sourceIP.toString();
    base.dstIp = ip.destinationIP.toString();
    base.ttl = ip.ttl;
    base.ipId = ip.identification;
    base.ipProtocol = ip.protocol;
    base.ipTotalLength = ip.totalLength;
    base.ipHeaderLen = (ip.ihl ?? 5) * 4;
    base.ipFlags = ip.flags;
    base.ipFragmentOffset = ip.fragmentOffset;
    base.ipChecksum = ip.headerChecksum;
    base.ipChecksumOk = verifyIPv4Checksum(ip);
    decodeIpv4Payload(base, ip);
    const built = withEthernet(frame, synthIpv4Bytes(ip));
    base.raw = built.raw;
    base.rawLinkOffset = built.offset;
    return base;
  }

  if (frame.etherType === ETHERTYPE_IPV6) {
    const ip6 = frame.payload as IPv6Packet;
    base.l3 = 'ipv6';
    base.srcIp = ip6.sourceIP.toString();
    base.dstIp = ip6.destinationIP.toString();
    base.ttl = ip6.hopLimit;
    base.ipProtocol = ip6.nextHeader;
    base.ipTotalLength = ip6.payloadLength + 40;
    base.ipHeaderLen = 40;
    decodeIpv6Payload(base, ip6);
    const built = withEthernet(frame, synthIpv6Bytes(ip6));
    base.raw = built.raw;
    base.rawLinkOffset = built.offset;
    return base;
  }

  const built = withEthernet(frame, []);
  base.raw = built.raw;
  base.rawLinkOffset = built.offset;
  return base;
}

function decodeIcmpOrig(orig: IPv4Packet): IcmpOrigInfo {
  const info: IcmpOrigInfo = {
    srcIp: orig.sourceIP.toString(),
    dstIp: orig.destinationIP.toString(),
    ttl: orig.ttl,
    ipId: orig.identification,
    protocol: orig.protocol,
    ipFlags: orig.flags,
    ipTotalLength: orig.totalLength,
    l4: 'other',
  };
  if (orig.protocol === IP_PROTO_UDP) {
    const udp = orig.payload as UDPPacket;
    info.l4 = 'udp';
    info.srcPort = udp.sourcePort;
    info.dstPort = udp.destinationPort;
    info.payloadLength = Math.max(0, (udp.length ?? 8) - 8);
  } else if (orig.protocol === IP_PROTO_TCP) {
    const seg = normalizeTcpSegment(orig.payload);
    info.l4 = 'tcp';
    info.srcPort = seg.sourcePort;
    info.dstPort = seg.destinationPort;
    info.payloadLength = Math.max(0, (orig.totalLength ?? 40) - (orig.ihl ?? 5) * 4 - seg.dataOffset * 4);
  } else if (orig.protocol === IP_PROTO_ICMP) {
    info.l4 = 'icmp';
  }
  return info;
}

function decodeIpv4Payload(base: CaptureFrame, ip: IPv4Packet): void {
  if (ip.protocol === IP_PROTO_ICMP) {
    const icmp = ip.payload as ICMPPacket;
    base.l4 = 'icmp';
    base.icmpType = icmp.icmpType;
    base.icmpCode = icmp.code;
    base.icmpId = icmp.id;
    base.icmpSeq = icmp.sequence;
    base.payloadLength = (icmp.dataSize ?? 0) + 8;
    base.icmpNextHopMtu = icmp.mtu;
    if (icmp.originalPacket) base.icmpOrig = decodeIcmpOrig(icmp.originalPacket);
    return;
  }
  if (ip.protocol === IP_PROTO_TCP) {
    const seg = normalizeTcpSegment(ip.payload);
    base.l4 = 'tcp';
    base.srcPort = seg.sourcePort;
    base.dstPort = seg.destinationPort;
    base.tcpFlags = { ...seg.flags };
    base.tcpSeq = seg.sequence;
    base.tcpAck = seg.acknowledgement;
    base.tcpWindow = seg.window;
    base.tcpOptions = seg.options;
    base.tcpChecksum = seg.checksum;
    base.tcpChecksumComputed = computeTcpChecksum(seg, base.srcIp!, base.dstIp!);
    base.tcpChecksumOk = seg.checksum === 0 || base.tcpChecksumComputed === seg.checksum;
    base.payloadLength = Math.max(0, (ip.totalLength ?? 40) - (ip.ihl ?? 5) * 4 - seg.dataOffset * 4);
    base.tcpPayload = appPayloadBytes(seg.payload);
    if (seg.sourcePort === 53 || seg.destinationPort === 53) {
      decodeDnsPayload(base, seg.payload);
    }
    return;
  }
  if (ip.protocol === IP_PROTO_UDP) {
    const udp = ip.payload as UDPPacket;
    base.l4 = 'udp';
    base.srcPort = udp.sourcePort;
    base.dstPort = udp.destinationPort;
    base.udpChecksum = udp.checksum;
    base.udpChecksumOk = udp.checksum === 0
      || computeUdpChecksum(udp, base.srcIp!, base.dstIp!) === udp.checksum;
    base.payloadLength = Math.max(0, (udp.length ?? 8) - 8);
    if (udp.sourcePort === 53 || udp.destinationPort === 53) {
      decodeDnsPayload(base, udp.payload);
    }
    return;
  }
  base.l4 = 'other';
}

function decodeIpv6Payload(base: CaptureFrame, ip6: IPv6Packet): void {
  if (ip6.nextHeader === IP_PROTO_ICMPV6) {
    const icmp = ip6.payload as ICMPv6Packet;
    base.l4 = 'icmp6';
    base.icmpType = icmp.icmpType;
    base.icmpCode = icmp.code;
    base.icmpId = icmp.id;
    base.icmpSeq = icmp.sequence;
    base.payloadLength = ip6.payloadLength;
    return;
  }
  if (ip6.nextHeader === IP_PROTO_TCP) {
    const seg = normalizeTcpSegment(ip6.payload);
    base.l4 = 'tcp';
    base.srcPort = seg.sourcePort;
    base.dstPort = seg.destinationPort;
    base.tcpFlags = { ...seg.flags };
    base.tcpSeq = seg.sequence;
    base.tcpAck = seg.acknowledgement;
    base.tcpWindow = seg.window;
    base.tcpOptions = seg.options;
    base.tcpChecksum = seg.checksum;
    base.tcpChecksumComputed = computeTcpChecksum(seg, base.srcIp!, base.dstIp!);
    base.tcpChecksumOk = seg.checksum === 0 || base.tcpChecksumComputed === seg.checksum;
    base.payloadLength = Math.max(0, ip6.payloadLength - seg.dataOffset * 4);
    base.tcpPayload = appPayloadBytes(seg.payload);
    if (seg.sourcePort === 53 || seg.destinationPort === 53) {
      decodeDnsPayload(base, seg.payload);
    }
    return;
  }
  if (ip6.nextHeader === IP_PROTO_UDP) {
    const udp = ip6.payload as UDPPacket;
    base.l4 = 'udp';
    base.srcPort = udp.sourcePort;
    base.dstPort = udp.destinationPort;
    base.udpChecksum = udp.checksum;
    base.udpChecksumOk = udp.checksum === 0
      || computeUdpChecksum(udp, base.srcIp!, base.dstIp!) === udp.checksum;
    base.payloadLength = Math.max(0, (udp.length ?? 8) - 8);
    if (udp.sourcePort === 53 || udp.destinationPort === 53) {
      decodeDnsPayload(base, udp.payload);
    }
    return;
  }
  base.l4 = 'other';
}

export function makeTcpFrame(
  pkt: {
    at: Date; srcIp: string; srcPort: number; dstIp: string; dstPort: number;
    flags: string; seq: number; ack: number; length: number;
    payload?: Uint8Array;
  },
  iface: string,
): CaptureFrame {
  const f = pkt.flags;
  const flags = {
    syn: f.includes('S'),
    ack: f.includes('.'),
    fin: f.includes('F'),
    rst: f.includes('R'),
    psh: f.includes('P'),
    urg: f.includes('U'),
  };
  const total = 40 + pkt.length;
  const header = [
    0x45, 0, ...u16(total), ...u16(0), ...u16(0x4000), 64, IP_PROTO_TCP, ...u16(0),
    ...ipBytes(pkt.srcIp), ...ipBytes(pkt.dstIp),
  ];
  const tcp = [
    ...u16(pkt.srcPort), ...u16(pkt.dstPort),
    ...u32(pkt.seq >>> 0), ...u32(pkt.ack >>> 0),
    5 << 4, tcpFlagsByte(flags),
    ...u16(0),
    ...u16(0),
    ...u16(0),
  ];
  return {
    at: pkt.at,
    iface,
    direction: 'in',
    linkType: 'EN10MB',
    srcMac: '00:00:00:00:00:00',
    dstMac: '00:00:00:00:00:00',
    etherType: ETHERTYPE_IPV4,
    l3: 'ipv4',
    l4: 'tcp',
    length: total,
    srcIp: pkt.srcIp,
    dstIp: pkt.dstIp,
    ttl: 64,
    ipId: 0,
    ipProtocol: IP_PROTO_TCP,
    ipTotalLength: total,
    ipHeaderLen: 20,
    srcPort: pkt.srcPort,
    dstPort: pkt.dstPort,
    payloadLength: pkt.length,
    tcpFlags: flags,
    tcpSeq: pkt.seq >>> 0,
    tcpAck: pkt.ack >>> 0,
    tcpWindow: 0,
    raw: [...header, ...tcp, ...(pkt.payload ? Array.from(pkt.payload) : [])],
    rawLinkOffset: 0,
    tcpPayload: pkt.payload ? Array.from(pkt.payload) : undefined,
  };
}

export function makeLoopbackIcmpFrame(
  fromIp: string,
  toIp: string,
  id: number,
  seq: number,
  ttl: number,
  dataSize: number,
  icmpType: 'echo-request' | 'echo-reply',
  at: Date,
): CaptureFrame {
  const total = 20 + 8 + dataSize;
  const header = [
    0x45,
    0,
    ...u16(total),
    ...u16(id & 0xffff),
    ...u16(0),
    ttl & 0xff,
    IP_PROTO_ICMP,
    ...u16(0),
    ...ipBytes(fromIp),
    ...ipBytes(toIp),
  ];
  const icmp = [ICMP_TYPE_BYTE[icmpType] ?? 8, 0, ...u16(0), ...u16(id & 0xffff), ...u16(seq & 0xffff)];
  for (let i = 0; i < dataSize; i++) icmp.push(i & 0xff);
  return {
    at,
    iface: 'lo',
    direction: icmpType === 'echo-request' ? 'out' : 'in',
    linkType: 'EN10MB',
    srcMac: '00:00:00:00:00:00',
    dstMac: '00:00:00:00:00:00',
    etherType: ETHERTYPE_IPV4,
    l3: 'ipv4',
    l4: 'icmp',
    length: total,
    srcIp: fromIp,
    dstIp: toIp,
    ttl,
    ipId: id,
    ipProtocol: IP_PROTO_ICMP,
    ipTotalLength: total,
    ipHeaderLen: 20,
    icmpType,
    icmpCode: 0,
    icmpId: id,
    icmpSeq: seq,
    payloadLength: dataSize + 8,
    raw: [...header, ...icmp],
    rawLinkOffset: 0,
  };
}
