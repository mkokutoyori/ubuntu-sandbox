import {
  ETHERTYPE_ARP, ETHERTYPE_IPV4, ETHERTYPE_IPV6, IP_PROTO_ICMP, IP_PROTO_ICMPV6, IP_PROTO_IPV6_FRAGMENT, IP_PROTO_TCP, IP_PROTO_UDP,
  IP_PROTO_UDPLITE, IPAddress, IPv6Address, MACAddress, decodeIPv4Options, icmpTypeOfNumber, icmpv6TypeOfNumber,
  type ARPPacket, type Dot1QTag, type EthernetFrame, type ICMPPacket, type ICMPv6Packet, type IPv4Packet, type IPv6Packet,
  type NDPMessage, type NDPOption, type UDPLitePacket, type UDPPacket,
} from '@/network/core/types';
import type { IPv4FragmentData } from '@/network/core/Ipv4Fragmentation';
import { isUndecodedPayload, undecodedPayload } from '@/network/core/UndecodedPayload';
import type { IPv6FragmentData, IPv6FragmentHeader } from '@/network/layers/internet/Ipv6Fragmentation';
import { DHCPPacket } from '@/network/dhcp/DHCPPacket';
import { CDP_SNAP_HEADER } from '@/network/cdp/CdpWire';
import { ETHERTYPE_CDP } from '@/network/cdp/types';
import { DTP_SNAP_HEADER } from '@/network/dtp/DtpWire';
import { ETHERTYPE_DTP } from '@/network/dtp/types';
import { UDLD_SNAP_HEADER } from '@/network/udld/UdldWire';
import { ETHERTYPE_UDLD } from '@/network/udld/types';
import { VTP_SNAP_HEADER } from '@/network/vtp/VtpWire';
import { ETHERTYPE_VTP } from '@/network/vtp/types';
import { ETHERTYPE_LLDP } from '@/network/lldp/types';
import { PVST_SNAP_HEADER, STP_LLC_HEADER } from '@/network/stp/StpWire';
import { ETHERTYPE_STP } from '@/network/stp/types';
import { decodeTci } from '@/network/layers/link/vlan/VlanTag';
import { bogusChecksum, onesComplement, pushBytesAsWords, pushPseudoHeader } from '@/network/layers/transport/L4Checksum';
import { computeUdpChecksum } from '@/network/layers/transport/UdpChecksum';
import { computeTcpChecksum, type TcpOption, type TcpSegment } from '@/network/tcp/types';

const ETHERNET_HEADER_BYTES = 14;
const VLAN_TAG_BYTES = 4;
const ARP_BYTES = 28;
const IPV4_HEADER_BYTES = 20;
const IPV6_HEADER_BYTES = 40;
const IPV6_FRAGMENT_HEADER_BYTES = 8;
const TCP_HEADER_BYTES = 20;
const UDP_HEADER_BYTES = 8;
const ICMP_HEADER_BYTES = 8;
const ICMPV6_HEADER_BYTES = 4;
const QUOTED_L4_BYTES = 8;
const DHCP_FIXED_HEADER_AND_COOKIE_BYTES = 240;
const ETHERNET_II_MINIMUM_TYPE = 0x0600;
const VLAN_TPIDS: ReadonlySet<number> = new Set([0x8100, 0x88a8, 0x9100, 0x9200]);
const ICMP_ECHO_TYPES: ReadonlySet<number> = new Set([0, 8]);
const ICMP_QUOTING_TYPES: ReadonlySet<number> = new Set([3, 5, 11, 12]);
const ICMPV6_QUOTING_TYPES: ReadonlySet<number> = new Set([1, 2, 3, 4]);
const TCP_FLAG_BITS = { fin: 0x01, syn: 0x02, rst: 0x04, psh: 0x08, ack: 0x10, urg: 0x20, ece: 0x40, cwr: 0x80 } as const;
const TCP_OPTION = { end: 0, nop: 1, mss: 2, windowScale: 3, sackPermitted: 4, sack: 5, timestamp: 8 } as const;
const NDP_OPTION = { sourceLink: 1, targetLink: 2, prefix: 3, mtu: 5 } as const;

interface Endpoints {
  readonly source: string;
  readonly destination: string;
  readonly complete: boolean;
  readonly declared: number;
}

