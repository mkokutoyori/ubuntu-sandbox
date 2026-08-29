import { MACAddress, type IPAddress, type IPv4HeaderOptions } from '../../core/types';
import { ipv4MulticastToMac } from '../../core/ip';
import { classifyIpv4Destination } from './InternetLayer';

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

export function linkDestinationFor(destination: IPAddress): MACAddress {
  switch (classifyIpv4Destination(destination)) {
    case 'limited-broadcast':
      return MACAddress.broadcast();
    case 'link-local-multicast':
    case 'multicast':
      return new MACAddress(ipv4MulticastToMac(destination.toString()));
    default:
      return MACAddress.broadcast();
  }
}
