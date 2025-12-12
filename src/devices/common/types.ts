/**
 * Common Device Types - Base interfaces for all network devices
 */

export type DeviceOSType =
  | 'linux'
  | 'windows'
  | 'cisco-ios'
  | 'huawei-vrp'
  | 'fortios'
  | 'panos';

export interface NetworkInterfaceConfig {
  id: string;
  name: string;
  type: 'ethernet' | 'wifi' | 'fiber' | 'serial' | 'loopback';
  macAddress: string;
  ipAddress?: string;
  subnetMask?: string;
  gateway?: string;
  vlan?: number;
  isUp: boolean;
  speed: string;
  duplex: 'full' | 'half' | 'auto';
  // Pour les switches
  portMode?: 'access' | 'trunk';
  nativeVlan?: number;
  allowedVlans?: number[];
}

export interface DeviceConfig {
  id: string;
  name: string;
  hostname: string;
  osType: DeviceOSType;
  interfaces: NetworkInterfaceConfig[];
  isPoweredOn: boolean;
}

export interface CommandResult {
  output: string;
  error?: string;
  exitCode: number;
  newPrompt?: string;
}

export interface ARPEntry {
  ipAddress: string;
  macAddress: string;
  interface: string;
  type: 'static' | 'dynamic';
  age: number; // seconds
}

export interface RouteEntry {
  destination: string;
  netmask: string;
  gateway: string;
  interface: string;
  metric: number;
  protocol: 'connected' | 'static' | 'rip' | 'ospf' | 'eigrp';
}

export interface MACTableEntry {
  macAddress: string;
  vlan: number;
  interface: string;
  type: 'static' | 'dynamic';
  age: number;
}

// Callback pour envoyer des paquets
export type PacketSender = (packet: import('../../core/network/packet').Packet, interfaceId: string) => void;
