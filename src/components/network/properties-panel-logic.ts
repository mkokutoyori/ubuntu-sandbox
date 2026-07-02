/**
 * Pure logic functions for the PropertiesPanel connection details.
 */

import type { ConnectionType } from '@/network';
import { isConnectionActive, type Connection } from '@/store/networkStore';

export interface ConnectionDetails {
  type: ConnectionType;
  typeLabel: string;
  sourceInterface: string;
  targetInterface: string;
  isActive: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  ethernet: 'Ethernet',
  serial: 'Serial',
  console: 'Console'
};

// Bandwidth / latency live in useConnectionPerf (subscribed to port.config events).
export function getConnectionDetails(connection: Connection): ConnectionDetails {
  return {
    type: connection.type,
    typeLabel: TYPE_LABELS[connection.type] || connection.type,
    sourceInterface: connection.sourceInterfaceId,
    targetInterface: connection.targetInterfaceId,
    isActive: isConnectionActive(connection)
  };
}