function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function macAt(bytes: Uint8Array, at: number): MACAddress {
  return new MACAddress(Array.from(bytes.subarray(at, at + 6)));
}

function ipv4At(bytes: Uint8Array, at: number): IPAddress {
  return new IPAddress(Array.from(bytes.subarray(at, at + 4)));
}

function ipv6At(bytes: Uint8Array, at: number): IPv6Address {
  const hextets: number[] = [];
  for (let i = 0; i < 8; i++) hextets.push(u16(bytes, at + 2 * i));
  return new IPv6Address(hextets);
}

interface LinkPayloadStart {
  readonly etherType: number;
  readonly at: number;
  readonly tags: Dot1QTag[];
}

function linkPayloadStart(bytes: Uint8Array): LinkPayloadStart | null {
  if (bytes.length < ETHERNET_HEADER_BYTES) return null;
  let etherType = u16(bytes, 12);
  let at = ETHERNET_HEADER_BYTES;
  const tags: Dot1QTag[] = [];
  while (VLAN_TPIDS.has(etherType) && tags.length < 2 && at + VLAN_TAG_BYTES <= bytes.length) {
    tags.push(decodeTci(etherType, u16(bytes, at)));
    etherType = u16(bytes, at + 2);
    at += VLAN_TAG_BYTES;
  }
  return { etherType, at, tags };
}

export function decodeEthernetBytes(bytes: Uint8Array): EthernetFrame | null {
  const start = linkPayloadStart(bytes);
  if (start === null) return null;
  const { etherType, at, tags } = start;
  const frame: EthernetFrame = { srcMAC: macAt(bytes, 6), dstMAC: macAt(bytes, 0), etherType, payload: decodeNetworkLayer(etherType, bytes.subarray(at)) };
  if (tags.length === 1) frame.dot1q = tags[0];
  if (tags.length === 2) {
    frame.outerDot1q = tags[0];
    frame.dot1q = tags[1];
  }
  return frame;
}

export type LinkControlProtocol = 'stp' | 'cdp' | 'lldp' | 'dtp' | 'vtp' | 'udld';

export interface LinkControlFrame {
  readonly protocol: LinkControlProtocol;
  readonly etherType: number;
  readonly payloadAt: number;
}

interface SnapProtocol {
  readonly header: readonly number[];
  readonly protocol: LinkControlProtocol;
  readonly etherType: number;
}

const SNAP_PROTOCOLS: readonly SnapProtocol[] = [
  { header: CDP_SNAP_HEADER, protocol: 'cdp', etherType: ETHERTYPE_CDP },
  { header: DTP_SNAP_HEADER, protocol: 'dtp', etherType: ETHERTYPE_DTP },
  { header: VTP_SNAP_HEADER, protocol: 'vtp', etherType: ETHERTYPE_VTP },
  { header: UDLD_SNAP_HEADER, protocol: 'udld', etherType: ETHERTYPE_UDLD },
  { header: PVST_SNAP_HEADER, protocol: 'stp', etherType: ETHERTYPE_STP },
];

function startsWith(bytes: Uint8Array, at: number, prefix: readonly number[]): boolean {
  return at + prefix.length <= bytes.length && prefix.every((value, index) => bytes[at + index] === value);
}

export function decodeLinkControl(bytes: Uint8Array): LinkControlFrame | null {
  const start = linkPayloadStart(bytes);
  if (start === null) return null;
  const { etherType, at } = start;
  if (etherType === ETHERTYPE_LLDP) return { protocol: 'lldp', etherType, payloadAt: at };
  if (etherType >= ETHERNET_II_MINIMUM_TYPE) return null;
  if (startsWith(bytes, at, STP_LLC_HEADER)) return { protocol: 'stp', etherType: ETHERTYPE_STP, payloadAt: at + STP_LLC_HEADER.length };
  const snap = SNAP_PROTOCOLS.find((candidate) => startsWith(bytes, at, candidate.header));
  return snap === undefined ? null : { protocol: snap.protocol, etherType: snap.etherType, payloadAt: at + snap.header.length };
}

