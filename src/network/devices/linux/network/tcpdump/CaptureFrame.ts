import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ETHERTYPE_IPV6,
  IP_PROTO_ICMP,
  IP_PROTO_ICMPV6,
  IP_PROTO_TCP,
  IP_PROTO_UDP,
  encodeIPv4Options,
  ethernetFrameBytesWithoutFcs,
  icmpTypeNumber,
  icmpv6TypeNumber,
  verifyIPv4Checksum,
  MACAddress,
  type EthernetFrame,
  type IPv4Packet,
  type IPv6Packet,
  type ARPPacket,
  type ICMPPacket,
  type ICMPv6Packet,
  type NDPMessage,
  type NDPOption,
  type UDPPacket,
  type UDPLitePacket,
  type RIPPacket,
} from '@/network/core/types';
import { ipv6FirstFragmentView, ipv6FragmentOf } from '@/network/layers/internet/Ipv6Fragmentation';
import { cdpPayloadBytes, CDP_SNAP_HEADER } from '@/network/cdp/CdpWire';
import { ETHERTYPE_CDP, type CdpFrame } from '@/network/cdp/types';
import { ospfPacketBytes } from '@/network/ospf/OspfWire';
import type { OSPFPacket } from '@/network/ospf/types';
import { isIPv4FragmentData } from '@/network/core/Ipv4Fragmentation';
import type { Dot1QTag, TaggedEthernetFrame } from '../../../Switch';
import type { TcpSegment, TcpOption } from '@/network/tcp/types';
import { computeTcpChecksum, tcpFlagBits } from '@/network/tcp/types';
import { computeUdpChecksum } from '@/network/layers/transport/UdpChecksum';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import { RRType } from '@/network/dns/wire/RRType';
import { decodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { unframeDnsMessage } from '@/network/dns/transport/DnsStreamFraming';
import { rrTypeName } from '@/network/dns/compat/DnsWireCompat';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import { decodeBootp, type BootpInfo } from './TcpdumpBootp';
import { icmpWireBytes, icmpv6WireBytes, tcpWireBytes, transportChecksum, udpWireBytes, u16, u32, WIRE_PROTOCOLS } from './CaptureWire';

export type CaptureDirection = 'in' | 'out';
export type CaptureL3 = 'arp' | 'ipv4' | 'ipv6' | 'cdp' | 'other';
export type CaptureL4 = 'icmp' | 'icmp6' | 'tcp' | 'udp' | 'other' | 'none';

export interface CaptureTcpFlags {
  syn: boolean;
  ack: boolean;
  fin: boolean;
  rst: boolean;
  psh: boolean;
  urg: boolean;
  ece?: boolean;
  cwr?: boolean;
}

export interface Fragment6Info {
  identification: number;
  offsetBytes: number;
  length: number;
  inner?: CaptureFrame;
}

export interface CaptureFrame {
  at: Date;
  atMicros?: number;
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
  ipTos?: number;
  ipTrafficClass?: number;
  ipFlowLabel?: number;
  ipProtocol?: number;
  ipTotalLength?: number;
  ipHeaderLen?: number;
  ipFlags?: number;
  ipFragmentOffset?: number;
  fragment6?: Fragment6Info;
  icmpPointer?: number;
  srcPort?: number;
  dstPort?: number;
  payloadLength?: number;
  dnsSummary?: string;
  icmpType?: string;
  icmpCode?: number;
  icmpId?: number;
  icmpSeq?: number;
  icmpTimestamps?: { originate: number; receive: number; transmit: number };
  /** NDP target address: what an NS asks for and an NA answers with. */
  ndpTarget?: string;
  /** RFC 1191 §4 Next-Hop MTU, present on Fragmentation Needed (type 3, code 4). */
  icmpNextHopMtu?: number;
  /** Original IP header + first 8 bytes, encapsulated in an ICMP error (RFC 792). */
  icmpOrig?: IcmpOrigInfo;
  tcpFlags?: CaptureTcpFlags;
  tcpSeq?: number;
  tcpAck?: number;
  tcpWindow?: number;
  tcpUrgentPointer?: number;
  tcpOptions?: readonly TcpOption[];
  tcpChecksum?: number;
  tcpChecksumComputed?: number;
  tcpChecksumOk?: boolean;
  udpChecksum?: number;
  udpChecksumOk?: boolean;
  udpChecksumComputed?: number;
  ipChecksum?: number;
  ipChecksumOk?: boolean;
  arpOp?: 'request' | 'reply';
  arpSenderIp?: string;
  arpSenderMac?: string;
  arpTargetIp?: string;
  arpTargetMac?: string;
  raw: number[];
  rawLinkOffset: number;
  appPayload?: number[];
  vlanId?: number;
  vlanPriority?: number;
  vlanDei?: number;
  bootp?: BootpInfo;
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
  ipTos: number;
  protocol: number;
  ipFlags: number;
  ipTotalLength: number;
  l4: 'tcp' | 'udp' | 'icmp' | 'other';
  srcPort?: number;
  dstPort?: number;
  payloadLength?: number;
  quoted?: CaptureFrame;
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

function decodeDnsPayload(base: CaptureFrame, payload: unknown, stream = false): void {
  if (!(payload instanceof Uint8Array)) return;
  let msg: DnsMessage;
  try {
    const bytes = stream ? unframeDnsMessage(payload) : payload;
    if (!bytes) return;
    msg = decodeDnsMessage(bytes);
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

const RIP_AUTH_AFI = 0xffff;
const RIP_AUTH_PASSWORD = 2;
const RIP_PASSWORD_BYTES = 16;

function ripWireBytes(rip: RIPPacket): number[] {
  const bytes = [rip.command, rip.version & 0xff, 0, 0];
  if (rip.auth !== undefined) {
    const password = Array.from(new TextEncoder().encode(rip.auth.digest)).slice(0, RIP_PASSWORD_BYTES);
    bytes.push(...u16(RIP_AUTH_AFI), ...u16(RIP_AUTH_PASSWORD), ...padTo(password, RIP_PASSWORD_BYTES));
  }
  for (const entry of rip.entries) {
    const versionTwo = rip.version >= 2;
    bytes.push(...u16(entry.afi), ...u16(versionTwo ? entry.routeTag : 0), ...ipBytes(entry.ipAddress.toString()),
      ...(versionTwo ? ipBytes(entry.subnetMask.toString()) : [0, 0, 0, 0]),
      ...(versionTwo ? ipBytes(entry.nextHop.toString()) : [0, 0, 0, 0]), ...u32(entry.metric >>> 0));
  }
  return bytes;
}

function appPayloadBytes(payload: unknown): number[] | undefined {
  if ((payload as { type?: string } | null)?.type === 'rip') return ripWireBytes(payload as RIPPacket);
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

function padTo(bytes: number[], length: number): number[] {
  while (bytes.length < length) bytes.push(0);
  return bytes;
}

function addressText(address: { toString(): string }): string {
  return address.toString().replace(/%.*$/, '');
}

function synthIcmpBytes(icmp: ICMPPacket, expectedLength: number): number[] {
  const quoted = icmp.originalPacket === undefined ? undefined : synthIpv4Bytes(icmp.originalPacket);
  const message = icmpWireBytes({
    type: icmpTypeNumber(icmp.icmpType), code: icmp.code, id: icmp.id, sequence: icmp.sequence,
    mtu: icmp.mtu, pointer: icmp.pointer, gateway: icmp.gateway === undefined ? undefined : ipBytes(icmp.gateway.toString()),
    timestamps: icmp.timestamps, quoted, dataSize: icmp.dataSize ?? 0,
  });
  if (message.length >= expectedLength) return message;
  return icmpWireBytes({
    type: icmpTypeNumber(icmp.icmpType), code: icmp.code, id: icmp.id, sequence: icmp.sequence,
    mtu: icmp.mtu, pointer: icmp.pointer, gateway: icmp.gateway === undefined ? undefined : ipBytes(icmp.gateway.toString()),
    timestamps: icmp.timestamps, quoted: padTo(quoted ?? [], expectedLength - 8), dataSize: Math.max(icmp.dataSize ?? 0, expectedLength - 8),
  });
}

function synthTcpBytes(seg: TcpSegment, sourceIp: string, destinationIp: string, payloadLength: number): number[] {
  const corrupt = seg.checksum !== 0 && computeTcpChecksum(seg, sourceIp, destinationIp) !== seg.checksum;
  const payload = padTo(appPayloadBytes(seg.payload) ?? [], payloadLength);
  return tcpWireBytes({
    sourcePort: seg.sourcePort, destinationPort: seg.destinationPort, sequence: seg.sequence, acknowledgement: seg.acknowledgement,
    dataOffset: Math.max(5, seg.dataOffset || 5), flagBits: tcpFlagBits(seg.flags), window: seg.window,
    urgentPointer: seg.urgentPointer, options: seg.options, payload,
  }, sourceIp, destinationIp, corrupt);
}

function synthUdpBytes(udp: UDPPacket, sourceIp: string, destinationIp: string): number[] {
  const payload = padTo(appPayloadBytes(udp.payload) ?? [], Math.max(0, udp.length - 8));
  const present = udp.checksum !== 0 || sourceIp.includes(':');
  const corrupt = udp.checksum !== 0 && computeUdpChecksum(udp, sourceIp, destinationIp) !== udp.checksum;
  return udpWireBytes(udp.sourcePort, udp.destinationPort, udp.length, payload, sourceIp, destinationIp, present, corrupt);
}

function synthUdpLiteBytes(udp: UDPLitePacket): number[] {
  return [
    ...u16(udp.sourcePort), ...u16(udp.destinationPort),
    ...u16(udp.checksumCoverage), ...u16(udp.checksum & 0xffff),
    ...(appPayloadBytes(udp.payload) ?? []),
  ];
}

function synthL4Bytes(pkt: IPv4Packet): number[] {
  const payload = pkt.payload as { type?: string };
  const source = pkt.sourceIP.toString();
  const destination = pkt.destinationIP.toString();
  const l4Length = Math.max(0, (pkt.totalLength ?? 20) - (pkt.ihl ?? 5) * 4);
  if (payload?.type === 'icmp') return synthIcmpBytes(pkt.payload as ICMPPacket, l4Length);
  if (payload?.type === 'tcp') {
    const seg = normalizeTcpSegment(pkt.payload);
    return synthTcpBytes(seg, source, destination, Math.max(0, l4Length - Math.max(5, seg.dataOffset || 5) * 4));
  }
  if (payload?.type === 'udp') return synthUdpBytes(pkt.payload as UDPPacket, source, destination);
  if (payload?.type === 'udplite') return synthUdpLiteBytes(pkt.payload as UDPLitePacket);
  if (payload?.type === 'ospf') return ospfPacketBytes(pkt.payload as OSPFPacket) ?? [];
  return [];
}

const FRAGMENT_BODY_CACHE_LIMIT = 64;
const fragmentBodies = new Map<string, number[]>();

function rememberFragmentBody(key: string, body: number[]): void {
  fragmentBodies.delete(key);
  fragmentBodies.set(key, body);
  if (fragmentBodies.size > FRAGMENT_BODY_CACHE_LIMIT) fragmentBodies.delete(fragmentBodies.keys().next().value as string);
}

function fragmentSlice(key: string, offsetBytes: number, length: number): number[] {
  const whole = fragmentBodies.get(key) ?? [];
  return padTo(whole.slice(offsetBytes, offsetBytes + length), length);
}

function ipv4FragmentBody(pkt: IPv4Packet, headerBytes: number): number[] {
  const length = Math.max(0, (pkt.totalLength ?? 20) - headerBytes);
  const key = `4|${pkt.sourceIP}|${pkt.destinationIP}|${pkt.identification}|${pkt.protocol}`;
  if (pkt.fragmentOffset === 0 && !isIPv4FragmentData(pkt.payload)) {
    const whole = synthL4Bytes(pkt);
    rememberFragmentBody(key, whole);
    return padTo(whole.slice(0, length), length);
  }
  return fragmentSlice(key, pkt.fragmentOffset * 8, length);
}

function synthIpv4Bytes(pkt: IPv4Packet): number[] {
  const optionBytes = encodeIPv4Options(pkt.options);
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
    ...optionBytes,
  ];
  const fragmentOfDatagram = pkt.fragmentOffset > 0 || (pkt.flags & 0x1) !== 0;
  return [...header, ...(fragmentOfDatagram ? ipv4FragmentBody(pkt, (pkt.ihl ?? 5) * 4) : synthL4Bytes(pkt))];
}

const NDP_OPTION_SOURCE_LINK = 1;
const NDP_OPTION_TARGET_LINK = 2;
const NDP_OPTION_PREFIX = 3;
const NDP_OPTION_MTU = 5;

function ndpOptionBytes(options: readonly NDPOption[]): number[] {
  const bytes: number[] = [];
  for (const option of options) {
    if (option.optionType === 'source-link-layer' || option.optionType === 'target-link-layer') {
      bytes.push(option.optionType === 'source-link-layer' ? NDP_OPTION_SOURCE_LINK : NDP_OPTION_TARGET_LINK, 1, ...macBytes(option.address.toString()));
    } else if (option.optionType === 'prefix-info') {
      bytes.push(NDP_OPTION_PREFIX, 4, option.prefixLength & 0xff, (option.onLink ? 0x80 : 0) | (option.autonomous ? 0x40 : 0),
        ...u32(option.validLifetime >>> 0), ...u32(option.preferredLifetime >>> 0), 0, 0, 0, 0,
        ...ipv6Bytes(option.prefix.getHextets()));
    } else if (option.optionType === 'mtu') {
      bytes.push(NDP_OPTION_MTU, 1, 0, 0, ...u32(option.mtu >>> 0));
    }
  }
  return bytes;
}

function ndpBodyBytes(ndp: NDPMessage): number[] {
  switch (ndp.ndpType) {
    case 'router-solicitation': return [0, 0, 0, 0, ...ndpOptionBytes(ndp.options)];
    case 'router-advertisement':
      return [ndp.curHopLimit & 0xff, (ndp.managedFlag ? 0x80 : 0) | (ndp.otherConfigFlag ? 0x40 : 0), ...u16(ndp.routerLifetime & 0xffff),
        ...u32(ndp.reachableTime >>> 0), ...u32(ndp.retransTimer >>> 0), ...ndpOptionBytes(ndp.options)];
    case 'neighbor-solicitation': return [0, 0, 0, 0, ...ipv6Bytes(ndp.targetAddress.getHextets()), ...ndpOptionBytes(ndp.options)];
    case 'neighbor-advertisement':
      return [(ndp.routerFlag ? 0x80 : 0) | (ndp.solicitedFlag ? 0x40 : 0) | (ndp.overrideFlag ? 0x20 : 0), 0, 0, 0,
        ...ipv6Bytes(ndp.targetAddress.getHextets()), ...ndpOptionBytes(ndp.options)];
  }
}

function synthIcmpv6Bytes(icmp: ICMPv6Packet, sourceIp: string, destinationIp: string, expectedLength: number): number[] {
  const type = icmpv6TypeNumber(icmp.icmpType);
  let rest: number[];
  if (icmp.ndp !== undefined) {
    rest = ndpBodyBytes(icmp.ndp);
  } else if (type === 128 || type === 129) {
    rest = [...u16((icmp.id ?? 0) & 0xffff), ...u16((icmp.sequence ?? 0) & 0xffff)];
    for (let i = 0; i < (icmp.dataSize ?? 0); i++) rest.push(i & 0xff);
  } else if (type === 2) {
    rest = u32((icmp.mtu ?? 0) >>> 0);
  } else if (type === 4) {
    rest = u32((icmp.pointer ?? 0) >>> 0);
  } else {
    rest = [0, 0, 0, 0];
  }
  if (icmp.invokingPacket !== undefined && type >= 1 && type <= 4) rest.push(...synthIpv6Bytes(icmp.invokingPacket));
  if (expectedLength > 4) padTo(rest, expectedLength - 4);
  return icmpv6WireBytes(type, icmp.code, rest, sourceIp, destinationIp);
}

function synthL4BytesV6(pkt: IPv6Packet): number[] {
  const payload = pkt.payload as { type?: string };
  const source = addressText(pkt.sourceIP);
  const destination = addressText(pkt.destinationIP);
  if (payload?.type === 'icmpv6') return synthIcmpv6Bytes(pkt.payload as ICMPv6Packet, source, destination, pkt.payloadLength);
  if (payload?.type === 'tcp') {
    const seg = normalizeTcpSegment(pkt.payload);
    return synthTcpBytes(seg, source, destination, Math.max(0, pkt.payloadLength - Math.max(5, seg.dataOffset || 5) * 4));
  }
  if (payload?.type === 'udp') return synthUdpBytes(pkt.payload as UDPPacket, source, destination);
  if (payload?.type === 'udplite') return synthUdpLiteBytes(pkt.payload as UDPLitePacket);
  return [];
}

function synthIpv6PayloadBytes(pkt: IPv6Packet): number[] {
  const fragment = ipv6FragmentOf(pkt);
  if (fragment === null) return synthL4BytesV6(pkt);
  const offsetField = ((fragment.fragmentOffset & 0x1fff) << 3) | (fragment.moreFragments ? 1 : 0);
  const header = [fragment.nextHeader & 0xff, 0, ...u16(offsetField), ...u32(fragment.identification >>> 0)];
  const key = `6|${pkt.sourceIP}|${pkt.destinationIP}|${fragment.identification}`;
  const first = ipv6FirstFragmentView(pkt);
  if (first !== null) {
    const whole = synthL4BytesV6(first);
    rememberFragmentBody(key, whole);
    return [...header, ...padTo(whole.slice(0, fragment.length), fragment.length)];
  }
  return [...header, ...fragmentSlice(key, fragment.fragmentOffset * 8, fragment.length)];
}

function synthIpv6Bytes(pkt: IPv6Packet): number[] {
  const versionTrafficFlow = (6 << 28) | ((pkt.trafficClass & 0xff) << 20) | (pkt.flowLabel & 0xfffff);
  const payload = synthIpv6PayloadBytes(pkt);
  const header = [
    ...u32(versionTrafficFlow >>> 0),
    ...u16(Math.max(pkt.payloadLength, payload.length) & 0xffff),
    pkt.nextHeader & 0xff,
    pkt.hopLimit & 0xff,
    ...ipv6Bytes(pkt.sourceIP.getHextets()),
    ...ipv6Bytes(pkt.destinationIP.getHextets()),
  ];
  return [...header, ...payload];
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
    ...(arp.operation === 'reply' ? macBytes(arp.targetMAC.toString()) : [0, 0, 0, 0, 0, 0]),
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

const MINIMUM_RECEIVED_FRAME_BYTES = 60;

function decodeEthernetFrameBytes(
  frame: EthernetFrame,
  iface: string,
  direction: CaptureDirection,
  at: Date,
  atMicros?: number,
): CaptureFrame {
  const tag = dot1qTagOf(frame);
  const base: CaptureFrame = {
    at,
    atMicros,
    iface,
    direction,
    linkType: 'EN10MB',
    srcMac: frame.srcMAC.toString(),
    dstMac: frame.dstMAC.toString(),
    etherType: frame.etherType,
    l3: 'other',
    l4: 'none',
    length: direction === 'in'
      ? Math.max(MINIMUM_RECEIVED_FRAME_BYTES, ethernetFrameBytesWithoutFcs(frame))
      : ethernetFrameBytesWithoutFcs(frame),
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
    base.arpTargetMac = arp.operation === 'reply' ? arp.targetMAC.toString() : '00:00:00:00:00:00';
    const built = withEthernet(frame, synthArpBytes(arp));
    base.raw = padTo(built.raw, base.length);
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
    base.ipTos = ip.tos;
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
    reconcileTransportChecksums(base, (ip.ihl ?? 5) * 4);
    return base;
  }

  if (frame.etherType === ETHERTYPE_IPV6) {
    const ip6 = frame.payload as IPv6Packet;
    base.l3 = 'ipv6';
    base.srcIp = addressText(ip6.sourceIP);
    base.dstIp = addressText(ip6.destinationIP);
    base.ttl = ip6.hopLimit;
    base.ipTrafficClass = ip6.trafficClass;
    base.ipFlowLabel = ip6.flowLabel;
    base.ipProtocol = ip6.nextHeader;
    base.ipTotalLength = ip6.payloadLength + 40;
    base.ipHeaderLen = 40;
    decodeIpv6Fragmentable(base, ip6);
    const built = withEthernet(frame, synthIpv6Bytes(ip6));
    base.raw = built.raw;
    base.rawLinkOffset = built.offset;
    if (base.fragment6 === undefined) reconcileTransportChecksums(base, 40);
    return base;
  }

  if (frame.etherType === ETHERTYPE_CDP && (frame.payload as { type?: string } | undefined)?.type === 'cdp') {
    const snap = [...CDP_SNAP_HEADER, ...cdpPayloadBytes(frame.payload as CdpFrame)];
    const eth = [...macBytes(frame.dstMAC.toString()), ...macBytes(frame.srcMAC.toString()), ...u16(snap.length)];
    base.l3 = 'cdp';
    base.raw = [...eth, ...snap];
    base.rawLinkOffset = eth.length + CDP_SNAP_HEADER.length;
    base.length = Math.max(base.raw.length, 60);
    return base;
  }

  const built = withEthernet(frame, []);
  base.raw = built.raw;
  base.rawLinkOffset = built.offset;
  return base;
}

function reconcileTransportChecksums(base: CaptureFrame, networkHeaderBytes: number): void {
  if (base.l4 !== 'tcp' && base.l4 !== 'udp') return;
  if (base.l3 === 'ipv4' && (base.ipFragmentOffset ?? 0) > 0) return;
  const start = base.rawLinkOffset + networkHeaderBytes;
  const length = (base.ipTotalLength ?? 0) - networkHeaderBytes;
  if (length <= 0 || base.raw.length < start + length) return;
  const segment = base.raw.slice(start, start + length);
  const field = base.l4 === 'tcp' ? 16 : 6;
  const stored = (segment[field] << 8) | segment[field + 1];
  segment[field] = 0;
  segment[field + 1] = 0;
  const real = transportChecksum(base.srcIp ?? '', base.dstIp ?? '', base.l4 === 'tcp' ? WIRE_PROTOCOLS.tcp : WIRE_PROTOCOLS.udp, segment);
  if (base.l4 === 'tcp') {
    base.tcpChecksum = stored;
    base.tcpChecksumComputed = real;
    base.tcpChecksumOk = stored === real;
    return;
  }
  base.udpChecksum = stored;
  base.udpChecksumComputed = real === 0 ? 0xffff : real;
  base.udpChecksumOk = (stored === 0 && base.l3 === 'ipv4') || stored === base.udpChecksumComputed;
}

export function decodeEthernetFrame(
  frame: EthernetFrame,
  iface: string,
  direction: CaptureDirection,
  at: Date,
  atMicros?: number,
): CaptureFrame {
  const base = decodeEthernetFrameBytes(frame, iface, direction, at, atMicros);
  if (base.l3 === 'ipv6' && base.fragment6 === undefined) {
    const carried = base.raw.length - base.rawLinkOffset;
    if (carried > (base.ipTotalLength ?? 0)) base.ipTotalLength = carried;
  }
  base.length = Math.max(base.length, base.raw.length);
  base.raw = padTo(base.raw, base.length);
  return base;
}

function decodeIcmpOrig(orig: IPv4Packet, outer: CaptureFrame): IcmpOrigInfo {
  const info: IcmpOrigInfo = {
    srcIp: orig.sourceIP.toString(),
    dstIp: orig.destinationIP.toString(),
    ttl: orig.ttl,
    ipId: orig.identification,
    ipTos: orig.tos ?? 0,
    protocol: orig.protocol,
    ipFlags: orig.flags,
    ipTotalLength: orig.totalLength,
    l4: 'other',
    quoted: decodeEthernetFrame(
      { srcMAC: LOOPBACK_MAC, dstMAC: LOOPBACK_MAC, etherType: ETHERTYPE_IPV4, payload: orig },
      outer.iface, outer.direction, outer.at, outer.atMicros,
    ),
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
  // `print-ip.c:470` : seul le fragment de decalage NUL porte l'en-tete
  // de transport. Le decoder sur les suivants fabriquait un en-tete TCP
  // de zeros — ports 0, sequence 0, somme 0 — c'est-a-dire la
  // description d'octets qui ne sont pas dans le paquet.
  if (ip.fragmentOffset > 0) {
    base.l4 = 'other';
    base.payloadLength = Math.max(0, ip.totalLength - (ip.ihl ?? 5) * 4);
    return;
  }
  if (ip.protocol === IP_PROTO_ICMP) {
    const icmp = ip.payload as ICMPPacket;
    base.l4 = 'icmp';
    base.icmpType = icmp.icmpType;
    base.icmpCode = icmp.code;
    base.icmpId = icmp.id;
    base.icmpSeq = icmp.sequence;
    base.icmpTimestamps = icmp.timestamps;
    base.payloadLength = Math.max(0, ip.totalLength - (ip.ihl ?? 5) * 4);
    base.icmpNextHopMtu = icmp.mtu;
    if (icmp.originalPacket) base.icmpOrig = decodeIcmpOrig(icmp.originalPacket, base);
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
    base.tcpUrgentPointer = seg.urgentPointer;
    base.tcpOptions = seg.options;
    base.tcpChecksum = seg.checksum;
    base.tcpChecksumComputed = computeTcpChecksum(seg, base.srcIp!, base.dstIp!);
    base.tcpChecksumOk = seg.checksum === 0 || base.tcpChecksumComputed === seg.checksum;
    base.payloadLength = Math.max(0, (ip.totalLength ?? 40) - (ip.ihl ?? 5) * 4 - seg.dataOffset * 4);
    base.appPayload = appPayloadBytes(seg.payload);
    if (seg.sourcePort === 53 || seg.destinationPort === 53) {
      decodeDnsPayload(base, seg.payload, true);
    }
    return;
  }
  if (ip.protocol === IP_PROTO_UDP) {
    const udp = ip.payload as UDPPacket;
    base.l4 = 'udp';
    base.srcPort = udp.sourcePort;
    base.dstPort = udp.destinationPort;
    base.udpChecksum = udp.checksum;
    base.udpChecksumComputed = computeUdpChecksum(udp, base.srcIp!, base.dstIp!);
    base.udpChecksumOk = udp.checksum === 0 || base.udpChecksumComputed === udp.checksum;
    base.payloadLength = Math.max(0, (udp.length ?? 8) - 8);
    base.appPayload = appPayloadBytes(udp.payload);
    if (udp.sourcePort === 53 || udp.destinationPort === 53) {
      decodeDnsPayload(base, udp.payload);
    }
    if ((udp.sourcePort === 67 || udp.sourcePort === 68) && (udp.destinationPort === 67 || udp.destinationPort === 68)
      && udp.payload instanceof DHCPPacket) {
      base.bootp = decodeBootp(udp.payload) ?? undefined;
    }
    return;
  }
  base.l4 = 'other';
}

function decodeIpv6Fragmentable(base: CaptureFrame, ip6: IPv6Packet): void {
  const fragment = ipv6FragmentOf(ip6);
  if (fragment === null) {
    decodeIpv6Payload(base, ip6);
    return;
  }
  base.l4 = 'other';
  base.fragment6 = {
    identification: fragment.identification,
    offsetBytes: fragment.fragmentOffset * 8,
    length: ip6.payloadLength - 8,
  };
  const first = ipv6FirstFragmentView(ip6);
  if (first === null) return;
  const inner: CaptureFrame = { ...base, l4: 'none', fragment6: undefined, ipProtocol: first.nextHeader };
  decodeIpv6Payload(inner, first);
  base.fragment6.inner = inner;
}

function decodeIcmpOrig6(orig: IPv6Packet): IcmpOrigInfo {
  const info: IcmpOrigInfo = {
    srcIp: addressText(orig.sourceIP),
    dstIp: addressText(orig.destinationIP),
    ttl: orig.hopLimit,
    ipId: 0,
    ipTos: orig.trafficClass,
    protocol: orig.nextHeader,
    ipFlags: 0,
    ipTotalLength: 40 + orig.payloadLength,
    l4: 'other',
  };
  if (orig.nextHeader === IP_PROTO_UDP) {
    const udp = orig.payload as UDPPacket;
    info.l4 = 'udp';
    info.srcPort = udp.sourcePort;
    info.dstPort = udp.destinationPort;
    info.payloadLength = Math.max(0, (udp.length ?? 8) - 8);
  } else if (orig.nextHeader === IP_PROTO_TCP) {
    const seg = normalizeTcpSegment(orig.payload);
    info.l4 = 'tcp';
    info.srcPort = seg.sourcePort;
    info.dstPort = seg.destinationPort;
    info.payloadLength = Math.max(0, orig.payloadLength - seg.dataOffset * 4);
  } else if (orig.nextHeader === IP_PROTO_ICMPV6) {
    info.l4 = 'icmp';
  }
  return info;
}

function decodeIpv6Payload(base: CaptureFrame, ip6: IPv6Packet): void {
  if (ip6.nextHeader === IP_PROTO_ICMPV6) {
    const icmp = ip6.payload as ICMPv6Packet;
    base.l4 = 'icmp6';
    base.icmpType = icmp.icmpType;
    base.icmpCode = icmp.code;
    base.icmpId = icmp.id;
    base.icmpSeq = icmp.sequence;
    base.icmpNextHopMtu = icmp.mtu;
    base.icmpPointer = icmp.pointer;
    if (icmp.invokingPacket) base.icmpOrig = decodeIcmpOrig6(icmp.invokingPacket);
    base.payloadLength = ip6.payloadLength;
    const ndp = icmp.ndp as { targetAddress?: { toString(): string } } | undefined;
    if (ndp?.targetAddress) base.ndpTarget = ndp.targetAddress.toString();
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
    base.tcpUrgentPointer = seg.urgentPointer;
    base.tcpOptions = seg.options;
    base.tcpChecksum = seg.checksum;
    base.tcpChecksumComputed = computeTcpChecksum(seg, base.srcIp!, base.dstIp!);
    base.tcpChecksumOk = seg.checksum === 0 || base.tcpChecksumComputed === seg.checksum;
    base.payloadLength = Math.max(0, ip6.payloadLength - seg.dataOffset * 4);
    base.appPayload = appPayloadBytes(seg.payload);
    if (seg.sourcePort === 53 || seg.destinationPort === 53) {
      decodeDnsPayload(base, seg.payload, true);
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
    base.appPayload = appPayloadBytes(udp.payload);
    if (udp.sourcePort === 53 || udp.destinationPort === 53) {
      decodeDnsPayload(base, udp.payload);
    }
    return;
  }
  base.l4 = 'other';
}

const LOOPBACK_MAC = new MACAddress('00:00:00:00:00:00');

export function makeTcpFrame(
  pkt: {
    at: Date; srcIp: string; srcPort: number; dstIp: string; dstPort: number;
    flags: string; seq: number; ack: number; length: number;
    payload?: Uint8Array;
    packet?: IPv4Packet | IPv6Packet;
  },
  iface: string,
): CaptureFrame {
  if (pkt.packet) {
    return decodeEthernetFrame({
      srcMAC: LOOPBACK_MAC, dstMAC: LOOPBACK_MAC,
      etherType: pkt.packet.type === 'ipv6' ? ETHERTYPE_IPV6 : ETHERTYPE_IPV4,
      payload: pkt.packet,
    } as EthernetFrame, iface, 'in', pkt.at);
  }
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
    5 << 4, tcpFlagBits(flags),
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
    appPayload: pkt.payload ? Array.from(pkt.payload) : undefined,
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
  const icmp = [icmpTypeNumber(icmpType), 0, ...u16(0), ...u16(id & 0xffff), ...u16(seq & 0xffff)];
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
