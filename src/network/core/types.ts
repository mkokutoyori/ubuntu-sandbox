/**
 * Core network types - No binary serialization, no Buffer dependency
 *
 * All data structures are plain objects for simplicity and browser compatibility.
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
    // Accept formats: AA:BB:CC:DD:EE:FF or AA-BB-CC-DD-EE-FF
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

  /**
   * Check if this IP is in the same subnet as another IP given a mask
   */
  isInSameSubnet(other: IPAddress, mask: SubnetMask): boolean {
    const maskOctets = mask.getOctets();
    for (let i = 0; i < 4; i++) {
      if ((this.octets[i] & maskOctets[i]) !== (other.octets[i] & maskOctets[i])) {
        return false;
      }
    }
    return true;
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

// ─── Ethernet Frame (plain object, no binary) ───────────────────────

export const ETHERTYPE_ARP = 0x0806;
export const ETHERTYPE_IPV4 = 0x0800;

export interface EthernetFrame {
  srcMAC: MACAddress;
  dstMAC: MACAddress;
  etherType: number;
  payload: ARPPacket | ICMPPacket | unknown;
}

// ─── ARP ─────────────────────────────────────────────────────────────

export type ARPOperation = 'request' | 'reply';

export interface ARPPacket {
  type: 'arp';
  operation: ARPOperation;
  senderMAC: MACAddress;
  senderIP: IPAddress;
  targetMAC: MACAddress;
  targetIP: IPAddress;
}

// ─── ICMP ────────────────────────────────────────────────────────────

export type ICMPType = 'echo-request' | 'echo-reply' | 'destination-unreachable' | 'time-exceeded';

export interface ICMPPacket {
  type: 'icmp';
  icmpType: ICMPType;
  id: number;
  sequence: number;
  sourceIP: IPAddress;
  destinationIP: IPAddress;
  ttl: number;
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
  MACAddress.resetCounter();
}