function decodeNetworkLayer(etherType: number, body: Uint8Array): unknown {
  if (etherType >= ETHERNET_II_MINIMUM_TYPE) {
    if (etherType === ETHERTYPE_ARP) return decodeArp(body);
    if (etherType === ETHERTYPE_IPV4) return decodeIpv4(body);
    if (etherType === ETHERTYPE_IPV6) return decodeIpv6(body);
  }
  return undecodedPayload(body.slice());
}

function decodeArp(body: Uint8Array): ARPPacket | ReturnType<typeof undecodedPayload> {
  const operation = body.length >= ARP_BYTES ? u16(body, 6) : 0;
  const ethernetIpv4 = body.length >= ARP_BYTES && u16(body, 0) === 1 && u16(body, 2) === ETHERTYPE_IPV4 && body[4] === 6 && body[5] === 4;
  if (!ethernetIpv4 || (operation !== 1 && operation !== 2)) return undecodedPayload(body.slice());
  return {
    type: 'arp',
    operation: operation === 2 ? 'reply' : 'request',
    senderMAC: macAt(body, 8),
    senderIP: ipv4At(body, 14),
    targetMAC: macAt(body, 18),
    targetIP: ipv4At(body, 24),
  };
}

function decodeIpv4(body: Uint8Array): IPv4Packet | ReturnType<typeof undecodedPayload> {
  if (body.length < IPV4_HEADER_BYTES || body[0] >> 4 !== 4) return undecodedPayload(body.slice());
  const ihl = body[0] & 0x0f;
  const headerBytes = ihl * 4;
  const totalLength = u16(body, 2);
  if (ihl < 5 || totalLength < headerBytes) return undecodedPayload(body.slice());
  const cutInOptions = headerBytes > body.length;
  const flagsAndOffset = u16(body, 6);
  const flags = flagsAndOffset >> 13;
  const fragmentOffset = flagsAndOffset & 0x1fff;
  const protocol = body[9];
  const upper = cutInOptions ? new Uint8Array(0) : body.subarray(headerBytes, Math.min(totalLength, body.length));
  const packet: IPv4Packet = {
    type: 'ipv4',
    version: 4,
    ihl,
    tos: body[1],
    totalLength,
    identification: u16(body, 4),
    flags,
    fragmentOffset,
    ttl: body[8],
    protocol,
    headerChecksum: u16(body, 10),
    sourceIP: ipv4At(body, 12),
    destinationIP: ipv4At(body, 16),
    payload: null,
  };
  if (headerBytes > IPV4_HEADER_BYTES) {
    const options = decodeIPv4Options(Array.from(body.subarray(IPV4_HEADER_BYTES, headerBytes)));
    if (options.length > 0) packet.options = options;
  }
  if (cutInOptions) return packet;
  if (fragmentOffset > 0) {
    const placeholder: IPv4FragmentData = { type: 'ipv4-fragment-data', length: totalLength - headerBytes };
    packet.payload = placeholder;
    return packet;
  }
  const complete = upper.length >= totalLength - headerBytes && (flags & 0b001) === 0;
  packet.payload = decodeIpv4Upper(protocol, upper, { source: packet.sourceIP.toString(), destination: packet.destinationIP.toString(), complete, declared: totalLength - headerBytes });
  return packet;
}

function decodeIpv4Upper(protocol: number, upper: Uint8Array, endpoints: Endpoints): unknown {
  if (protocol === IP_PROTO_ICMP) return decodeIcmp(upper, endpoints);
  if (protocol === IP_PROTO_TCP) return decodeTcp(upper, endpoints);
  if (protocol === IP_PROTO_UDP) return decodeUdp(upper, endpoints);
  if (protocol === IP_PROTO_UDPLITE) return decodeUdpLite(upper);
  return undecodedPayload(upper.slice());
}

function checksumHolds(upper: Uint8Array, protocol: number, endpoints: Endpoints): boolean {
  if (!endpoints.complete) return true;
  const words: number[] = [];
  pushPseudoHeader(words, endpoints.source, endpoints.destination, protocol, upper.length);
  pushBytesAsWords(words, Array.from(upper));
  return onesComplement(words) === 0;
}

function isDhcpPorts(source: number, destination: number): boolean {
  return (source === 67 || source === 68) && (destination === 67 || destination === 68);
}

