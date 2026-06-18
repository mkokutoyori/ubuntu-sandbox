import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ETHERTYPE_IPV6,
  IP_PROTO_ICMP,
  IP_PROTO_TCP,
  IP_PROTO_UDP,
  ethernetFrameBytes,
  type EthernetFrame,
  type IPv4Packet,
  type IPv6Packet,
  type ARPPacket,
  type ICMPPacket,
  type TCPPacket,
  type UDPPacket,
} from '@/network/core/types';

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
  srcPort?: number;
  dstPort?: number;
  payloadLength?: number;
  icmpType?: string;
  icmpCode?: number;
  icmpId?: number;
  icmpSeq?: number;
  tcpFlags?: CaptureTcpFlags;
  tcpSeq?: number;
  tcpAck?: number;
  tcpWindow?: number;
  arpOp?: 'request' | 'reply';
  arpSenderIp?: string;
  arpSenderMac?: string;
  arpTargetIp?: string;
  arpTargetMac?: string;
  raw: number[];
  rawLinkOffset: number;
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

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

const ICMP_TYPE_BYTE: Record<string, number> = {
  'echo-reply': 0,
  'destination-unreachable': 3,
  redirect: 5,
  'echo-request': 8,
  'time-exceeded': 11,
};

function synthIcmpBytes(icmp: ICMPPacket): number[] {
  const type = ICMP_TYPE_BYTE[icmp.icmpType] ?? 8;
  const header = [type, icmp.code & 0xff, ...u16(0), ...u16(icmp.id & 0xffff), ...u16(icmp.sequence & 0xffff)];
  const data: number[] = [];
  for (let i = 0; i < (icmp.dataSize ?? 0); i++) data.push(i & 0xff);
  return [...header, ...data];
}

function synthL4Bytes(pkt: IPv4Packet): number[] {
  const payload = pkt.payload as { type?: string };
  if (payload?.type === 'icmp') return synthIcmpBytes(pkt.payload as ICMPPacket);
  if (payload?.type === 'tcp') {
    const tcp = pkt.payload as TCPPacket;
    return [...u16(tcp.sourcePort), ...u16(tcp.destinationPort)];
  }
  if (payload?.type === 'udp') {
    const udp = pkt.payload as UDPPacket;
    return [...u16(udp.sourcePort), ...u16(udp.destinationPort), ...u16(udp.length), ...u16(0)];
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

function withEthernet(frame: EthernetFrame, l3Bytes: number[]): { raw: number[]; offset: number } {
  const eth = [
    ...macBytes(frame.dstMAC.toString()),
    ...macBytes(frame.srcMAC.toString()),
    ...u16(frame.etherType),
  ];
  return { raw: [...eth, ...l3Bytes], offset: eth.length };
}

export function decodeEthernetFrame(
  frame: EthernetFrame,
  iface: string,
  direction: CaptureDirection,
  at: Date,
): CaptureFrame {
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
    const inner = ip6.payload as { type?: string } | undefined;
    base.l4 = inner?.type === 'icmpv6' ? 'icmp6' : inner?.type === 'tcp' ? 'tcp' : inner?.type === 'udp' ? 'udp' : 'other';
    const built = withEthernet(frame, []);
    base.raw = built.raw;
    base.rawLinkOffset = built.offset;
    return base;
  }

  const built = withEthernet(frame, []);
  base.raw = built.raw;
  base.rawLinkOffset = built.offset;
  return base;
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
    return;
  }
  if (ip.protocol === IP_PROTO_TCP) {
    const tcp = ip.payload as TCPPacket;
    base.l4 = 'tcp';
    base.srcPort = tcp.sourcePort;
    base.dstPort = tcp.destinationPort;
    base.tcpFlags = { ...tcp.flags };
    base.tcpSeq = tcp.sequenceNumber;
    base.tcpAck = tcp.acknowledgementNumber;
    base.tcpWindow = tcp.windowSize;
    base.payloadLength = Math.max(0, (ip.totalLength ?? 40) - (ip.ihl ?? 5) * 4 - 20);
    return;
  }
  if (ip.protocol === IP_PROTO_UDP) {
    const udp = ip.payload as UDPPacket;
    base.l4 = 'udp';
    base.srcPort = udp.sourcePort;
    base.dstPort = udp.destinationPort;
    base.payloadLength = Math.max(0, (udp.length ?? 8) - 8);
    return;
  }
  base.l4 = 'other';
}

export function makeTcpFrame(
  pkt: {
    at: Date; srcIp: string; srcPort: number; dstIp: string; dstPort: number;
    flags: string; seq: number; ack: number; length: number;
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
  const tcp = [...u16(pkt.srcPort), ...u16(pkt.dstPort)];
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
    tcpSeq: pkt.seq,
    tcpAck: pkt.ack,
    tcpWindow: 0,
    raw: [...header, ...tcp],
    rawLinkOffset: 0,
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
