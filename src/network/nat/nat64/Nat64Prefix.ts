import { IPAddress, IPv6Address } from '@/network/core/types';

export const NAT64_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96] as const;
export type Nat64PrefixLength = typeof NAT64_PREFIX_LENGTHS[number];

const RESERVED_OCTET_INDEX = 8;

const NON_GLOBAL_IPV4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function toBytes(address: IPv6Address): number[] {
  return address.getHextets().flatMap((h) => [h >> 8, h & 0xff]);
}

function fromBytes(bytes: readonly number[]): IPv6Address {
  const hextets: number[] = [];
  for (let i = 0; i < 16; i += 2) hextets.push((bytes[i] << 8) | bytes[i + 1]);
  return new IPv6Address(hextets);
}

export function isGlobalIpv4(address: IPAddress): boolean {
  const value = address.toUint32();
  return !NON_GLOBAL_IPV4.some(([network, length]) => {
    const base = new IPAddress(network).toUint32();
    const mask = length === 0 ? 0 : (0xffffffff << (32 - length)) >>> 0;
    return ((value & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

export class Nat64Prefix {
  private readonly prefixBytes: readonly number[];

  private constructor(readonly network: IPv6Address, readonly length: Nat64PrefixLength, readonly wellKnown: boolean) {
    this.prefixBytes = toBytes(network).slice(0, length / 8);
  }

  static wellKnownPrefix(): Nat64Prefix {
    return new Nat64Prefix(new IPv6Address('64:ff9b::'), 96, true);
  }

  static parse(text: string): Nat64Prefix {
    const [address, lengthText, ...rest] = text.split('/');
    const length = Number(lengthText);
    if (rest.length > 0 || lengthText === undefined || !(NAT64_PREFIX_LENGTHS as readonly number[]).includes(length)) {
      throw new Error(`NAT64 prefix length must be one of ${NAT64_PREFIX_LENGTHS.join(', ')}: ${text}`);
    }
    const network = IPv6Address.tryParse(address);
    if (network === null) throw new Error(`Invalid IPv6 prefix: ${text}`);
    const bytes = toBytes(network);
    if (bytes.slice(length / 8).some((b) => b !== 0)) {
      throw new Error(`Bits beyond the /${length} prefix must be zero: ${text}`);
    }
    if (length === 96 && bytes[RESERVED_OCTET_INDEX] !== 0) {
      throw new Error(`Bits 64 to 71 of a /96 prefix must be zero (RFC 6052 section 2.2): ${text}`);
    }
    const wellKnown = length === 96 && network.equals(new IPv6Address('64:ff9b::'));
    return new Nat64Prefix(network, length as Nat64PrefixLength, wellKnown);
  }

  toString(): string {
    return `${this.network.toString()}/${this.length}`;
  }

  contains(address: IPv6Address): boolean {
    const bytes = toBytes(address);
    return this.prefixBytes.every((b, i) => bytes[i] === b);
  }

  synthesize(address: IPAddress): IPv6Address {
    if (this.wellKnown && !isGlobalIpv4(address)) {
      throw new Error(`The Well-Known Prefix cannot represent the non-global address ${address.toString()} (RFC 6052 section 3.1)`);
    }
    const bytes = new Array<number>(16).fill(0);
    this.prefixBytes.forEach((b, i) => { bytes[i] = b; });
    let index = this.length / 8;
    for (const octet of address.getOctets()) {
      if (index === RESERVED_OCTET_INDEX) index++;
      bytes[index++] = octet;
    }
    return fromBytes(bytes);
  }

  extract(address: IPv6Address): IPAddress | null {
    if (!this.contains(address)) return null;
    const bytes = toBytes(address);
    const octets: number[] = [];
    let index = this.length / 8;
    for (let n = 0; n < 4; n++) {
      if (index === RESERVED_OCTET_INDEX) index++;
      octets.push(bytes[index++]);
    }
    const embedded = new IPAddress(octets);
    if (this.wellKnown && !isGlobalIpv4(embedded)) return null;
    return embedded;
  }
}
