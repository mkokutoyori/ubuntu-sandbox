import { MACAddress, type EthernetFrame, type IPAddress, type IPv4HeaderOptions } from '../../core/types';
import { ipv4MulticastToMac } from '../../core/ip';
import { classifyIpv4Destination, buildIpv4Frame } from './InternetLayer';

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
}

export interface Ipv4EgressHost {
  sendIpv4Packet(request: Ipv4SendRequest): boolean;
}

export const DEFAULT_IPV4_TTL = 64;

export function ipv4HeaderOptionsOf(request: Ipv4SendRequest): IPv4HeaderOptions {
  return {
    ...(request.tos === undefined ? {} : { tos: request.tos }),
    ...(request.flags === undefined ? {} : { flags: request.flags }),
  };
}

export function requiresNamedInterface(destination: IPAddress): boolean {
  const kind = classifyIpv4Destination(destination);
  return kind === 'link-local-multicast' || kind === 'limited-broadcast';
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

  return host.sendFrame(request.iface, buildIpv4Frame({
    sourceIp: source, destinationIp: request.destination,
    sourceMac: port.getMAC(), destinationMac: linkDestination,
    protocol: request.protocol, ttl: request.ttl ?? DEFAULT_IPV4_TTL,
    payload: request.payload, payloadBytes: request.payloadBytes,
    options: ipv4HeaderOptionsOf(request),
  })) !== false;
}
