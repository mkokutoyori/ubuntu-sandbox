/**
 * Shared L3/L2 frame builders.
 *
 * Every control-plane agent (HSRP, VRRP, GLBP, syslog, NTP, BFD, …) needs
 * the same three steps to put a payload on the wire: wrap it in UDP (when
 * UDP-based), build the IPv4 header with a valid checksum, then frame it in
 * Ethernet. Before this module each agent re-implemented the block inline
 * (~25 duplicated lines per agent); fixes to one copy never reached the
 * others. `createIPv4Packet` (core/types.ts) stays the canonical IPv4
 * header builder — these helpers compose it.
 */
import {
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  type IPv4HeaderOptions,
  MACAddress, IPAddress,
  createIPv4Packet, IP_PROTO_UDP, ETHERTYPE_IPV4,
} from './types';

export interface Ipv4FrameArgs {
  srcIp: IPAddress;
  dstIp: IPAddress;
  srcMac: MACAddress;
  dstMac: MACAddress;
  protocol: number;
  ttl: number;
  payload: unknown;
  /** L4 payload size in bytes (added to the 20-byte IPv4 header). */
  payloadLength: number;
  options?: IPv4HeaderOptions;
}

export interface UdpIpv4FrameArgs extends Omit<Ipv4FrameArgs, 'protocol' | 'payloadLength'> {
  srcPort: number;
  dstPort: number;
  /** UDP payload size in bytes (the 8-byte UDP header is added here). */
  payloadLength: number;
}

/** Wrap an already-built IPv4 packet in an Ethernet frame. */
export function wrapIpv4InEthernet(
  pkt: IPv4Packet, srcMac: MACAddress, dstMac: MACAddress,
): EthernetFrame {
  return { srcMAC: srcMac, dstMAC: dstMac, etherType: ETHERTYPE_IPV4, payload: pkt };
}

/** Build a ready-to-send Ethernet frame carrying an IPv4 packet. */
export function buildIpv4Frame(args: Ipv4FrameArgs): EthernetFrame {
  const pkt = createIPv4Packet(
    args.srcIp, args.dstIp, args.protocol, args.ttl,
    args.payload, args.payloadLength, args.options ?? {});
  return wrapIpv4InEthernet(pkt, args.srcMac, args.dstMac);
}

/** Build a ready-to-send Ethernet frame carrying a UDP datagram over IPv4. */
export function buildUdpIpv4Frame(args: UdpIpv4FrameArgs): EthernetFrame {
  const udp: UDPPacket = {
    type: 'udp',
    sourcePort: args.srcPort,
    destinationPort: args.dstPort,
    length: 8 + args.payloadLength,
    checksum: 0,
    payload: args.payload,
  };
  return buildIpv4Frame({
    ...args,
    protocol: IP_PROTO_UDP,
    payload: udp,
    payloadLength: udp.length,
  });
}
