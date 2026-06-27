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

/**
 * Extracts the static, instance-independent display details for a
 * Connection. Bandwidth / latency are intentionally NOT here — they
 * come from the live Ports via `useConnectionPerf` (which subscribes
 * to `port.config.speed-changed` etc.) so the panel reflects the
 * actual link rather than canned per-type constants.
 */
export function getConnectionDetails(connection: Connection): ConnectionDetails {
  return {
    type: connection.type,
    typeLabel: TYPE_LABELS[connection.type] || connection.type,
    sourceInterface: connection.sourceInterfaceId,
    targetInterface: connection.targetInterfaceId,
    isActive: isConnectionActive(connection)
  };
}
