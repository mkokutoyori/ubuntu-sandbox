import {
  MACAddress, createIPv4Packet,
  type EthernetFrame, type IPAddress, type IPv4HeaderOptions, type IPv4Packet,
} from '../../core/types';
import { ipv4MulticastToMac } from '../../core/ip';
import { classifyIpv4Destination, wrapIpv4InEthernet } from './InternetLayer';

export interface Ipv4SendRequest {
  readonly destination: IPAddress;
  readonly protocol: number;
  readonly payload: unknown;
  readonly payloadBytes: number;
  readonly source?: IPAddress;
  readonly iface?: string;
  readonly ttl?: number;
  readonly tos?: number;
  readonly flags?: number;
  readonly headerBytes?: number;
}

export interface Ipv4EgressHost {
  sendIpv4Packet(request: Ipv4SendRequest): boolean;
}

export const DEFAULT_IPV4_TTL = 64;

export function ipv4HeaderOptionsOf(request: Ipv4SendRequest): IPv4HeaderOptions {
  return {
    ...(request.tos === undefined ? {} : { tos: request.tos }),
    ...(request.flags === undefined ? {} : { flags: request.flags }),
    ...(request.headerBytes === undefined ? {} : { headerBytes: request.headerBytes }),
  };
}

export function requiresNamedInterface(destination: IPAddress): boolean {
  return classifyIpv4Destination(destination) !== 'unicast';
}

export function linkDestinationFor(destination: IPAddress): MACAddress | null {
  switch (classifyIpv4Destination(destination)) {
    case 'limited-broadcast':
      return MACAddress.broadcast();
    case 'link-local-multicast':
    case 'multicast':
      return new MACAddress(ipv4MulticastToMac(destination.toString()));
    case 'unicast':
      return null;
  }
}

export interface NamedInterfacePort {
  getMAC(): MACAddress;
  getIPAddress(): IPAddress | null;
  isOperationallyUp(): boolean;
}

export interface NamedInterfaceHost {
  getPort(name: string): NamedInterfacePort | undefined;
  sendFrame(portName: string, frame: EthernetFrame): boolean | void;
}

export function sendOnNamedInterface(
  host: NamedInterfaceHost, request: Ipv4SendRequest,
): boolean {
  if (!request.iface) return false;
  const port = host.getPort(request.iface);
  if (!port || !port.isOperationallyUp()) return false;
  const source = request.source ?? port.getIPAddress();
  if (!source) return false;
  const linkDestination = linkDestinationFor(request.destination);
  if (!linkDestination) return false;

  return host.sendFrame(request.iface, wrapIpv4InEthernet(
    buildIpv4Packet(source, request), port.getMAC(), linkDestination)) !== false;
}

export function buildIpv4Packet(source: IPAddress, request: Ipv4SendRequest): IPv4Packet {
  return createIPv4Packet(
    source, request.destination, request.protocol, request.ttl ?? DEFAULT_IPV4_TTL,
    request.payload, request.payloadBytes, ipv4HeaderOptionsOf(request));
}