function dhcpPacketOf(body: Uint8Array): DHCPPacket | null {
  if (body.length < DHCP_FIXED_HEADER_AND_COOKIE_BYTES) return null;
  try {
    return DHCPPacket.deserialize(body);
  } catch {
    return null;
  }
}

function decodeUdp(upper: Uint8Array, endpoints: Endpoints): UDPPacket | ReturnType<typeof undecodedPayload> {
  if (upper.length < UDP_HEADER_BYTES) return undecodedPayload(upper.slice());
  const length = u16(upper, 4);
  const packet: UDPPacket = {
    type: 'udp',
    sourcePort: u16(upper, 0),
    destinationPort: u16(upper, 2),
    length,
    checksum: u16(upper, 6),
    payload: null,
  };
  const body = upper.slice(UDP_HEADER_BYTES, Math.max(UDP_HEADER_BYTES, Math.min(length, upper.length)));
  packet.payload = isDhcpPorts(packet.sourcePort, packet.destinationPort) ? (dhcpPacketOf(body) ?? body) : body;
  const absent = packet.checksum === 0 && !endpoints.source.includes(':');
  if (!absent) {
    const modelled = computeUdpChecksum(packet, endpoints.source, endpoints.destination);
    packet.checksum = checksumHolds(upper.subarray(0, Math.min(length, upper.length)), IP_PROTO_UDP, endpoints) ? modelled : bogusChecksum(modelled, IP_PROTO_UDP);
  }
  return packet;
}

function decodeUdpLite(upper: Uint8Array): UDPLitePacket | ReturnType<typeof undecodedPayload> {
  if (upper.length < UDP_HEADER_BYTES) return undecodedPayload(upper.slice());
  return {
    type: 'udplite',
    sourcePort: u16(upper, 0),
    destinationPort: u16(upper, 2),
    checksumCoverage: u16(upper, 4),
    checksum: u16(upper, 6),
    payload: upper.slice(UDP_HEADER_BYTES),
  };
}

function canonicalTcpOptions(wire: readonly TcpOption[]): TcpOption[] {
  const out: TcpOption[] = [];
  const nopsBefore = (): number => {
    let count = 0;
    while (out.length - count > 0 && out[out.length - 1 - count].kind === 'nop') count++;
    return count;
  };
  const dropNops = (count: number): void => {
    for (let i = 0; i < count; i++) out.pop();
  };
  for (const option of wire) {
    if (option.kind === 'window-scale' && nopsBefore() >= 1) dropNops(1);
    else if (option.kind === 'timestamp' && nopsBefore() >= 2 && out[out.length - 3]?.kind !== 'sack-permitted') dropNops(2);
    else if (option.kind === 'sack' && nopsBefore() >= 2) dropNops(2);
    out.push(option);
  }
  return out;
}

export function decodeTcpOptions(bytes: Uint8Array): TcpOption[] {
  const wire: TcpOption[] = [];
  let at = 0;
  while (at < bytes.length) {
    const kind = bytes[at];
    if (kind === TCP_OPTION.end) {
      wire.push({ kind: 'end' });
      break;
    }
    if (kind === TCP_OPTION.nop) {
      wire.push({ kind: 'nop' });
      at++;
      continue;
    }
    const length = bytes[at + 1];
    if (length === undefined || length < 2 || at + length > bytes.length) break;
    if (kind === TCP_OPTION.mss && length === 4) wire.push({ kind: 'mss', value: u16(bytes, at + 2) });
    else if (kind === TCP_OPTION.windowScale && length === 3) wire.push({ kind: 'window-scale', shift: bytes[at + 2] });
    else if (kind === TCP_OPTION.sackPermitted && length === 2) wire.push({ kind: 'sack-permitted' });
    else if (kind === TCP_OPTION.timestamp && length === 10) wire.push({ kind: 'timestamp', tsVal: u32(bytes, at + 2), tsEcr: u32(bytes, at + 6) });
    else if (kind === TCP_OPTION.sack && length >= 10 && (length - 2) % 8 === 0) {
      const blocks: Array<{ start: number; end: number }> = [];
      for (let block = at + 2; block < at + length; block += 8) blocks.push({ start: u32(bytes, block), end: u32(bytes, block + 4) });
      wire.push({ kind: 'sack', blocks });
    }
    at += length;
  }
  return canonicalTcpOptions(wire);
}

