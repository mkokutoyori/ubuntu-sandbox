import type { IPAddress } from '../core/types';

export interface SourceAddressHost {
  sourceAddressFor(destination: IPAddress): IPAddress | null;
}

export function clientSourceAddress(host: SourceAddressHost, destination: IPAddress): IPAddress | null {
  return host.sourceAddressFor(destination) ?? (destination.isLoopback() ? destination : null);
}
