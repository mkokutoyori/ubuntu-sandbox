/**
 * Core network types - RFC-compliant protocol structures
 *
 * Encapsulation hierarchy (OSI):
 *   L2: EthernetFrame { srcMAC, dstMAC, etherType, payload }
 *   L3: IPv4Packet    { version, ihl, ttl, protocol, srcIP, dstIP, payload }
 *   L4: ICMPPacket / TCP / UDP (future)
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

// ─── IP Address ──────────────────────────────────────────────────────

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

// ─── L2: Ethernet Frame ─────────────────────────────────────────────

export const ETHERTYPE_ARP  = 0x0806;
export const ETHERTYPE_IPV4 = 0x0800;

export interface EthernetFrame {
  srcMAC: MACAddress;
  dstMAC: MACAddress;
  etherType: number;
  payload: ARPPacket | IPv4Packet | unknown;
}

// ─── L3: IPv4 Packet (RFC 791) ──────────────────────────────────────

/** IPv4 protocol numbers */
export const IP_PROTO_ICMP = 1;
export const IP_PROTO_TCP  = 6;
export const IP_PROTO_UDP  = 17;

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
  /** Upper-layer payload (ICMP, TCP segment, UDP datagram, etc.). */
  payload: ICMPPacket | unknown;
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
  payload: ICMPPacket | unknown,
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

export interface PortInfo {
  name: string;
  type: ConnectionType;
  mac: MACAddress;
  ipAddress?: IPAddress;
  subnetMask?: SubnetMask;
  isUp: boolean;
}

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