function decodeTcp(upper: Uint8Array, endpoints: Endpoints): TcpSegment | ReturnType<typeof undecodedPayload> {
  if (upper.length < TCP_HEADER_BYTES) return undecodedPayload(upper.slice());
  const dataOffset = upper[12] >> 4;
  if (dataOffset < 5) return undecodedPayload(upper.slice());
  const headerBytes = Math.min(dataOffset * 4, upper.length);
  const bits = upper[13];
  const segment: TcpSegment = {
    type: 'tcp',
    sourcePort: u16(upper, 0),
    destinationPort: u16(upper, 2),
    sequence: u32(upper, 4),
    acknowledgement: u32(upper, 8),
    dataOffset,
    flags: {
      fin: (bits & TCP_FLAG_BITS.fin) !== 0, syn: (bits & TCP_FLAG_BITS.syn) !== 0, rst: (bits & TCP_FLAG_BITS.rst) !== 0,
      psh: (bits & TCP_FLAG_BITS.psh) !== 0, ack: (bits & TCP_FLAG_BITS.ack) !== 0, urg: (bits & TCP_FLAG_BITS.urg) !== 0,
      ece: (bits & TCP_FLAG_BITS.ece) !== 0, cwr: (bits & TCP_FLAG_BITS.cwr) !== 0,
    },
    window: u16(upper, 14),
    checksum: u16(upper, 16),
    urgentPointer: u16(upper, 18),
    options: decodeTcpOptions(upper.subarray(TCP_HEADER_BYTES, headerBytes)),
    payload: upper.slice(headerBytes),
  };
  const modelled = computeTcpChecksum(segment, endpoints.source, endpoints.destination);
  segment.checksum = checksumHolds(upper, IP_PROTO_TCP, endpoints) ? modelled : bogusChecksum(modelled, IP_PROTO_TCP);
  return segment;
}

function partialQuotedUpper(protocol: number, head: Uint8Array): unknown | null {
  if (head.length < QUOTED_L4_BYTES) return null;
  if (protocol === IP_PROTO_UDP) {
    return { type: 'udp', sourcePort: u16(head, 0), destinationPort: u16(head, 2), length: u16(head, 4), checksum: u16(head, 6), payload: new Uint8Array(0) } satisfies UDPPacket;
  }
  if (protocol === IP_PROTO_TCP) {
    return {
      type: 'tcp', sourcePort: u16(head, 0), destinationPort: u16(head, 2), sequence: u32(head, 4), acknowledgement: 0, dataOffset: 5,
      flags: { fin: false, syn: false, rst: false, psh: false, ack: false, urg: false, ece: false, cwr: false },
      window: 0, checksum: 0, urgentPointer: 0, options: [], payload: new Uint8Array(0),
    } satisfies TcpSegment;
  }
  const echoType = icmpTypeOfNumber(head[0]);
  if (protocol === IP_PROTO_ICMP && ICMP_ECHO_TYPES.has(head[0]) && echoType !== null) {
    return { type: 'icmp', icmpType: echoType, code: head[1], id: u16(head, 4), sequence: u16(head, 6), dataSize: 0 } satisfies ICMPPacket;
  }
  return null;
}

function decodeQuotedIpv4(quoted: Uint8Array): IPv4Packet | undefined {
  const decoded = decodeIpv4(quoted);
  if (decoded.type !== 'ipv4') return undefined;
  if (isUndecodedPayload(decoded.payload)) {
    const headerBytes = decoded.ihl * 4;
    const partial = partialQuotedUpper(decoded.protocol, quoted.subarray(headerBytes, headerBytes + QUOTED_L4_BYTES));
    if (partial !== null) decoded.payload = partial;
  }
  return decoded;
}

