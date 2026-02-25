/**
 * Core network types - RFC-compliant protocol structures
 *
 * Encapsulation hierarchy (OSI):
 *   L2: EthernetFrame { srcMAC, dstMAC, etherType, payload }
 *   L3: IPv4Packet    { version, ihl, ttl, protocol, srcIP, dstIP, payload }
 *   L4: ICMPPacket / UDPPacket / TCP (future)
 *
 * ARP operates directly inside Ethernet (etherType 0x0806).
 * IPv4 is encapsulated in Ethernet (etherType 0x0800).
 * ICMP is encapsulated in IPv4 (protocol 1).
 */

// ─── MAC Address ─────────────────────────────────────────────────────

let macCounter = 0;

export class MACAddress {
  private readonly octets: number[];

  constructor(mac: string | number[]) {
    if (typeof mac === 'string') {
      this.octets = MACAddress.parse(mac);
    } else {
      if (mac.length !== 6) throw new Error(`Invalid MAC: expected 6 octets, got ${mac.length}`);
      this.octets = [...mac];
    }
  }

  private static parse(mac: string): number[] {
    const parts = mac.split(/[:\-]/);
    if (parts.length !== 6) throw new Error(`Invalid MAC address: ${mac}`);
    return parts.map(p => {
      const n = parseInt(p, 16);
      if (isNaN(n) || n < 0 || n > 255) throw new Error(`Invalid MAC octet: ${p}`);
      return n;
    });
  }

  static generate(): MACAddress {
    macCounter++;
    const b3 = (macCounter >> 16) & 0xff;
    const b4 = (macCounter >> 8) & 0xff;
    const b5 = macCounter & 0xff;
    return new MACAddress([0x02, 0x00, 0x00, b3, b4, b5]);
  }

