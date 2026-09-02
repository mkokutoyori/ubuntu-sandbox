import { IPv6Address } from './types';

const HEXTET_MASK = 0xffffn;

export function ipv6ToBigInt(address: IPv6Address): bigint {
  return address.getHextets()
    .reduce((accumulated, hextet) => (accumulated << 16n) | BigInt(hextet & 0xffff), 0n);
}

export function ipv6FromBigInt(value: bigint): IPv6Address {
  const hextets: number[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    hextets.push(Number((value >> shift) & HEXTET_MASK));
  }
  return new IPv6Address(hextets);
}

export function ipv6Compare(left: IPv6Address, right: IPv6Address): number {
  const a = ipv6ToBigInt(left);
  const b = ipv6ToBigInt(right);
  return a === b ? 0 : (a < b ? -1 : 1);
}

export interface Ipv6Prefix {
  readonly address: string;
  readonly prefixLength: number;
}

export function parseIpv6Prefix(value: string): Ipv6Prefix | null {
  const [address, length] = value.split('/');
  if (address === undefined || length === undefined) return null;
  const prefixLength = Number.parseInt(length, 10);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 128) return null;
  try {
    return { address: new IPv6Address(address).toString(), prefixLength };
  } catch {
    return null;
  }
}