function decodeIcmp(upper: Uint8Array, endpoints: Endpoints): ICMPPacket | ReturnType<typeof undecodedPayload> {
  if (upper.length < ICMP_HEADER_BYTES) return undecodedPayload(upper.slice());
  const typeNumber = upper[0];
  const icmpType = icmpTypeOfNumber(typeNumber);
  if (icmpType === null) return undecodedPayload(upper.slice());
  const packet: ICMPPacket = { type: 'icmp', icmpType, code: upper[1], id: 0, sequence: 0, dataSize: 0 };
  const body = upper.subarray(ICMP_HEADER_BYTES);
  if (ICMP_QUOTING_TYPES.has(typeNumber)) {
    if (typeNumber === 3 && upper[1] === 4) packet.mtu = u16(upper, 6);
    if (typeNumber === 12) packet.pointer = upper[4];
    if (typeNumber === 5) packet.gateway = ipv4At(upper, 4);
    const original = decodeQuotedIpv4(body);
    if (original !== undefined) packet.originalPacket = original;
    packet.dataSize = Math.max(body.length, endpoints.declared - ICMP_HEADER_BYTES);
    return packet;
  }
  packet.id = u16(upper, 4);
  packet.sequence = u16(upper, 6);
  if (typeNumber === 13 || typeNumber === 14) {
    if (body.length < 12) return undecodedPayload(upper.slice());
    packet.timestamps = { originate: u32(body, 0), receive: u32(body, 4), transmit: u32(body, 8) };
    return packet;
  }
  packet.dataSize = Math.max(body.length, endpoints.declared - ICMP_HEADER_BYTES);
  return packet;
}

function decodeNdpOptions(bytes: Uint8Array): NDPOption[] | null {
  const options: NDPOption[] = [];
  let at = 0;
  while (at < bytes.length) {
    const type = bytes[at];
    const units = bytes[at + 1];
    const length = units * 8;
    if (units === undefined || units === 0 || at + length > bytes.length) return null;
    if ((type === NDP_OPTION.sourceLink || type === NDP_OPTION.targetLink) && length === 8) {
      options.push({ optionType: type === NDP_OPTION.sourceLink ? 'source-link-layer' : 'target-link-layer', address: macAt(bytes, at + 2) });
    } else if (type === NDP_OPTION.prefix && length === 32) {
      options.push({
        optionType: 'prefix-info', prefixLength: bytes[at + 2], onLink: (bytes[at + 3] & 0x80) !== 0, autonomous: (bytes[at + 3] & 0x40) !== 0,
        validLifetime: u32(bytes, at + 4), preferredLifetime: u32(bytes, at + 8), prefix: ipv6At(bytes, at + 16),
      });
    } else if (type === NDP_OPTION.mtu && length === 8) {
      options.push({ optionType: 'mtu', mtu: u32(bytes, at + 4) });
    } else {
      return null;
    }
    at += length;
  }
  return options;
}

function decodeNdp(typeNumber: number, body: Uint8Array): NDPMessage | null {
  if (typeNumber === 133) {
    const options = body.length >= 4 ? decodeNdpOptions(body.subarray(4)) : null;
    return options === null ? null : { ndpType: 'router-solicitation', options };
  }
  if (typeNumber === 134) {
    const options = body.length >= 12 ? decodeNdpOptions(body.subarray(12)) : null;
    if (options === null) return null;
    return {
      ndpType: 'router-advertisement', curHopLimit: body[0], managedFlag: (body[1] & 0x80) !== 0, otherConfigFlag: (body[1] & 0x40) !== 0,
      routerLifetime: u16(body, 2), reachableTime: u32(body, 4), retransTimer: u32(body, 8), options,
    };
  }
  if (typeNumber === 135 || typeNumber === 136) {
    const options = body.length >= 20 ? decodeNdpOptions(body.subarray(20)) : null;
    if (options === null) return null;
    const targetAddress = ipv6At(body, 4);
    if (typeNumber === 135) return { ndpType: 'neighbor-solicitation', targetAddress, options };
    return {
      ndpType: 'neighbor-advertisement', routerFlag: (body[0] & 0x80) !== 0, solicitedFlag: (body[0] & 0x40) !== 0,
      overrideFlag: (body[0] & 0x20) !== 0, targetAddress, options,
    };
  }
  return null;
}

function decodeQuotedIpv6(quoted: Uint8Array): IPv6Packet | undefined {
  const decoded = decodeIpv6(quoted);
  return decoded.type === 'ipv6' ? decoded : undefined;
}

