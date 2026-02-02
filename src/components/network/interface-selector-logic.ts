/**
 * Pure logic functions for the InterfaceSelectorPopover.
 * Builds structured interface lists with availability and grouping.
 */

import { Connection, ConnectionType, NetworkInterfaceConfig } from '@/domain/devices/types';

/**
 * Represents one item in the interface selector list.
 */
export interface InterfaceListItem {
  id: string;
  name: string;
  type: string;
  ipAddress?: string;
  macAddress?: string;
  isConnected: boolean;
  isAvailable: boolean;
  connectedTo?: {
    deviceId: string;
    interfaceId: string;
  };
}

/**
 * Builds a full list of interfaces for a device, annotated with
 * connected/available status. Optionally filters availability by connection type.
 */
export function buildInterfaceList(
  deviceId: string,
  interfaces: NetworkInterfaceConfig[],
  connections: Connection[],
  filterType?: ConnectionType
): InterfaceListItem[] {
  return interfaces.map(iface => {
    // Find if this interface is used in any connection
    const connAsSource = connections.find(
      c => c.sourceDeviceId === deviceId && c.sourceInterfaceId === iface.id
    );
    const connAsTarget = connections.find(
      c => c.targetDeviceId === deviceId && c.targetInterfaceId === iface.id
    );
    const conn = connAsSource || connAsTarget;
    const isConnected = !!conn;

    // Determine connected peer
    let connectedTo: InterfaceListItem['connectedTo'];
    if (connAsSource) {
      connectedTo = { deviceId: connAsSource.targetDeviceId, interfaceId: connAsSource.targetInterfaceId };
    } else if (connAsTarget) {
      connectedTo = { deviceId: connAsTarget.sourceDeviceId, interfaceId: connAsTarget.sourceInterfaceId };
    }

    // Available if: not connected AND (no filter OR type matches filter)
    const typeMatches = !filterType || iface.type === filterType;
    const isAvailable = !isConnected && typeMatches;

    return {
      id: iface.id,
      name: iface.name,
      type: iface.type,
      ipAddress: iface.ipAddress,
      macAddress: iface.macAddress,
      isConnected,
      isAvailable,
      connectedTo
    };
  });
}

/**
 * Groups interface list items by their type.
 */
export function groupInterfacesByType(
  items: InterfaceListItem[]
): Record<string, InterfaceListItem[]> {
  const groups: Record<string, InterfaceListItem[]> = {};

  for (const item of items) {
    if (!groups[item.type]) {
      groups[item.type] = [];
    }
    groups[item.type].push(item);
  }

  return groups;
}
