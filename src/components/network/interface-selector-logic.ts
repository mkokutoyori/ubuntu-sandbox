/**
 * Pure logic functions for the InterfaceSelectorPopover.
 * Builds structured interface lists with availability and grouping.
 */

import type { ConnectionType } from '@/network';
import type { Connection, NetworkInterfaceConfig } from '@/store/networkStore';

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
  unavailableBecause: 'virtual' | 'cabled' | null;
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
    const connAsSource = connections.find(
      c => c.sourceDeviceId === deviceId && c.sourceInterfaceId === iface.id
    );
    const connAsTarget = connections.find(
      c => c.targetDeviceId === deviceId && c.targetInterfaceId === iface.id
    );
    const conn = connAsSource || connAsTarget;
    const isConnected = !!conn;

    let connectedTo: InterfaceListItem['connectedTo'];
    if (connAsSource) {
      connectedTo = { deviceId: connAsSource.targetDeviceId, interfaceId: connAsSource.targetInterfaceId };
    } else if (connAsTarget) {
      connectedTo = { deviceId: connAsTarget.sourceDeviceId, interfaceId: connAsTarget.sourceInterfaceId };
    }

    const typeMatches = !filterType || iface.type === filterType;
    const isAvailable = iface.acceptsCable && !isConnected && typeMatches;
    const unavailableBecause = !iface.hasSocket ? 'virtual' as const
      : iface.acceptsCable ? null
      : 'cabled' as const;

    return {
      id: iface.id,
      name: iface.name,
      type: iface.type,
      ipAddress: iface.ipAddress,
      macAddress: iface.macAddress,
      isConnected,
      isAvailable,
      unavailableBecause,
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