function decodeIcmpv6(upper: Uint8Array, endpoints: Endpoints): ICMPv6Packet | ReturnType<typeof undecodedPayload> {
  if (upper.length < ICMPV6_HEADER_BYTES) return undecodedPayload(upper.slice());
  const typeNumber = upper[0];
  const icmpType = icmpv6TypeOfNumber(typeNumber);
  if (icmpType === null) return undecodedPayload(upper.slice());
  const packet: ICMPv6Packet = { type: 'icmpv6', icmpType, code: upper[1] };
  const body = upper.subarray(ICMPV6_HEADER_BYTES);
  if (typeNumber === 128 || typeNumber === 129) {
    if (body.length < 4) return undecodedPayload(upper.slice());
    packet.id = u16(body, 0);
    packet.sequence = u16(body, 2);
    packet.dataSize = Math.max(body.length, endpoints.declared - ICMPV6_HEADER_BYTES) - 4;
    return packet;
  }
  if (typeNumber >= 133 && typeNumber <= 136) {
    const ndp = decodeNdp(typeNumber, body);
    if (ndp === null) return undecodedPayload(upper.slice());
    packet.ndp = ndp;
    return packet;
  }
  if (ICMPV6_QUOTING_TYPES.has(typeNumber) && body.length >= 4) {
    if (typeNumber === 2) packet.mtu = u32(body, 0);
    if (typeNumber === 4) packet.pointer = u32(body, 0);
    const invoking = decodeQuotedIpv6(body.subarray(4));
    if (invoking !== undefined) packet.invokingPacket = invoking;
    return packet;
  }
  return undecodedPayload(upper.slice());
}

function decodeIpv6Upper(nextHeader: number, upper: Uint8Array, endpoints: Endpoints): unknown {
  if (nextHeader === IP_PROTO_ICMPV6) return decodeIcmpv6(upper, endpoints);
  if (nextHeader === IP_PROTO_TCP) return decodeTcp(upper, endpoints);
  if (nextHeader === IP_PROTO_UDP) return decodeUdp(upper, endpoints);
  if (nextHeader === IP_PROTO_UDPLITE) return decodeUdpLite(upper);
  return undecodedPayload(upper.slice());
}

function decodeIpv6(body: Uint8Array): IPv6Packet | ReturnType<typeof undecodedPayload> {
  if (body.length < IPV6_HEADER_BYTES || body[0] >> 4 !== 6) return undecodedPayload(body.slice());
  const payloadLength = u16(body, 4);
  const nextHeader = body[6];
  const upper = body.subarray(IPV6_HEADER_BYTES, Math.min(IPV6_HEADER_BYTES + payloadLength, body.length));
  const packet: IPv6Packet = {
    type: 'ipv6',
    version: 6,
    trafficClass: ((body[0] & 0x0f) << 4) | (body[1] >> 4),
    flowLabel: ((body[1] & 0x0f) << 16) | u16(body, 2),
    payloadLength,
    nextHeader,
    hopLimit: body[7],
    sourceIP: ipv6At(body, 8),
    destinationIP: ipv6At(body, 24),
    payload: null,
  };
  if (nextHeader === IP_PROTO_IPV6_FRAGMENT && upper.length >= IPV6_FRAGMENT_HEADER_BYTES) {
    const offsetField = u16(upper, 2);
    const fragmentOffset = offsetField >> 3;
    const length = payloadLength - IPV6_FRAGMENT_HEADER_BYTES;
    const inner = upper.subarray(IPV6_FRAGMENT_HEADER_BYTES);
    const header: IPv6FragmentHeader = {
      type: 'ipv6-fragment',
      nextHeader: upper[0],
      fragmentOffset,
      moreFragments: (offsetField & 1) !== 0,
      identification: u32(upper, 4),
      length,
      payload: fragmentOffset === 0 ? decodeIpv6Upper(upper[0], inner, { source: packet.sourceIP.toString(), destination: packet.destinationIP.toString(), complete: false, declared: length }) : ({ type: 'ipv6-fragment-data', length } satisfies IPv6FragmentData),
    };
    packet.payload = header;
    return packet;
  }
  packet.payload = decodeIpv6Upper(nextHeader, upper, { source: packet.sourceIP.toString(), destination: packet.destinationIP.toString(), complete: upper.length >= payloadLength, declared: payloadLength });
  return packet;
}
