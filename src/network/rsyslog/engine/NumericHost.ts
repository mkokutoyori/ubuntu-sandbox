import { IPAddress, IPv6Address } from '@/network/core/types';

export function isNumericHost(name: string): boolean {
  return IPAddress.isValid(name) || IPv6Address.tryParse(name) !== null;
}