  static broadcast(): MACAddress {
    return new MACAddress([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  }

  isBroadcast(): boolean {
    return this.octets.every(o => o === 0xff);
  }

  equals(other: MACAddress): boolean {
    return this.octets.every((o, i) => o === other.octets[i]);
  }

  getOctets(): number[] {
    return [...this.octets];
  }

  toString(): string {
    return this.octets.map(o => o.toString(16).padStart(2, '0')).join(':');
  }

  toJSON(): string {
    return this.toString();
  }

  static resetCounter(): void {
    macCounter = 0;
  }
}

// ─── IPv4 Address ────────────────────────────────────────────────────

export class IPAddress {
  private readonly octets: number[];

  constructor(ip: string | number[]) {
    if (typeof ip === 'string') {
      this.octets = IPAddress.parse(ip);
    } else {
      if (ip.length !== 4) throw new Error(`Invalid IP: expected 4 octets, got ${ip.length}`);
      this.octets = [...ip];
    }
  }

  private static parse(ip: string): number[] {
    const parts = ip.split('.');
    if (parts.length !== 4) throw new Error(`Invalid IP address: ${ip}`);
    return parts.map(p => {
      const n = parseInt(p, 10);
      if (isNaN(n) || n < 0 || n > 255) throw new Error(`Invalid IP octet: ${p}`);
      return n;
    });
  }

  equals(other: IPAddress): boolean {
    return this.octets.every((o, i) => o === other.octets[i]);
  }

  isInSameSubnet(other: IPAddress, mask: SubnetMask): boolean {
    const maskOctets = mask.getOctets();
    for (let i = 0; i < 4; i++) {
      if ((this.octets[i] & maskOctets[i]) !== (other.octets[i] & maskOctets[i])) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check if this is the broadcast address for the given subnet
   * (all host bits are 1)
   */
  isBroadcastFor(mask: SubnetMask): boolean {
    const maskOctets = mask.getOctets();
    for (let i = 0; i < 4; i++) {
      // Host bits (inverted mask) must all be 1
      if ((this.octets[i] | maskOctets[i]) !== 0xff) return false;
    }
    return true;
  }

  /** Convert to 32-bit unsigned integer (for LPM calculations) */
  toUint32(): number {
    return ((this.octets[0] << 24) | (this.octets[1] << 16) |
            (this.octets[2] << 8) | this.octets[3]) >>> 0;
  }

  static fromUint32(n: number): IPAddress {
    return new IPAddress([
      (n >>> 24) & 0xff,
      (n >>> 16) & 0xff,
      (n >>> 8) & 0xff,
      n & 0xff,
    ]);
  }

  getOctets(): number[] {
    return [...this.octets];
  }

  toString(): string {
    return this.octets.join('.');
  }

  toJSON(): string {
    return this.toString();
  }
}

// ─── Subnet Mask ─────────────────────────────────────────────────────

export class SubnetMask {
  private readonly octets: number[];

  constructor(mask: string | number[]) {
    if (typeof mask === 'string') {
      const parts = mask.split('.');
      if (parts.length !== 4) throw new Error(`Invalid subnet mask: ${mask}`);
      this.octets = parts.map(p => parseInt(p, 10));
    } else {
      this.octets = [...mask];
    }
  }

  static fromCIDR(prefix: number): SubnetMask {
    const octets = [0, 0, 0, 0];
    for (let i = 0; i < prefix; i++) {
      octets[Math.floor(i / 8)] |= (128 >> (i % 8));
    }
    return new SubnetMask(octets);
  }

  getOctets(): number[] {
    return [...this.octets];
  }

  /** Convert to 32-bit unsigned integer (for LPM calculations) */
  toUint32(): number {
    return ((this.octets[0] << 24) | (this.octets[1] << 16) |
            (this.octets[2] << 8) | this.octets[3]) >>> 0;
  }

  toCIDR(): number {
    let bits = 0;
    for (const octet of this.octets) {
      let b = octet;
      while (b & 128) {
        bits++;
        b = (b << 1) & 0xff;
      }
    }
    return bits;
  }

  toString(): string {
    return this.octets.join('.');
  }

  toJSON(): string {
    return this.toString();
  }
}

// ─── IPv6 Address (RFC 4291, RFC 8200) ───────────────────────────────
//
// IPv6 addresses are 128-bit identifiers represented as 8 groups of 4 hex digits.
// Supports:
//   - Full notation: 2001:0db8:0000:0000:0000:0000:0000:0001
//   - Compressed notation: 2001:db8::1 (single :: can replace consecutive zero groups)
//   - Link-local addresses: fe80::/10 (require scope/zone ID for routing)
//   - Loopback: ::1
//   - Unspecified: ::
//   - Multicast: ff00::/8
//   - Solicited-node multicast: ff02::1:ffXX:XXXX (last 24 bits of unicast)

export class IPv6Address {
  private readonly hextets: number[]; // 8 × 16-bit values
  private readonly scopeId: string | null; // Zone ID for link-local (e.g., "%eth0")

  constructor(addr: string | number[], scopeId?: string) {
    if (typeof addr === 'string') {
      const parsed = IPv6Address.parse(addr);
      this.hextets = parsed.hextets;
      this.scopeId = parsed.scopeId ?? scopeId ?? null;
    } else {
      if (addr.length !== 8) throw new Error(`Invalid IPv6: expected 8 hextets, got ${addr.length}`);
      this.hextets = [...addr];
      this.scopeId = scopeId ?? null;
    }
  }

  /**
   * Parse an IPv6 address string (supports full, compressed, and zone ID).
   * Examples:
   *   "2001:db8::1"
   *   "fe80::1%eth0"
   *   "::ffff:192.168.1.1" (IPv4-mapped, partial support)
   */
  private static parse(addr: string): { hextets: number[]; scopeId?: string } {
    let scopeId: string | undefined;

    // Extract zone ID (e.g., %eth0)
    const zoneIdx = addr.indexOf('%');
    if (zoneIdx !== -1) {
      scopeId = addr.slice(zoneIdx + 1);
      addr = addr.slice(0, zoneIdx);
    }

    // Handle IPv4-mapped addresses (::ffff:192.168.1.1)
    const ipv4MappedMatch = addr.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (ipv4MappedMatch) {
      const ipv4Parts = ipv4MappedMatch[2].split('.').map(p => parseInt(p, 10));
      const ipv6Prefix = ipv4MappedMatch[1].slice(0, -1); // Remove trailing ':'
      // Convert IPv4 to two hextets
      const h7 = (ipv4Parts[0] << 8) | ipv4Parts[1];
      const h8 = (ipv4Parts[2] << 8) | ipv4Parts[3];
      // Parse the prefix and append IPv4 hextets
      const prefixAddr = ipv6Prefix || '::';
      const prefix = IPv6Address.parse(prefixAddr + ':0:0');
      prefix.hextets[6] = h7;
      prefix.hextets[7] = h8;
      return { hextets: prefix.hextets, scopeId };
    }

    const hextets: number[] = new Array(8).fill(0);

    if (addr === '::') {
      return { hextets, scopeId };
    }

    // Split on ::
    const parts = addr.split('::');
    if (parts.length > 2) {
      throw new Error(`Invalid IPv6 address: multiple :: found in ${addr}`);
    }

    const leftParts = parts[0] ? parts[0].split(':') : [];
    const rightParts = parts.length > 1 && parts[1] ? parts[1].split(':') : [];

    if (leftParts.length + rightParts.length > 8) {
      throw new Error(`Invalid IPv6 address: too many groups in ${addr}`);
    }

    // If no :: compression, we need exactly 8 groups
    if (parts.length === 1 && leftParts.length !== 8) {
      throw new Error(`Invalid IPv6 address: expected 8 groups, got ${leftParts.length} in ${addr}`);
    }

    // Fill from left
    for (let i = 0; i < leftParts.length; i++) {
      const val = parseInt(leftParts[i], 16);
      if (isNaN(val) || val < 0 || val > 0xffff) {
        throw new Error(`Invalid IPv6 hextet: ${leftParts[i]}`);
      }
      hextets[i] = val;
    }

    // Fill from right
    const rightStart = 8 - rightParts.length;
    for (let i = 0; i < rightParts.length; i++) {
      const val = parseInt(rightParts[i], 16);
      if (isNaN(val) || val < 0 || val > 0xffff) {
        throw new Error(`Invalid IPv6 hextet: ${rightParts[i]}`);
      }
      hextets[rightStart + i] = val;
    }

    return { hextets, scopeId };
  }

  // ─── Address Type Detection (RFC 4291) ─────────────────────────

  /** Check if this is the unspecified address (::) */
  isUnspecified(): boolean {
    return this.hextets.every(h => h === 0);
  }

  /** Check if this is the loopback address (::1) */
  isLoopback(): boolean {
    return this.hextets.slice(0, 7).every(h => h === 0) && this.hextets[7] === 1;
  }

  /** Check if this is a link-local address (fe80::/10) */
  isLinkLocal(): boolean {
    return (this.hextets[0] & 0xffc0) === 0xfe80;
  }

  /** Check if this is a multicast address (ff00::/8) */
  isMulticast(): boolean {
    return (this.hextets[0] & 0xff00) === 0xff00;
  }

  /** Check if this is all-nodes multicast (ff02::1) */
  isAllNodesMulticast(): boolean {
    return this.hextets[0] === 0xff02 &&
           this.hextets.slice(1, 7).every(h => h === 0) &&
           this.hextets[7] === 1;
  }

  /** Check if this is all-routers multicast (ff02::2) */
  isAllRoutersMulticast(): boolean {
    return this.hextets[0] === 0xff02 &&
           this.hextets.slice(1, 7).every(h => h === 0) &&
           this.hextets[7] === 2;
  }

  /** Check if this is a solicited-node multicast address (ff02::1:ffXX:XXXX) */
  isSolicitedNodeMulticast(): boolean {
    return this.hextets[0] === 0xff02 &&
           this.hextets.slice(1, 5).every(h => h === 0) &&
           this.hextets[5] === 0x0001 &&
           (this.hextets[6] & 0xff00) === 0xff00;
  }

  /** Check if this is a global unicast address (not link-local, loopback, or multicast) */
  isGlobalUnicast(): boolean {
    return !this.isUnspecified() && !this.isLoopback() && !this.isLinkLocal() && !this.isMulticast();
  }

  // ─── Solicited-Node Multicast (RFC 4291 §2.7.1) ────────────────

  /**
   * Compute the solicited-node multicast address for this unicast address.
   * Format: ff02::1:ffXX:XXXX where XX:XXXX is the low 24 bits of the unicast.
   */
  toSolicitedNodeMulticast(): IPv6Address {
    const low24 = ((this.hextets[6] & 0x00ff) << 16) | this.hextets[7];
    return new IPv6Address([
      0xff02, 0, 0, 0, 0, 0x0001,
      0xff00 | ((low24 >> 16) & 0xff),
      low24 & 0xffff,
    ]);
  }

  // ─── Comparison & Arithmetic ───────────────────────────────────

  equals(other: IPv6Address): boolean {
    return this.hextets.every((h, i) => h === other.hextets[i]);
  }

  /**
   * Check if this address is in the same subnet as another.
   * @param other The other IPv6 address
   * @param prefixLength Prefix length (0-128)
   */
  isInSameSubnet(other: IPv6Address, prefixLength: number): boolean {
    const fullHextets = Math.floor(prefixLength / 16);
    const remainingBits = prefixLength % 16;

    // Compare full hextets
    for (let i = 0; i < fullHextets; i++) {
      if (this.hextets[i] !== other.hextets[i]) return false;
    }

    // Compare partial hextet
    if (remainingBits > 0 && fullHextets < 8) {
      const mask = 0xffff << (16 - remainingBits);
      if ((this.hextets[fullHextets] & mask) !== (other.hextets[fullHextets] & mask)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Get the network prefix for a given prefix length.
   */
  getNetworkPrefix(prefixLength: number): IPv6Address {
    const result = [...this.hextets];
    const fullHextets = Math.floor(prefixLength / 16);
    const remainingBits = prefixLength % 16;

    // Zero out hextets beyond the prefix
    for (let i = fullHextets + 1; i < 8; i++) {
      result[i] = 0;
    }

    // Mask the partial hextet
    if (remainingBits > 0 && fullHextets < 8) {
      const mask = 0xffff << (16 - remainingBits);
      result[fullHextets] = result[fullHextets] & mask;
    } else if (fullHextets < 8) {
      result[fullHextets] = 0;
    }

    return new IPv6Address(result);
  }

  // ─── EUI-64 Interface ID Generation (RFC 4291 Appendix A) ──────

  /**
   * Generate a link-local address from a MAC address using EUI-64.
   * fe80::XXYY:ZZff:feAA:BBCC where MAC is XX:YY:ZZ:AA:BB:CC
   * (with the U/L bit flipped in XX).
   */
  static fromMAC(mac: MACAddress): IPv6Address {
    const octets = mac.getOctets();
    // Flip the Universal/Local bit (bit 1 of first octet)
    const firstOctet = octets[0] ^ 0x02;
    // Insert ff:fe in the middle
    return new IPv6Address([
      0xfe80,
      0,
      0,
      0,
      (firstOctet << 8) | octets[1],
      (octets[2] << 8) | 0xff,
      (0xfe << 8) | octets[3],
      (octets[4] << 8) | octets[5],
    ]);
  }

  // ─── Accessors ─────────────────────────────────────────────────

  getHextets(): number[] {
    return [...this.hextets];
  }

  getScopeId(): string | null {
    return this.scopeId;
  }

  withScopeId(scopeId: string | null): IPv6Address {
    return new IPv6Address(this.hextets, scopeId ?? undefined);
  }

  // ─── Serialization ─────────────────────────────────────────────

  /**
   * Convert to compressed string representation (RFC 5952).
   * - Leading zeros in each hextet are omitted
   * - The longest run of consecutive all-zero hextets is replaced with ::
   * - If there are multiple equal-length runs, the first is compressed
   */
  toString(): string {
    // Find the longest run of zeros
    let bestStart = -1, bestLen = 0;
    let runStart = -1, runLen = 0;

    for (let i = 0; i < 8; i++) {
      if (this.hextets[i] === 0) {
        if (runStart === -1) runStart = i;
        runLen++;
      } else {
        if (runLen > bestLen) {
          bestStart = runStart;
          bestLen = runLen;
        }
        runStart = -1;
        runLen = 0;
      }
    }
    if (runLen > bestLen) {
      bestStart = runStart;
      bestLen = runLen;
    }

    // Build the string
    let result = '';
    if (bestLen > 1) {
      // Use :: compression
      const left = this.hextets.slice(0, bestStart);
      const right = this.hextets.slice(bestStart + bestLen);
      result = left.map(h => h.toString(16)).join(':') + '::' + right.map(h => h.toString(16)).join(':');
      // Clean up edge cases
      if (bestStart === 0) result = '::' + right.map(h => h.toString(16)).join(':');
      if (bestStart + bestLen === 8) result = left.map(h => h.toString(16)).join(':') + '::';
      if (bestStart === 0 && bestLen === 8) result = '::';
    } else {
      result = this.hextets.map(h => h.toString(16)).join(':');
    }

    // Append scope ID if present
    if (this.scopeId) {
      result += '%' + this.scopeId;
    }

    return result;
  }

  /** Full notation (no compression) for debugging */
  toFullString(): string {
    const addr = this.hextets.map(h => h.toString(16).padStart(4, '0')).join(':');
    return this.scopeId ? `${addr}%${this.scopeId}` : addr;
  }

  toJSON(): string {
    return this.toString();
  }

  // ─── Multicast MAC (RFC 2464 §7) ───────────────────────────────

  /**
   * Convert an IPv6 multicast address to its corresponding Ethernet multicast MAC.
   * Format: 33:33:XX:XX:XX:XX where XX:XX:XX:XX is the low 32 bits of the IPv6 address.
   */
  toMulticastMAC(): MACAddress {
    if (!this.isMulticast()) {
      throw new Error('Cannot convert non-multicast address to multicast MAC');
    }
    return new MACAddress([
      0x33, 0x33,
      (this.hextets[6] >> 8) & 0xff,
      this.hextets[6] & 0xff,
      (this.hextets[7] >> 8) & 0xff,
      this.hextets[7] & 0xff,
    ]);
  }
}

// ─── Well-Known IPv6 Addresses ───────────────────────────────────────

export const IPV6_UNSPECIFIED = new IPv6Address('::');
export const IPV6_LOOPBACK = new IPv6Address('::1');
export const IPV6_ALL_NODES_MULTICAST = new IPv6Address('ff02::1');
export const IPV6_ALL_ROUTERS_MULTICAST = new IPv6Address('ff02::2');

// ─── L2: Ethernet Frame ─────────────────────────────────────────────

export const ETHERTYPE_ARP  = 0x0806;
export const ETHERTYPE_IPV4 = 0x0800;
export const ETHERTYPE_IPV6 = 0x86dd;

export interface EthernetFrame {
  srcMAC: MACAddress;
  dstMAC: MACAddress;
  etherType: number;
  payload: ARPPacket | IPv4Packet | IPv6Packet | unknown;
}

// ─── L3: IPv4 Packet (RFC 791) ──────────────────────────────────────

/** IPv4 protocol numbers */
export const IP_PROTO_ICMP = 1;
export const IP_PROTO_TCP  = 6;
export const IP_PROTO_UDP  = 17;
export const IP_PROTO_ESP  = 50;  // Encapsulating Security Payload (RFC 4303)
export const IP_PROTO_AH   = 51;  // Authentication Header (RFC 4302)

/** IKE / NAT-T UDP ports */
export const UDP_PORT_IKE       = 500;   // RFC 2408 ISAKMP
export const UDP_PORT_IKE_NAT_T = 4500;  // RFC 3948 UDP-Encapsulated ESP

/**
 * IPv4 Packet — RFC 791 compliant header fields.
 *
 * The checksum is computed over the header words (16-bit) using one's complement.
 * It must be recalculated whenever any header field changes (e.g. TTL decrement).
 */
export interface IPv4Packet {
  type: 'ipv4';
  /** Always 4 */
  version: 4;
  /** Internet Header Length in 32-bit words. Default 5 (20 bytes). */
  ihl: number;
  /** Type of Service / DSCP + ECN. Default 0. */
  tos: number;
  /** Total length of the packet (header + payload) in bytes. */
  totalLength: number;
  /** Identification for fragment reassembly. */
  identification: number;
  /** Flags: bit 0 reserved, bit 1 DF (Don't Fragment), bit 2 MF (More Fragments). */
  flags: number;
  /** Fragment offset in 8-byte units. */
  fragmentOffset: number;
  /** Time To Live — decremented by each router. */
  ttl: number;
  /** Upper-layer protocol (1=ICMP, 6=TCP, 17=UDP). */
  protocol: number;
  /** Header checksum (one's complement sum of 16-bit words). */
  headerChecksum: number;
  /** Source IP address. */
  sourceIP: IPAddress;
  /** Destination IP address. */
  destinationIP: IPAddress;
  /** Upper-layer payload (ICMP, UDP datagram, TCP segment, etc.). */
  payload: ICMPPacket | UDPPacket | unknown;
}

// ─── IPv4 Checksum (RFC 791 §3.1) ──────────────────────────────────

let ipIdCounter = 0;

/** Generate a monotonically increasing IPv4 identification value. */
export function nextIPv4Id(): number {
  ipIdCounter = (ipIdCounter + 1) & 0xffff;
  return ipIdCounter;
}

export function resetIPv4IdCounter(): void {
  ipIdCounter = 0;
}

/**
 * Compute the IPv4 header checksum per RFC 791.
 * Serialises the header into 10 × 16-bit words (IHL=5), sums them
 * using one's complement arithmetic, and returns the complement.
 */
export function computeIPv4Checksum(pkt: IPv4Packet): number {
  const srcOctets = pkt.sourceIP.getOctets();
  const dstOctets = pkt.destinationIP.getOctets();

  // 10 x 16-bit words for a standard 20-byte header (IHL = 5)
  const words: number[] = [
    ((pkt.version << 12) | (pkt.ihl << 8) | pkt.tos),       // word 0: ver+ihl+tos
    pkt.totalLength,                                          // word 1: total length
    pkt.identification,                                       // word 2: identification
    ((pkt.flags << 13) | pkt.fragmentOffset),                 // word 3: flags+fragOffset
    ((pkt.ttl << 8) | pkt.protocol),                          // word 4: ttl+protocol
    0,                                                        // word 5: checksum (set to 0 for calculation)
    ((srcOctets[0] << 8) | srcOctets[1]),                     // word 6: src IP high
    ((srcOctets[2] << 8) | srcOctets[3]),                     // word 7: src IP low
    ((dstOctets[0] << 8) | dstOctets[1]),                     // word 8: dst IP high
    ((dstOctets[2] << 8) | dstOctets[3]),                     // word 9: dst IP low
  ];

  let sum = 0;
  for (const w of words) {
    sum += w;
  }
  // Fold carry bits
  while (sum > 0xffff) {
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  return (~sum) & 0xffff;
}

/**
 * Verify the IPv4 header checksum.
 * Returns true if the checksum is valid.
 */
export function verifyIPv4Checksum(pkt: IPv4Packet): boolean {
  const srcOctets = pkt.sourceIP.getOctets();
  const dstOctets = pkt.destinationIP.getOctets();

  const words: number[] = [
    ((pkt.version << 12) | (pkt.ihl << 8) | pkt.tos),
    pkt.totalLength,
    pkt.identification,
    ((pkt.flags << 13) | pkt.fragmentOffset),
    ((pkt.ttl << 8) | pkt.protocol),
    pkt.headerChecksum,                                       // include the stored checksum
    ((srcOctets[0] << 8) | srcOctets[1]),
    ((srcOctets[2] << 8) | srcOctets[3]),
    ((dstOctets[0] << 8) | dstOctets[1]),
    ((dstOctets[2] << 8) | dstOctets[3]),
  ];

  let sum = 0;
  for (const w of words) {
    sum += w;
  }
  while (sum > 0xffff) {
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  // Valid checksum produces 0xffff
  return (sum & 0xffff) === 0xffff;
}

/**
 * Build an IPv4 packet with computed checksum.
 */
export function createIPv4Packet(
  sourceIP: IPAddress,
  destinationIP: IPAddress,
  protocol: number,
  ttl: number,
  payload: ICMPPacket | UDPPacket | unknown,
  payloadSize: number = 0,
): IPv4Packet {
  const headerSize = 20; // IHL = 5, no options
  const pkt: IPv4Packet = {
    type: 'ipv4',
    version: 4,
    ihl: 5,
    tos: 0,
    totalLength: headerSize + payloadSize,
    identification: nextIPv4Id(),
    flags: 0b010, // DF (Don't Fragment) set by default
    fragmentOffset: 0,
    ttl,
    protocol,
    headerChecksum: 0,
    sourceIP,
    destinationIP,
    payload,
  };
  pkt.headerChecksum = computeIPv4Checksum(pkt);
  return pkt;
}

// ─── ARP (L2, etherType 0x0806) ─────────────────────────────────────

export type ARPOperation = 'request' | 'reply';

export interface ARPPacket {
  type: 'arp';
  operation: ARPOperation;
  senderMAC: MACAddress;
  senderIP: IPAddress;
  targetMAC: MACAddress;
  targetIP: IPAddress;
}

// ─── ICMP (L4, inside IPv4, protocol 1) ─────────────────────────────
//
// Per RFC 792, ICMP does NOT carry source/destination IP — that is the
// job of the IPv4 header.  ICMP only has type, code, checksum, and
// type-specific data (id+sequence for echo, etc.).

export type ICMPType =
  | 'echo-request'            // Type 8
  | 'echo-reply'              // Type 0
  | 'destination-unreachable'  // Type 3
  | 'time-exceeded';           // Type 11

export interface ICMPPacket {
  type: 'icmp';
  icmpType: ICMPType;
  /** ICMP code (0 for echo, subtypes for unreachable/time-exceeded). */
  code: number;
  /** Identifier — used to match echo requests/replies. */
  id: number;
  /** Sequence number — used to match echo requests/replies. */
  sequence: number;
  /**
   * Payload data size in bytes (simulated, not actual binary data).
   * Default 56 bytes for ping (making 64 bytes ICMP = 8 header + 56 data,
   * 84 bytes total with IPv4 header).
   */
  dataSize: number;
}

// ─── L4: UDP Datagram (RFC 768) ──────────────────────────────────────

export const UDP_PORT_RIP = 520;

export interface UDPPacket {
  type: 'udp';
  /** Source port (16-bit). */
  sourcePort: number;
  /** Destination port (16-bit). */
  destinationPort: number;
  /** Length of UDP header + payload in bytes. */
  length: number;
  /** UDP checksum (0 = disabled, valid for IPv4). */
  checksum: number;
  /** Upper-layer payload (RIP, DNS, etc.). */
  payload: RIPPacket | unknown;
}

// ─── IPSec: ESP Packet (IP protocol 50, RFC 4303) ───────────────────

/**
 * ESP (Encapsulating Security Payload) — used for IPSec tunnel/transport mode.
 * In our simulator, no real encryption is performed; the inner packet is preserved.
 */
export interface ESPPacket {
  type: 'esp';
  /** Security Parameter Index — identifies the SA on the receiver */
  spi: number;
  /** Anti-replay sequence number */
  sequenceNumber: number;
  /** The protected inner IPv4 packet (tunnel mode) or upper-layer payload */
  innerPacket: IPv4Packet;
}

// ─── IPSec: AH Packet (IP protocol 51, RFC 4302) ────────────────────

/** AH (Authentication Header) — integrity only, no confidentiality */
export interface AHPacket {
  type: 'ah';
  spi: number;
  sequenceNumber: number;
  innerPacket: IPv4Packet;
}

// ─── Simplified IKE negotiation payload (simulation-internal) ────────

/**
 * IKESimMessage — carried inside UDP/500 packets for IKE simulation.
 * Not a real IKE PDU — collapses the multi-message IKE exchange into 2 messages.
 */
export interface IKESimMessage {
  type: 'ike-sim';
  phase: 1 | 2;
  direction: 'request' | 'response';
  // Phase 1 — ISAKMP policy proposals
  isakmpPolicies?: Array<{
    encryption: string; hash: string; auth: string; group: number; lifetime: number;
  }>;
  psk?: string;  // Pre-shared key (plaintext in simulation)
  natKeepalive?: number;
  ikev2?: boolean;   // IKEv2 negotiation
  ikev2Proposals?: Array<{
    encryption: string[]; integrity: string[]; group: number[];
  }>;
  // Phase 2 — transform set proposals
  transformSets?: Array<{
    transforms: string[]; mode: 'tunnel' | 'transport';
  }>;
  pfsGroup?: string;
  saLifetime?: number;
  // Response fields
  success?: boolean;
  errorReason?: string;
  chosenPolicyIdx?: number;
  chosenTransformIdx?: number;
  initiatorSpiIn?: number;   // SPI for traffic: responder → initiator
  responderSpiIn?: number;   // SPI for traffic: initiator → responder
  natDetected?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════
// IPv6 Protocol Stack (RFC 8200, RFC 4443, RFC 4861)
// ═══════════════════════════════════════════════════════════════════════

// ─── L3: IPv6 Packet (RFC 8200) ──────────────────────────────────────
//
// IPv6 Header (40 bytes fixed):
//   Version (4 bits): Always 6
//   Traffic Class (8 bits): DSCP + ECN
//   Flow Label (20 bits): For QoS
//   Payload Length (16 bits): Length of payload (not including header)
//   Next Header (8 bits): Protocol of encapsulated data (ICMPv6=58, TCP=6, UDP=17)
//   Hop Limit (8 bits): Equivalent to TTL
//   Source Address (128 bits)
//   Destination Address (128 bits)
//
// Extension headers are chained via Next Header field (not implemented).

/** IPv6 Next Header / Protocol values */
export const IP_PROTO_ICMPV6 = 58;
export const IP_PROTO_NONE = 59;   // No next header

export interface IPv6Packet {
  type: 'ipv6';
  /** Always 6 */
  version: 6;
  /** Traffic Class (DSCP + ECN), default 0 */
  trafficClass: number;
  /** Flow Label for QoS (20-bit), default 0 */
  flowLabel: number;
  /** Payload length in bytes (excluding 40-byte header) */
  payloadLength: number;
  /** Next Header (protocol): 58=ICMPv6, 6=TCP, 17=UDP */
  nextHeader: number;
  /** Hop Limit — decremented by each router */
  hopLimit: number;
  /** Source IPv6 address */
  sourceIP: IPv6Address;
  /** Destination IPv6 address */
  destinationIP: IPv6Address;
  /** Upper-layer payload (ICMPv6, UDP, TCP, etc.) */
  payload: ICMPv6Packet | UDPPacket | unknown;
}

/**
 * Create an IPv6 packet with default fields.
 */
export function createIPv6Packet(
  sourceIP: IPv6Address,
  destinationIP: IPv6Address,
  nextHeader: number,
  hopLimit: number,
  payload: ICMPv6Packet | UDPPacket | unknown,
  payloadLength: number,
): IPv6Packet {
  return {
    type: 'ipv6',
    version: 6,
    trafficClass: 0,
    flowLabel: 0,
    payloadLength,
    nextHeader,
    hopLimit,
    sourceIP,
    destinationIP,
    payload,
  };
}

// ─── ICMPv6 (RFC 4443) ──────────────────────────────────────────────
//
// ICMPv6 types:
//   Error Messages (type 0-127):
//     1: Destination Unreachable
//     2: Packet Too Big
//     3: Time Exceeded
//     4: Parameter Problem
//   Informational Messages (type 128-255):
//     128: Echo Request
//     129: Echo Reply
//     133: Router Solicitation (NDP)
//     134: Router Advertisement (NDP)
//     135: Neighbor Solicitation (NDP)
//     136: Neighbor Advertisement (NDP)
//     137: Redirect (NDP)

export const ICMPV6_ECHO_REQUEST = 128;
export const ICMPV6_ECHO_REPLY = 129;
export const ICMPV6_ROUTER_SOLICITATION = 133;
export const ICMPV6_ROUTER_ADVERTISEMENT = 134;
export const ICMPV6_NEIGHBOR_SOLICITATION = 135;
export const ICMPV6_NEIGHBOR_ADVERTISEMENT = 136;
export const ICMPV6_DEST_UNREACHABLE = 1;
export const ICMPV6_PACKET_TOO_BIG = 2;
export const ICMPV6_TIME_EXCEEDED = 3;

export type ICMPv6Type =
  | 'echo-request'
  | 'echo-reply'
  | 'router-solicitation'
  | 'router-advertisement'
  | 'neighbor-solicitation'
  | 'neighbor-advertisement'
  | 'destination-unreachable'
  | 'packet-too-big'
  | 'time-exceeded';

export interface ICMPv6Packet {
  type: 'icmpv6';
  /** ICMPv6 message type */
  icmpType: ICMPv6Type;
  /** ICMPv6 code (subtype) */
  code: number;
  /** For echo request/reply: identifier */
  id?: number;
  /** For echo request/reply: sequence number */
  sequence?: number;
  /** For echo request/reply: data size */
  dataSize?: number;
  /** For Packet Too Big: MTU that should be used */
  mtu?: number;
  /** NDP-specific fields (for NS/NA/RS/RA) */
  ndp?: NDPMessage;
}

// ─── Neighbor Discovery Protocol (RFC 4861) ─────────────────────────
//
// NDP replaces ARP for IPv6. Message types:
//   - Router Solicitation (RS): Host asks for router info
//   - Router Advertisement (RA): Router announces prefix/flags
//   - Neighbor Solicitation (NS): Resolve IPv6 → MAC (like ARP request)
//   - Neighbor Advertisement (NA): Response to NS (like ARP reply)
//
// NDP options (TLV format):
//   Type 1: Source Link-Layer Address
//   Type 2: Target Link-Layer Address
//   Type 3: Prefix Information
//   Type 4: Redirected Header
//   Type 5: MTU

export interface NDPOptionLinkLayerAddress {
  optionType: 'source-link-layer' | 'target-link-layer';
  address: MACAddress;
}

export interface NDPOptionPrefixInfo {
  optionType: 'prefix-info';
  prefixLength: number;
  /** On-link flag (L): prefix can be used for on-link determination */
  onLink: boolean;
  /** Autonomous flag (A): prefix can be used for SLAAC */
  autonomous: boolean;
  /** Valid lifetime in seconds (0xffffffff = infinity) */
  validLifetime: number;
  /** Preferred lifetime in seconds */
  preferredLifetime: number;
  /** Prefix (only the network portion) */
  prefix: IPv6Address;
}

export interface NDPOptionMTU {
  optionType: 'mtu';
  mtu: number;
}

export type NDPOption = NDPOptionLinkLayerAddress | NDPOptionPrefixInfo | NDPOptionMTU;

// ─── NDP Message Types ───────────────────────────────────────────────

/** Router Solicitation (RS) — sent by hosts to request RA */
export interface NDPRouterSolicitation {
  ndpType: 'router-solicitation';
  options: NDPOption[];
}

/** Router Advertisement (RA) — sent by routers in response to RS or periodically */
export interface NDPRouterAdvertisement {
  ndpType: 'router-advertisement';
  /** Current hop limit advertised by router (0 = unspecified) */
  curHopLimit: number;
  /** Managed address configuration flag (M): use DHCPv6 for addresses */
  managedFlag: boolean;
  /** Other configuration flag (O): use DHCPv6 for other info */
  otherConfigFlag: boolean;
  /** Router lifetime in seconds (0 = not a default router) */
  routerLifetime: number;
  /** Reachable time in milliseconds (0 = unspecified) */
  reachableTime: number;
  /** Retransmit timer in milliseconds (0 = unspecified) */
  retransTimer: number;
  options: NDPOption[];
}

/** Neighbor Solicitation (NS) — IPv6 equivalent of ARP request */
export interface NDPNeighborSolicitation {
  ndpType: 'neighbor-solicitation';
  /** Target address being queried (must not be multicast) */
  targetAddress: IPv6Address;
  options: NDPOption[];
}

/** Neighbor Advertisement (NA) — IPv6 equivalent of ARP reply */
export interface NDPNeighborAdvertisement {
  ndpType: 'neighbor-advertisement';
  /** Router flag (R): sender is a router */
  routerFlag: boolean;
  /** Solicited flag (S): sent in response to NS */
  solicitedFlag: boolean;
  /** Override flag (O): should override existing cache entry */
  overrideFlag: boolean;
  /** Target address (address whose link-layer address is advertised) */
  targetAddress: IPv6Address;
  options: NDPOption[];
}

export type NDPMessage =
  | NDPRouterSolicitation
  | NDPRouterAdvertisement
  | NDPNeighborSolicitation
  | NDPNeighborAdvertisement;

// ─── IPv6 Helper Functions ───────────────────────────────────────────

/**
 * Create an ICMPv6 Echo Request packet.
 */
export function createICMPv6EchoRequest(id: number, sequence: number, dataSize: number = 56): ICMPv6Packet {
  return {
    type: 'icmpv6',
    icmpType: 'echo-request',
    code: 0,
    id,
    sequence,
    dataSize,
  };
}

/**
 * Create an ICMPv6 Echo Reply packet.
 */
export function createICMPv6EchoReply(id: number, sequence: number, dataSize: number = 56): ICMPv6Packet {
  return {
    type: 'icmpv6',
    icmpType: 'echo-reply',
    code: 0,
    id,
    sequence,
    dataSize,
  };
}

/**
 * Create a Neighbor Solicitation packet for address resolution.
 * Sent to the solicited-node multicast address of the target.
 */
export function createNeighborSolicitation(
  targetAddress: IPv6Address,
  sourceLinkLayerAddress: MACAddress,
): ICMPv6Packet {
  return {
    type: 'icmpv6',
    icmpType: 'neighbor-solicitation',
    code: 0,
    ndp: {
      ndpType: 'neighbor-solicitation',
      targetAddress,
      options: [{
        optionType: 'source-link-layer',
        address: sourceLinkLayerAddress,
      }],
    },
  };
}

/**
 * Create a Neighbor Advertisement packet (response to NS).
 */
export function createNeighborAdvertisement(
  targetAddress: IPv6Address,
  targetLinkLayerAddress: MACAddress,
  flags: { router?: boolean; solicited?: boolean; override?: boolean } = {},
): ICMPv6Packet {
  return {
    type: 'icmpv6',
    icmpType: 'neighbor-advertisement',
    code: 0,
    ndp: {
      ndpType: 'neighbor-advertisement',
      routerFlag: flags.router ?? false,
      solicitedFlag: flags.solicited ?? true,
      overrideFlag: flags.override ?? true,
      targetAddress,
      options: [{
        optionType: 'target-link-layer',
        address: targetLinkLayerAddress,
      }],
    },
  };
}

/**
 * Create a Router Solicitation packet.
 */
export function createRouterSolicitation(sourceLinkLayerAddress?: MACAddress): ICMPv6Packet {
  const options: NDPOption[] = [];
  if (sourceLinkLayerAddress) {
    options.push({ optionType: 'source-link-layer', address: sourceLinkLayerAddress });
  }
  return {
    type: 'icmpv6',
    icmpType: 'router-solicitation',
    code: 0,
    ndp: {
      ndpType: 'router-solicitation',
      options,
    },
  };
}

/**
 * Create a Router Advertisement packet.
 */
export function createRouterAdvertisement(
  prefixes: Array<{ prefix: IPv6Address; prefixLength: number; onLink?: boolean; autonomous?: boolean; validLifetime?: number; preferredLifetime?: number }>,
  sourceLinkLayerAddress: MACAddress,
  config: { curHopLimit?: number; managed?: boolean; other?: boolean; routerLifetime?: number; mtu?: number } = {},
): ICMPv6Packet {
  const options: NDPOption[] = [
    { optionType: 'source-link-layer', address: sourceLinkLayerAddress },
  ];

  for (const p of prefixes) {
    options.push({
      optionType: 'prefix-info',
      prefixLength: p.prefixLength,
      onLink: p.onLink ?? true,
      autonomous: p.autonomous ?? true,
      validLifetime: p.validLifetime ?? 2592000, // 30 days
      preferredLifetime: p.preferredLifetime ?? 604800, // 7 days
      prefix: p.prefix.getNetworkPrefix(p.prefixLength),
    });
  }

  if (config.mtu) {
    options.push({ optionType: 'mtu', mtu: config.mtu });
  }

  return {
    type: 'icmpv6',
    icmpType: 'router-advertisement',
    code: 0,
    ndp: {
      ndpType: 'router-advertisement',
      curHopLimit: config.curHopLimit ?? 64,
      managedFlag: config.managed ?? false,
      otherConfigFlag: config.other ?? false,
      routerLifetime: config.routerLifetime ?? 1800, // 30 minutes
      reachableTime: 0,
      retransTimer: 0,
      options,
    },
  };
}

// ─── RIP (RFC 2453) ─────────────────────────────────────────────────
//
// RIPv2 message format (RFC 2453 §4):
//   Command (1 byte): 1=Request, 2=Response
//   Version (1 byte): 2 for RIPv2
//   Zero (2 bytes)
//   Route entries (20 bytes each, up to 25 per message):
//     AFI (2 bytes): 2 = IP
//     Route tag (2 bytes)
//     IP Address (4 bytes)
//     Subnet Mask (4 bytes)
//     Next Hop (4 bytes)
//     Metric (4 bytes): 1-15 = reachable, 16 = infinity

export const RIP_METRIC_INFINITY = 16;
export const RIP_MAX_ENTRIES_PER_MESSAGE = 25;

export interface RIPRouteEntry {
  /** Address Family Identifier (2 = IPv4) */
  afi: number;
  /** Route tag for external route distinguishing */
  routeTag: number;
  /** IP address of the destination network */
  ipAddress: IPAddress;
  /** Subnet mask (RIPv2 only — RIPv1 uses classful) */
  subnetMask: SubnetMask;
  /** Next hop (0.0.0.0 = use sender as next-hop) */
  nextHop: IPAddress;
  /** Hop count metric (1-16, 16 = unreachable) */
  metric: number;
}

export interface RIPPacket {
  type: 'rip';
  /** 1 = Request, 2 = Response */
  command: 1 | 2;
  /** RIP version (2 for RIPv2) */
  version: number;
  /** Route entries (up to 25 per message) */
  entries: RIPRouteEntry[];
}

// ─── Device Types ────────────────────────────────────────────────────

export type DeviceType =
  // Computers
  | 'linux-pc'
  | 'windows-pc'
  | 'mac-pc'
  // Servers
  | 'linux-server'
  | 'windows-server'
  // Switches
  | 'switch-cisco'
  | 'switch-huawei'
  | 'switch-generic'
  // Routers
  | 'router-cisco'
  | 'router-huawei'
  // Firewalls
  | 'firewall-cisco'
  | 'firewall-fortinet'
  | 'firewall-paloalto'
  // Other
  | 'hub'
  | 'access-point'
  | 'cloud';

// ─── Device Categories (for UI palette) ──────────────────────────────

export interface DeviceCategory {
  id: string;
  name: string;
  devices: Array<{
    type: DeviceType;
    name: string;
    description: string;
  }>;
}

export const DEVICE_CATEGORIES: DeviceCategory[] = [
  {
    id: 'computers',
    name: 'Computers',
    devices: [
      { type: 'linux-pc', name: 'Linux PC', description: 'Ubuntu/Debian workstation' },
      { type: 'windows-pc', name: 'Windows PC', description: 'Windows 10/11 workstation' },
      { type: 'mac-pc', name: 'Mac', description: 'macOS workstation' },
    ],
  },
  {
    id: 'servers',
    name: 'Servers',
    devices: [
      { type: 'linux-server', name: 'Linux Server', description: 'Ubuntu/CentOS server' },
      { type: 'windows-server', name: 'Windows Server', description: 'Windows Server 2019/2022' },
    ],
  },
  {
    id: 'switches',
    name: 'Switches',
    devices: [
      { type: 'switch-cisco', name: 'Cisco Switch', description: 'Layer 2 switching device' },
      { type: 'switch-huawei', name: 'Huawei Switch', description: 'Layer 2 switching device' },
      { type: 'hub', name: 'Hub', description: 'Layer 1 repeater' },
    ],
  },
  {
    id: 'routers',
    name: 'Routers',
    devices: [
      { type: 'router-cisco', name: 'Cisco Router', description: 'Layer 3 routing device' },
      { type: 'router-huawei', name: 'Huawei Router', description: 'Layer 3 routing device' },
    ],
  },
  {
    id: 'security',
    name: 'Firewalls',
    devices: [
      { type: 'firewall-cisco', name: 'Cisco ASA', description: 'Cisco Adaptive Security Appliance' },
      { type: 'firewall-fortinet', name: 'FortiGate', description: 'Fortinet firewall' },
      { type: 'firewall-paloalto', name: 'Palo Alto', description: 'Palo Alto firewall' },
    ],
  },
];

export type ConnectionType = 'ethernet' | 'serial' | 'console' | 'fiber';

export type PortDuplex = 'full' | 'half';

export const VALID_PORT_SPEEDS = [10, 100, 1000, 10000, 25000, 40000, 100000] as const;
export type PortSpeed = typeof VALID_PORT_SPEEDS[number];

export interface PortCounters {
  framesIn: number;
  framesOut: number;
  bytesIn: number;
  bytesOut: number;
  errorsIn: number;
  errorsOut: number;
  dropsIn: number;
  dropsOut: number;
}

export interface PortInfo {
  name: string;
  type: ConnectionType;
  mac: MACAddress;
  ipAddress?: IPAddress;
  subnetMask?: SubnetMask;
  ipv6Enabled?: boolean;
  ipv6Addresses?: Array<{ address: IPv6Address; prefixLength: number; origin: string }>;
  isUp: boolean;
  speed?: PortSpeed;
  duplex?: PortDuplex;
  mtu?: number;
  counters?: PortCounters;
}

export type PortViolationMode = 'protect' | 'restrict' | 'shutdown';

// ─── Utility ─────────────────────────────────────────────────────────

let idCounter = 0;

export function generateId(): string {
  idCounter++;
  return `${Date.now()}-${idCounter.toString(36)}`;
}

export function resetCounters(): void {
  idCounter = 0;
  ipIdCounter = 0;
  MACAddress.resetCounter();
}
