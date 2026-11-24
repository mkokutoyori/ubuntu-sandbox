import { IPAddress, IPv6Address } from '../core/types';

export type PeerAddress = IPAddress | IPv6Address;

export function peerOf(text: string): PeerAddress {
  return text.includes(':') ? new IPv6Address(text) : new IPAddress(text);
}

export interface Ipv6EgressHost {
  sourceAddress6For?(destination: IPv6Address): IPv6Address | null;
  sendUdpDatagramFrom?(source: IPv6Address, destination: IPv6Address, destinationPort: number, sourcePort: number, payload: unknown, payloadBytes?: number): boolean;
}

export function ipv6SourceFor(host: Ipv6EgressHost, destination: PeerAddress): IPv6Address | null {
  return destination instanceof IPv6Address ? host.sourceAddress6For?.(destination) ?? null : null;
}

export interface SourceAddressHost {
  sourceAddressFor(destination: IPAddress): IPAddress | null;
}

export function clientSourceAddress(host: SourceAddressHost, destination: IPAddress): IPAddress | null {
  return host.sourceAddressFor(destination) ?? (destination.isLoopback() ? destination : null);
}
