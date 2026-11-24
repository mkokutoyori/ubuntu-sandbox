import { IPAddress, IPv6Address } from '../core/types';

export type PeerAddress = IPAddress | IPv6Address;

export function peerOf(text: string): PeerAddress {
  return text.includes(':') ? new IPv6Address(text) : new IPAddress(text);
}

export interface SourceAddressHost {
  sourceAddressFor(destination: IPAddress): IPAddress | null;
}

export function clientSourceAddress(host: SourceAddressHost, destination: IPAddress): IPAddress | null {
  return host.sourceAddressFor(destination) ?? (destination.isLoopback() ? destination : null);
}
