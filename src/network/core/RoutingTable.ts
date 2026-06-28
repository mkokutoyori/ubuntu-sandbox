import type { IPAddress, SubnetMask, IPv6Address } from './types';

export function maskToPrefixLength(mask: SubnetMask): number {
  const parts = mask.split('.').map(Number);
  let bits = 0;
  for (const part of parts) {
    bits += (part >>> 0).toString(2).split('1').length - 1;
  }
  return bits;
}

export function ipMatchesNetwork(ip: IPAddress, network: IPAddress, mask: SubnetMask): boolean {
  const ipParts = ip.split('.').map(Number);
  const netParts = network.split('.').map(Number);
  const maskParts = mask.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    if ((ipParts[i] & maskParts[i]) !== (netParts[i] & maskParts[i])) return false;
  }
  return true;
}

function expandIPv6(addr: string): string {
  let fullAddr = addr.toLowerCase();
  if (fullAddr.includes('::')) {
    const parts = fullAddr.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    const middle = Array(missing).fill('0000');
    fullAddr = [...left, ...middle, ...right].join(':');
  }
  return fullAddr.split(':').map((g) => g.padStart(4, '0')).join(':');
}

export function ipv6MatchesPrefix(addr: IPv6Address, prefix: IPv6Address, prefixLength: number): boolean {
  const addrBits = expandIPv6(addr).split(':').map((g) => parseInt(g, 16).toString(2).padStart(16, '0')).join('');
  const prefixBits = expandIPv6(prefix).split(':').map((g) => parseInt(g, 16).toString(2).padStart(16, '0')).join('');
  return addrBits.substring(0, prefixLength) === prefixBits.substring(0, prefixLength);
}
