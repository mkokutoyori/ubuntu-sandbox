/**
 * STUB FILE - Types for UI compatibility
 * This file contains minimal type definitions to keep the UI functional
 * Real implementation will be rebuilt with TDD
 */

export type DeviceType =
  | 'linux-pc'
  | 'windows-pc'
  | 'cisco-router'
  | 'cisco-switch'
  | 'cisco-l3-switch';

export interface NetworkInterfaceConfig {
  id: string;
  name: string;
  type: 'ethernet' | 'serial' | 'console';
  ipAddress?: string;
  subnetMask?: string;
  macAddress?: string;
  isUp?: boolean;
}

export interface DeviceConfig {
  id?: string;
  type: DeviceType;
  name?: string;
  hostname?: string;
  x?: number;
  y?: number;
  interfaces?: NetworkInterfaceConfig[];
  isPoweredOn?: boolean;
}

export type ConnectionType = 'ethernet' | 'serial' | 'console';

export interface Connection {
  id: string;
  type: ConnectionType;
  sourceDeviceId: string;
  sourceInterfaceId: string;
  targetDeviceId: string;
  targetInterfaceId: string;
  isActive: boolean;
}

let deviceCounter = 0;
let interfaceCounter = 0;

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function generateDeviceId(type: DeviceType): string {
  deviceCounter++;
  return `${type}-${deviceCounter}`;
}

export function generateInterfaceName(type: DeviceType, index: number): string {
  interfaceCounter++;
  if (type.includes('cisco')) {
    return type.includes('switch')
      ? `GigabitEthernet0/${index}`
      : `FastEthernet0/${index}`;
  }
  return `eth${index}`;
}

export function resetDeviceCounters(): void {
  deviceCounter = 0;
  interfaceCounter = 0;
}

// Device categories for UI palette
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
      {
        type: 'linux-pc',
        name: 'Linux PC',
        description: 'Ubuntu/Debian workstation'
      },
      {
        type: 'windows-pc',
        name: 'Windows PC',
        description: 'Windows 10/11 workstation'
      }
    ]
  },
  {
    id: 'network',
    name: 'Network Devices',
    devices: [
      {
        type: 'cisco-router',
        name: 'Cisco Router',
        description: 'Layer 3 routing device'
      },
      {
        type: 'cisco-switch',
        name: 'Cisco Switch',
        description: 'Layer 2 switching device'
      },
      {
        type: 'cisco-l3-switch',
        name: 'Cisco L3 Switch',
        description: 'Layer 3 switching device'
      }
    ]
  }
];
