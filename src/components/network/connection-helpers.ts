/**
 * Pure helper functions for connection management on the GUI.
 * Extracted from components for testability.
 */

import type { ConnectionType } from '@/network';
import type { Connection, NetworkInterfaceConfig } from '@/store/networkStore';

/**
 * Returns interfaces on a device that are not yet connected,
 * optionally filtered by connection type.
 */
export function getAvailableInterfaces(
  deviceId: string,
  interfaces: NetworkInterfaceConfig[],
  connections: Connection[],
  connectionType?: ConnectionType
): NetworkInterfaceConfig[] {
  const connectedIds = new Set<string>();

  for (const c of connections) {
    if (c.sourceDeviceId === deviceId) connectedIds.add(c.sourceInterfaceId);
    if (c.targetDeviceId === deviceId) connectedIds.add(c.targetInterfaceId);
  }

  return interfaces.filter(iface => {
    if (connectedIds.has(iface.id)) return false;
    if (connectionType && iface.type !== connectionType) return false;
    return true;
  });
}

/**
 * Determines which connection types are possible between two sets of interfaces.
 * A type is compatible if both sides have at least one free interface of that type.
 */
export function getCompatibleConnectionTypes(
  sourceInterfaces: NetworkInterfaceConfig[],
  targetInterfaces: NetworkInterfaceConfig[]
): ConnectionType[] {
  const sourceTypes = new Set(sourceInterfaces.map(i => i.type));
  const targetTypes = new Set(targetInterfaces.map(i => i.type));

  const types: ConnectionType[] = [];
  for (const t of sourceTypes) {
    if (targetTypes.has(t)) {
      types.push(t as ConnectionType);
    }
  }

  return types;
}

/**
 * Returns a human-readable label for a connection type.
 */
export function getConnectionLabel(type: ConnectionType): string {
  switch (type) {
    case 'ethernet': return 'Ethernet';
    case 'serial': return 'Serial';
    case 'console': return 'Console';
    default: return String(type);
  }
}

/**
 * Display info for an interface in the selector popup.
 */
export interface InterfaceDisplayInfo {
  name: string;
  type: string;
  ipAddress?: string;
  macAddress?: string;
  isConnected: boolean;
  isAvailable: boolean;
}

/**
 * Returns formatted display information for an interface.
 */
export function getInterfaceDisplayInfo(
  iface: NetworkInterfaceConfig,
  isConnected: boolean
): InterfaceDisplayInfo {
  return {
    name: iface.name,
    type: iface.type,
    ipAddress: iface.ipAddress,
    macAddress: iface.macAddress,
    isConnected,
    isAvailable: !isConnected
  };
}

/**
 * Returns the interface name at a given endpoint of a connection.
 */
export function getConnectionEndpointLabel(
  connection: Connection,
  endpoint: 'source' | 'target'
): string {
  return endpoint === 'source'
    ? connection.sourceInterfaceId
    : connection.targetInterfaceId;
}
