/**
 * Unified types for network devices
 * Combines network simulation and UI requirements
 */

import { DeviceType } from './BaseDevice';

/**
 * Network interface configuration (for UI)
 */
export interface NetworkInterfaceConfig {
  id: string;
  name: string;
  type: 'ethernet' | 'serial' | 'console';
  ipAddress?: string;
  subnetMask?: string;
  macAddress?: string;
  isUp?: boolean;
}

/**
 * Device configuration (for UI and factory)
 */
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

/**
 * Connection type
 */
export type ConnectionType = 'ethernet' | 'serial' | 'console';

/**
 * Connection between devices
 */
export interface Connection {
  id: string;
  type: ConnectionType;
  sourceDeviceId: string;
  sourceInterfaceId: string;
  targetDeviceId: string;
  targetInterfaceId: string;
  isActive: boolean;
}

/**
 * OS type for terminal emulation
 */
export type OSType = 'linux' | 'windows' | 'cisco-ios' | 'unknown';

// ID generation counters
let deviceCounter = 0;
let interfaceCounter = 0;

/**
 * Generates a unique ID
 */
export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Generates a device ID based on type
 */
export function generateDeviceId(type: DeviceType): string {
  deviceCounter++;
  return `${type}-${deviceCounter}`;
}

/**
 * Generates an interface name based on device type
 */
export function generateInterfaceName(type: DeviceType, index: number): string {
  interfaceCounter++;

  if (type.includes('cisco')) {
    return type.includes('switch')
      ? `GigabitEthernet0/${index}`
      : `FastEthernet0/${index}`;
  }

  return `eth${index}`;
}

/**
 * Resets device counters (for testing)
 */
export function resetDeviceCounters(): void {
  deviceCounter = 0;
  interfaceCounter = 0;
}

/**
 * Device category for UI palette
 */
export interface DeviceCategory {
  id: string;
  name: string;
  devices: Array<{
    type: DeviceType;
    name: string;
    description: string;
  }>;
}

/**
 * Device categories for UI palette
 */
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
      },
      {
        type: 'hub',
        name: 'Hub',
        description: 'Layer 1 repeater'
      }
    ]
  }
];
