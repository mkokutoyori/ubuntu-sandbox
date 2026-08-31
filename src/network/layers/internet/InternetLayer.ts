import type {
  EthernetFrame, IPv4Packet, IPv4HeaderOptions, IPAddress, MACAddress, SubnetMask,
} from '../../core/types';
import {
  computeIPv4Checksum, verifyIPv4Checksum, createIPv4Packet, ETHERTYPE_IPV4,
} from '../../core/types';
import { isMulticastIpv4 } from '../../core/ip';

export type Ipv4DestinationClass =
  | 'limited-broadcast'
  | 'link-local-multicast'
  | 'multicast'
  | 'unicast';

const LIMITED_BROADCAST = '255.255.255.255';

export function classifyIpv4Destination(destination: IPAddress): Ipv4DestinationClass {
  const text = destination.toString();
  if (text === LIMITED_BROADCAST) return 'limited-broadcast';
  if (!isMulticastIpv4(text)) return 'unicast';
  const octets = destination.getOctets();
  return octets[0] === 224 && octets[1] === 0 && octets[2] === 0
    ? 'link-local-multicast'
    : 'multicast';
}

export interface ConnectedIpv4Prefix {
  readonly address: IPAddress;
  readonly mask: SubnetMask;
}

export function isDirectedBroadcast(
  destination: IPAddress, connected: readonly ConnectedIpv4Prefix[],
): boolean {
  if (classifyIpv4Destination(destination) !== 'unicast') return false;
  return connected.some(({ address, mask }) =>
    destination.isBroadcastFor(mask)
    && destination.networkAddress(mask).equals(address.networkAddress(mask)));
}

export interface ConnectedIpv4Port {
  getIPAddress(): IPAddress | null;
  getSubnetMask(): SubnetMask | null;
  getSecondaryIPs?(): readonly { ip: IPAddress; mask: SubnetMask }[];
}

export function connectedPrefixesOfPort(port: ConnectedIpv4Port): ConnectedIpv4Prefix[] {
  const primary = port.getIPAddress();
  const mask = port.getSubnetMask();
  return [
    ...(primary && mask ? [{ address: primary, mask }] : []),
    ...(port.getSecondaryIPs?.() ?? []).map((e) => ({ address: e.ip, mask: e.mask })),
  ];
}

export function isUnicastDestination(
  destination: IPAddress, connected: readonly ConnectedIpv4Prefix[],
): boolean {
  return classifyIpv4Destination(destination) === 'unicast'
    && !isDirectedBroadcast(destination, connected);
}

export type MartianSource = 'network-zero' | 'loopback' | 'not-unicast';

export function martianSource(source: IPAddress): MartianSource | null {
  const octets = source.getOctets();
  if (octets[0] === 0) return 'network-zero';
  if (octets[0] === 127) return 'loopback';
  if (classifyIpv4Destination(source) !== 'unicast') return 'not-unicast';
  if (octets[0] >= 240) return 'not-unicast';
  return null;
}

export type Ipv4HeaderProblem = 'checksum' | 'version' | 'ihl' | 'total-length';

export function ipv4HeaderProblem(packet: IPv4Packet): Ipv4HeaderProblem | null {
  if (!verifyIPv4Checksum(packet)) return 'checksum';
  if (packet.version !== 4) return 'version';
  if (packet.ihl < 5) return 'ihl';
  if (packet.totalLength < packet.ihl * 4) return 'total-length';
  return null;
}

export type TtlDecision =
  | { readonly kind: 'expired' }
  | { readonly kind: 'forward'; readonly packet: IPv4Packet };

export function decrementForForwarding(packet: IPv4Packet): TtlDecision {
  if (packet.ttl <= 1) return { kind: 'expired' };
  const forwarded: IPv4Packet = { ...packet, ttl: packet.ttl - 1, headerChecksum: 0 };
  forwarded.headerChecksum = computeIPv4Checksum(forwarded);
  return { kind: 'forward', packet: forwarded };
}

export interface Ipv4FrameRequest {
  readonly sourceIp: IPAddress;
  readonly destinationIp: IPAddress;
  readonly sourceMac: MACAddress;
  readonly destinationMac: MACAddress;
  readonly protocol: number;
  readonly ttl: number;
  readonly payload: unknown;
  readonly payloadBytes: number;
  readonly options?: IPv4HeaderOptions;
}

export function wrapIpv4InEthernet(
  packet: IPv4Packet, sourceMac: MACAddress, destinationMac: MACAddress,
): EthernetFrame {
  return {
    srcMAC: sourceMac, dstMAC: destinationMac,
    etherType: ETHERTYPE_IPV4, payload: packet,
  };
}

export function buildIpv4Frame(request: Ipv4FrameRequest): EthernetFrame {
  const packet = createIPv4Packet(
    request.sourceIp, request.destinationIp, request.protocol, request.ttl,
    request.payload, request.payloadBytes, request.options ?? {});
  return wrapIpv4InEthernet(packet, request.sourceMac, request.destinationMac);
}
