import { IPv6Address } from '@/network/core/types';

export interface ReverseZoneName { readonly name: string }
export interface ReverseZoneError { readonly error: string }

const IPV4_NETWORK_ID = /^(\d{1,3}(?:\.\d{1,3}){0,3})\/(\d{1,2})$/;
const CLASSLESS_ZONE = /^(\d{1,3})\/(\d{2})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.in-addr\.arpa$/;

function octetsOf(text: string): number[] | null {
  const octets = text.split('.').map(Number);
  return octets.length > 0 && octets.every(o => Number.isInteger(o) && o >= 0 && o <= 255) ? octets : null;
}

function ipv4ReverseZone(networkId: string): ReverseZoneName | ReverseZoneError {
  const match = IPV4_NETWORK_ID.exec(networkId);
  if (!match) return { error: `"${networkId}" is not a valid network id (expected a.b.c.d/prefix).` };
  const prefix = Number(match[2]);
  const octets = octetsOf(match[1]);
  if (!octets || prefix < 1 || prefix > 30) return { error: `"${networkId}" is not a valid network id.` };
  if (prefix % 8 === 0) {
    const labels = prefix / 8;
    if (octets.length < labels) return { error: `"${networkId}" is not a valid network id.` };
    return { name: `${octets.slice(0, labels).reverse().join('.')}.in-addr.arpa` };
  }
  if (prefix < 25) {
    return { error: `The prefix length /${prefix} is not an octet boundary and is larger than a /24: RFC 2317 delegates only networks smaller than a /24 (/25 to /30).` };
  }
  if (octets.length !== 4) return { error: `"${networkId}" is not a valid network id.` };
  const block = 256 >> (prefix - 24);
  if (octets[3] % block !== 0) return { error: `"${networkId}" has host bits set for a /${prefix}.` };
  return { name: `${octets[3]}/${prefix}.${octets[2]}.${octets[1]}.${octets[0]}.in-addr.arpa` };
}

function ipv6ReverseZone(networkId: string): ReverseZoneName | ReverseZoneError {
  const slash = networkId.lastIndexOf('/');
  const prefix = Number(networkId.slice(slash + 1));
  let hextets: number[];
  try { hextets = new IPv6Address(networkId.slice(0, slash)).getHextets(); } catch { return { error: `"${networkId}" is not a valid network id.` }; }
  if (!Number.isInteger(prefix) || prefix < 4 || prefix > 124) return { error: `"${networkId}" is not a valid network id.` };
  if (prefix % 4 !== 0) return { error: `The prefix length /${prefix} is not on a nibble boundary: ip6.arpa delegates in units of 4 bits.` };
  const nibbles = hextets.flatMap(h => [(h >> 12) & 0xf, (h >> 8) & 0xf, (h >> 4) & 0xf, h & 0xf].map(n => n.toString(16)));
  const kept = nibbles.slice(0, prefix / 4);
  if (nibbles.slice(prefix / 4).some(n => n !== '0')) return { error: `"${networkId}" has host bits set for a /${prefix}.` };
  return { name: `${kept.reverse().join('.')}.ip6.arpa` };
}

export function reverseZoneNameFor(networkId: string): ReverseZoneName | ReverseZoneError {
  const trimmed = networkId.trim();
  return trimmed.includes(':') ? ipv6ReverseZone(trimmed) : ipv4ReverseZone(trimmed);
}

export function classlessOwnerFor(zoneName: string, address: string): string | null {
  const match = CLASSLESS_ZONE.exec(zoneName);
  const octets = octetsOf(address);
  if (!match || !octets || octets.length !== 4) return null;
  const [first, prefix, o2, o1, o0] = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])];
  const block = 256 >> (prefix - 24);
  const covered = octets[0] === o0 && octets[1] === o1 && octets[2] === o2 && octets[3] >= first && octets[3] < first + block;
  return covered ? `${octets[3]}.${zoneName}` : null;
}
