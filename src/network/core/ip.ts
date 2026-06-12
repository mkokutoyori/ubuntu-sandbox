/**
 * Canonical dotted-quad IPv4 arithmetic.
 *
 * Before this module, every routing engine carried its own private copy of
 * the string-IP <-> uint32 conversion (OSPFEngine.ipToNumber, EIGRP toNum,
 * BGP sameNet's inline `num`, pim/types ipToUint32, CiscoOspfCommands
 * ipToNumber, plus an inline arrow in the OSPF DR election) — six
 * implementations with subtly different validation semantics. These helpers
 * are the single source of truth; `IPAddress.toUint32()` (core/types.ts)
 * remains the object-oriented equivalent for parsed addresses.
 */

/**
 * Convert a dotted-quad string to an unsigned 32-bit integer.
 * Fast path: assumes a well-formed "a.b.c.d" input (use {@link tryIpToUint32}
 * when the input comes from user/CLI data and may be malformed).
 */
export function ipToUint32(ip: string): number {
  const p = ip.split('.');
  return (((+p[0]) << 24) | ((+p[1]) << 16) | ((+p[2]) << 8) | (+p[3])) >>> 0;
}

/** Validating variant: returns null unless `ip` is a well-formed dotted quad. */
export function tryIpToUint32(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4) return null;
  let value = 0;
  for (const part of p) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = ((value << 8) | n) >>> 0;
  }
  return value;
}

/** Convert an unsigned 32-bit integer back to its dotted-quad string. */
export function uint32ToIp(num: number): string {
  return [
    (num >>> 24) & 0xff,
    (num >>> 16) & 0xff,
    (num >>> 8) & 0xff,
    num & 0xff,
  ].join('.');
}

/** Network mask (uint32) for a CIDR prefix length (0-32). */
export function prefixLengthToMaskUint32(bits: number): number {
  if (bits <= 0) return 0;
  if (bits >= 32) return 0xffffffff;
  return (0xffffffff << (32 - bits)) >>> 0;
}

/** Network address of `ip` under a dotted-quad `mask` (e.g. 255.255.255.0). */
export function networkAddress(ip: string, mask: string): string {
  return uint32ToIp((ipToUint32(ip) & ipToUint32(mask)) >>> 0);
}

/** True when both addresses share the subnet defined by a dotted-quad mask. */
export function inSameSubnet(ip1: string, ip2: string, mask: string): boolean {
  const m = ipToUint32(mask);
  return (ipToUint32(ip1) & m) === (ipToUint32(ip2) & m);
}

/**
 * Cisco wildcard (inverse mask) match: a 0 bit must match, a 1 bit is
 * "don't care" — the semantics of `network <net> <wildcard>` statements.
 */
export function wildcardMatches(ip: string, network: string, wildcard: string): boolean {
  const care = (~ipToUint32(wildcard)) >>> 0;
  return (ipToUint32(ip) & care) === (ipToUint32(network) & care);
}

export function broadcastAddress(ip: string, prefixLength: number): string | null {
  if (prefixLength >= 31) return null;
  const value = tryIpToUint32(ip);
  if (value === null) return null;
  const hostMask = (~prefixLengthToMaskUint32(prefixLength)) >>> 0;
  return uint32ToIp((value | hostMask) >>> 0);
}

/** Canonical IPv4 literal validation (four decimal octets, each 0-255). */
export function isValidIPv4(ip: string): boolean {
  return tryIpToUint32(ip) !== null;
}

/** Structural IPv6 validation per RFC 4291 §2.2 (single `::`, embedded IPv4 tail, `%zone`). */
export function isValidIPv6(s: string): boolean {
  if (!s.includes(':')) return false;
  const addr = s.split('%')[0];
  if (addr.length === 0) return false;
  const doubleColons = addr.split('::').length - 1;
  if (doubleColons > 1) return false;

  const [head, tail = ''] = addr.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const groups = [...headGroups, ...tailGroups];

  let count = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const isLast = i === groups.length - 1;
    if (isLast && group.includes('.')) {
      if (!isValidIPv4(group)) return false;
      count += 2;
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return false;
    count += 1;
  }

  // '::' must stand for at least one zero group.
  return doubleColons === 1 ? count <= 7 : count === 8;
}
