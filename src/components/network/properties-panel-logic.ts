/**
 * Pure logic functions for the PropertiesPanel connection details.
 */

import { Connection, ConnectionType } from '@/domain/devices/types';

/**
 * Formats bandwidth in human-readable form.
 */
export function formatBandwidth(mbps: number): string {
  if (mbps === 0) return 'N/A';
  if (mbps >= 1000) return `${mbps / 1000} Gbps`;
  return `${mbps} Mbps`;
}

/**
 * Formats latency in human-readable form.
 */
export function formatLatency(ms: number): string {
  if (ms === 0) return '< 0.1 ms';
  return `${ms} ms`;
}

export interface ConnectionDetails {
  type: ConnectionType;
  typeLabel: string;
  bandwidth: string;
  latency: string;
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
 * Extracts display details from a Connection, reading from its
 * concrete instance when available.
 */
export function getConnectionDetails(connection: Connection): ConnectionDetails {
  const typeLabel = TYPE_LABELS[connection.type] || connection.type;

  let bandwidth = 'N/A';
  let latency = 'N/A';

  if (connection.instance) {
    const bw = connection.instance.getBandwidth();
    bandwidth = formatBandwidth(bw);
    const lat = connection.instance.getLatency();
    latency = formatLatency(lat);
  } else {
    // Fallback defaults based on type
    switch (connection.type) {
      case 'ethernet':
        bandwidth = '1 Gbps';
        latency = '0.1 ms';
        break;
      case 'serial':
        bandwidth = '1.544 Mbps';
        latency = '5 ms';
        break;
      case 'console':
        bandwidth = 'N/A';
        latency = 'N/A';
        break;
    }
  }

  return {
    type: connection.type,
    typeLabel,
    bandwidth,
    latency,
    sourceInterface: connection.sourceInterfaceId,
    targetInterface: connection.targetInterfaceId,
    isActive: connection.isActive
  };
}
