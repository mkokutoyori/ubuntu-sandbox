/**
 * Packet - Network packet structures for simulation
 */

// Ethernet Frame (Layer 2)
export interface EthernetFrame {
  destinationMAC: string;
  sourceMAC: string;
  etherType: number; // 0x0800 = IPv4, 0x0806 = ARP
  vlanTag?: {
    tpid: number;     // 0x8100
    pcp: number;      // Priority
    dei: number;      // Drop eligible
    vid: number;      // VLAN ID
  };
  payload: Uint8Array | IPv4Packet | ARPPacket;
}

// ARP Packet
export interface ARPPacket {
  hardwareType: number;      // 1 = Ethernet
  protocolType: number;      // 0x0800 = IPv4
  hardwareSize: number;      // 6 for MAC
  protocolSize: number;      // 4 for IPv4
  opcode: ARPOpcode;
  senderMAC: string;
  senderIP: string;
  targetMAC: string;
  targetIP: string;
}

export enum ARPOpcode {
  REQUEST = 1,
  REPLY = 2
}

// IPv4 Packet (Layer 3)
export interface IPv4Packet {
  version: 4;
  headerLength: number;
  dscp: number;
  totalLength: number;
  identification: number;
  flags: number;
  fragmentOffset: number;
  ttl: number;
  protocol: number;    // 1=ICMP, 6=TCP, 17=UDP
  headerChecksum: number;
  sourceIP: string;
  destinationIP: string;
  options?: Uint8Array;
  payload: Uint8Array | ICMPPacket | TCPSegment | UDPDatagram;
}

// ICMP Packet
export interface ICMPPacket {
  type: ICMPType;
  code: number;
  checksum: number;
  identifier: number;
  sequenceNumber: number;
  data: Uint8Array;
}

export enum ICMPType {
  ECHO_REPLY = 0,
  DESTINATION_UNREACHABLE = 3,
  ECHO_REQUEST = 8,
  TIME_EXCEEDED = 11,
  REDIRECT = 5
}

// TCP Segment (Layer 4)
export interface TCPSegment {
  sourcePort: number;
  destinationPort: number;
  sequenceNumber: number;
  acknowledgmentNumber: number;
  dataOffset: number;
  flags: {
    urg: boolean;
    ack: boolean;
    psh: boolean;
    rst: boolean;
    syn: boolean;
    fin: boolean;
  };
  windowSize: number;
  checksum: number;
  urgentPointer: number;
  payload: Uint8Array;
}

// UDP Datagram
export interface UDPDatagram {
  sourcePort: number;
  destinationPort: number;
  length: number;
  checksum: number;
  payload: Uint8Array;
}

// Generic Packet type for simulation
export type Packet = {
  id: string;
  timestamp: number;
  frame: EthernetFrame;
  sourceDeviceId?: string;
  destinationDeviceId?: string;
  hops: string[];       // List of device IDs the packet passed through
  status: 'in_transit' | 'delivered' | 'dropped' | 'timeout';
  dropReason?: string;
};

// Helper functions
export function generatePacketId(): string {
  return `pkt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export function createARPRequest(
  senderMAC: string,
  senderIP: string,
  targetIP: string
): ARPPacket {
  return {
    hardwareType: 1,
    protocolType: 0x0800,
    hardwareSize: 6,
    protocolSize: 4,
    opcode: ARPOpcode.REQUEST,
    senderMAC,
    senderIP,
    targetMAC: '00:00:00:00:00:00',
    targetIP
  };
}

export function createARPReply(
  senderMAC: string,
  senderIP: string,
  targetMAC: string,
  targetIP: string
): ARPPacket {
  return {
    hardwareType: 1,
    protocolType: 0x0800,
    hardwareSize: 6,
    protocolSize: 4,
    opcode: ARPOpcode.REPLY,
    senderMAC,
    senderIP,
    targetMAC,
    targetIP
  };
}

export function createICMPEchoRequest(
  identifier: number,
  sequenceNumber: number,
  data?: Uint8Array
): ICMPPacket {
  return {
    type: ICMPType.ECHO_REQUEST,
    code: 0,
    checksum: 0, // Will be calculated
    identifier,
    sequenceNumber,
    data: data || new Uint8Array(32).fill(0x61) // 'a' characters
  };
}

export function createICMPEchoReply(request: ICMPPacket): ICMPPacket {
  return {
    type: ICMPType.ECHO_REPLY,
    code: 0,
    checksum: 0,
    identifier: request.identifier,
    sequenceNumber: request.sequenceNumber,
    data: request.data
  };
}

// Constants
export const ETHER_TYPE = {
  IPv4: 0x0800,
  ARP: 0x0806,
  IPv6: 0x86DD,
  VLAN: 0x8100
};

export const IP_PROTOCOL = {
  ICMP: 1,
  TCP: 6,
  UDP: 17
};

export const BROADCAST_MAC = 'FF:FF:FF:FF:FF:FF';
